/**
 * ModelGatewayStore —— 模型条目的唯一真源（配置 + 连通状态 + 启停）。
 *
 * 持久化分两层：
 * - **配置**走既有 custom provider 存储（`create/update/deleteCustomProvider` → localDb +
 *   keychain），本 store 不写任何文件；`~/.hrbuddy/models.json` 镜像是 main 侧（Task 5）的
 *   职责。密钥经 `keys: { 'claude-code': apiKey }` 直接提交给 IPC，**不进 React state**。
 * - **`enabled` / `status` / `lastTestedAt`**（Ruling 5）持久化在 renderer 侧 localStorage，
 *   key `hrbuddy.modelGatewayMeta`，按稳定条目 id 索引的 JSON blob。provider 配置的
 *   normalize 会剥掉未知字段，这三个进不了 config；缺省（缺 key）为 `enabled: true`、
 *   `status: 'untested'`。重启后开关与最近一次测试结果都保留。
 *
 * id 语义（Ruling 4）：`ModelEntry.id` 是**稳定句柄**（= 自定义供应商 id），编辑 modelId
 * 不换 id——Task 3 编辑流与 Task 6 当前模型指针钉在它上面；`modelId` 才是发给网关的
 * 上游模型 id。`entries` 保持**插入序**（加载顺序 = listProviders 返回序，add 追加
 * 末尾）——PRD 推翻旧的 modelId 字母序。
 *
 * 删除语义（PRD）：`remove(id)` 立即从 `entries` 摘除、软摘除新表单标记
 * （`updateCustomProvider` 去掉 catalogPresetId，密钥不动）并返回 `UndoHandle`；
 * **真正的 `deleteCustomProvider`（含 keychain 密钥）延迟 5000ms**，`undo()` 取消
 * 定时器、按原索引插回并补回标记。组件卸载时对未决删除 flush（尽力而为）。
 * **5 秒内强杀进程会残留配置**：摘了标记的供应商与密钥成孤儿留在 localDb /
 * keychain——store 只收新表单标记的条目，残留不会复活到列表；孤儿配置不自动清理。
 *
 * 每条模型条目对应一个 custom provider：单 claude-code runtime、单模型、协议写死
 * `anthropic-messages`。创建时在 runtime 配置上写新表单标记 `catalogPresetId: 'hrbuddy-gateway'`，
 * 加载时只把带标记的条目暴露进 `entries`——旧表单配置留在 localDb 但新列表看不见
 * （清空重来，设计稿 §6.5）。
 *
 * **已知限制（Ruling 21，v1）——多窗口并发编辑不做同步**：
 * - 现象：`persistMeta` / `pushMirror` 都是**整份快照重写**（localStorage blob 与
 *   `~/.hrbuddy/models.json` 整组替换），`currentModelStore` 的全局当前模型又只在
 *   模块加载时读一次 localStorage——两个窗口同时编辑时 last-writer-wins，互相覆盖。
 * - 影响面：另一窗口刚写的 `enabled` / `status` / `lastTestedAt` 会被旧快照抹掉；
 *   镜像里对方新增/删除的行随整组替换消失；两个窗口的「当前模型」各自为政。
 * - 恢复方式：被抹掉的启停/连通状态**重开开关或重测**即可重建；镜像在下次任一变更
 *   时整组重推；当前模型**重开窗口或在菜单里重选**即回到持久值。均不丢凭证
 *   （密钥只在 keychain）与 provider 配置本体（配置走 custom provider 存储）。
 * - 跟进：读-合并-写 / 实例同步属独立改造面，挂账不在本轮（本文件头注即台账）。
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  storedCustomProviderId,
  type CustomProviderConfig,
  type ProviderView,
} from '@cindy/model-providers';

import {
  createCustomProvider,
  deleteCustomProvider,
  readCustomProviderKey,
  updateCustomProvider,
} from '@/lib/customProviders';
import { uniqueCustomProviderId } from '@/lib/customProviderId';

import type {
  ModelEntry,
  ModelGatewayApi,
  ModelGatewayInput,
  ModelStatus,
  UndoHandle,
} from './types';

/** 新表单标记：写在 `runtimes['claude-code'].catalogPresetId`，加载时据此过滤。 */
export const MODEL_GATEWAY_CATALOG_PRESET_ID = 'hrbuddy-gateway';

/** `enabled` / `status` / `lastTestedAt` 的 localStorage key（Ruling 5 指定的字面量）。 */
export const MODEL_GATEWAY_META_STORAGE_KEY = 'hrbuddy.modelGatewayMeta';

/**
 * main 侧 `custom-provider-store.ts` 的 `RESERVED_IDS`（内置来源 id，撞名会被 create 校验拒绝）。
 * 生成稳定句柄时避开；名单以 main 侧为正本，此处仅镜像生成期规避。
 */
const RESERVED_PROVIDER_IDS = new Set(['anthropic', 'openai', 'xai', 'xd', 'cindy']);

/** 每条目持久化的启停 / 连通状态元数据（配置层放不下的三份字段）。 */
interface ModelEntryMeta {
  enabled: boolean;
  status: ModelStatus;
  lastTestedAt?: string;
}

type ModelGatewayMeta = Record<string, ModelEntryMeta>;

/** 删除撤销窗口内的未决删除记录（表驱动 pendingDeletes 的行）。 */
interface PendingDelete {
  entry: ModelEntry;
  index: number;
  timer: ReturnType<typeof setTimeout>;
  done: boolean;
}

function readMeta(): ModelGatewayMeta {
  try {
    const raw = window.localStorage.getItem(MODEL_GATEWAY_META_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as ModelGatewayMeta;
  } catch {
    // 损坏的 blob / 隐私模式禁用 localStorage：降级为缺省元数据。
    return {};
  }
}

function writeMeta(meta: ModelGatewayMeta): void {
  try {
    window.localStorage.setItem(MODEL_GATEWAY_META_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // 配额满 / localStorage 不可用：行为退化为会话内状态，不阻塞变更。
  }
}

/** 读某条目的元数据；缺 key 时给缺省（Ruling 5：`enabled: true`、`status: 'untested'`）。 */
function metaFor(meta: ModelGatewayMeta, id: string): ModelEntryMeta {
  const record = meta[id];
  return {
    enabled: record?.enabled ?? true,
    status: record?.status ?? 'untested',
    ...(record?.lastTestedAt ? { lastTestedAt: record.lastTestedAt } : {}),
  };
}

/**
 * ModelEntry → `~/.hrbuddy/models.json` 镜像行（Ruling 2/17 的推送载荷）。
 * **逐字段拷贝，绝不 spread 条目/输入**——`apiKey` 只存在于 `ModelGatewayInput`，
 * 任何路径都不得进入镜像（Review Focus #1）。
 *
 * Ruling 17：镜像是 store 的 1:1 投影（`exportModels` 整组替换），`id` 取**稳定句柄**
 * （= `entry.id`，与 ModelEntry.id 一致）、另带 `modelId` 承载上游模型 id——行身份
 * 唯一，同 modelId 多条目并存、删除/改名即消失，不再有合并残留。
 */
function mirrorRowFromEntry(entry: ModelEntry): {
  id: string;
  modelId: string;
  name: string;
  provider: string;
  baseUrl: string;
  wireProtocol: string;
  enabled: boolean;
  status: ModelStatus;
  lastTestedAt?: string;
} {
  return {
    id: entry.id,
    modelId: entry.modelId,
    name: entry.name,
    provider: entry.name,
    baseUrl: entry.baseUrl,
    wireProtocol: 'anthropic-messages',
    enabled: entry.enabled,
    status: entry.status,
    ...(entry.lastTestedAt ? { lastTestedAt: entry.lastTestedAt } : {}),
  };
}

/**
 * 删除撤销窗口（PRD：「删除」后 5 秒内可撤销）。窗口内只软摘标记，真正的
 * `deleteCustomProvider`（含 keychain 密钥）到点才落。
 */
const REMOVE_UNDO_WINDOW_MS = 5000;

/**
 * 网关条目的 provider 配置。`marked: false` 时**不带**新表单标记——删除撤销窗口内
 * 软摘除用（加载侧「只收带标记条目」→ 残留配置不会复活到列表）。
 */
function buildModelGatewayConfig(
  providerId: string,
  modelId: string,
  baseUrl: string,
  marked: boolean = true,
): CustomProviderConfig {
  return {
    id: providerId,
    name: modelId,
    runtimes: {
      'claude-code': {
        baseUrl,
        wireProtocol: 'anthropic-messages',
        ...(marked ? { catalogPresetId: MODEL_GATEWAY_CATALOG_PRESET_ID } : {}),
        models: [{ id: modelId, name: modelId }],
      },
    },
  };
}

/** 新条目：稳定句柄 = provider id，字段给缺省元数据（不继承历史 meta）。 */
function entryFromNew(providerId: string, input: ModelGatewayInput): ModelEntry {
  return {
    id: providerId,
    modelId: input.modelId,
    name: input.modelId,
    baseUrl: input.baseUrl,
    enabled: true,
    status: 'untested',
  };
}

/**
 * 网关条目身份判定：custom provider 上带新表单标记的 claude-code 单模型条目。
 * 与 `entryFromProviderView` 的收录条件同源——设置左栏等处据此识别「这是网关条目」。
 */
export function isModelGatewayProvider(provider: ProviderView): boolean {
  if (provider.source !== 'user' || provider.removed) return false;
  return provider.models['claude-code']?.[0]?.catalogPresetId === MODEL_GATEWAY_CATALOG_PRESET_ID;
}

function entryFromProviderView(provider: ProviderView, meta: ModelGatewayMeta): ModelEntry | null {
  const model = provider.models['claude-code']?.[0];
  if (!isModelGatewayProvider(provider) || !model) return null;
  const id = storedCustomProviderId(provider.id);
  return {
    id,
    modelId: model.id,
    name: model.name || model.id,
    baseUrl: provider.routing['claude-code']?.upstream ?? '',
    ...metaFor(meta, id),
  };
}

function useModelGatewayStore(): ModelGatewayApi {
  const [rows, setRowsState] = useState<ModelEntry[]>([]);
  // 首次 listProviders 落定前 entries 的 [] 只是「还没读到」（review Important 1）：
  // 当前模型的回落 / 写回必须等 hydrate，否则重启 / remount 会把已持久化的当前模型抹掉。
  const [hydrated, setHydrated] = useState(false);
  // 同步读最新行（update/remove/setStatus 要先拿稳定 id 再发 IPC；persistMeta 也从这重建）。
  const rowsRef = useRef<ModelEntry[]>([]);
  // 删除撤销窗口内的未决删除表（id → 原条目 / 原索引 / 定时器）。
  const pendingDeletesRef = useRef(new Map<string, PendingDelete>());
  // 生成新稳定句柄时避开全部自定义供应商（含旧表单隐藏项）的已用 id。
  const knownProviderIdsRef = useRef<Set<string>>(new Set());
  const loadRef = useRef<Promise<void> | null>(null);

  const setRows = useCallback((updater: (prev: ModelEntry[]) => ModelEntry[]) => {
    rowsRef.current = updater(rowsRef.current);
    setRowsState(rowsRef.current);
  }, []);

  /** 把当前各行的元数据整份快照写回 localStorage（删除的条目随快照自然消失）。 */
  const persistMeta = useCallback(() => {
    const meta: ModelGatewayMeta = {};
    for (const entry of rowsRef.current) {
      meta[entry.id] = {
        enabled: entry.enabled,
        status: entry.status,
        ...(entry.lastTestedAt ? { lastTestedAt: entry.lastTestedAt } : {}),
      };
    }
    writeMeta(meta);
  }, []);

  /**
   * 把当前全量行推给 main 写 `~/.hrbuddy/models.json` 镜像（Ruling 2）。
   * 载荷经 `mirrorRowFromEntry` 逐字段组装，不含密钥；fire-and-forget——镜像是
   * 便利产物，推送失败不阻断增删改/开关（与 main 侧 warn-not-throws 同口径）。
   */
  const pushMirror = useCallback(() => {
    const payload = rowsRef.current.map(mirrorRowFromEntry);
    try {
      Promise.resolve(window.electronAPI.maker.exportHrbuddyModels(payload)).catch(() => {
        // 镜像写盘失败只告警（main 侧已 warn），这里不向上抛。
      });
    } catch {
      // 同步失败（如桥接未就绪）同样不阻断变更。
    }
  }, []);

  const ensureLoaded = useCallback((): Promise<void> => {
    loadRef.current ??= window.electronAPI.maker.listProviders().then(({ providers }) => {
      knownProviderIdsRef.current = new Set(
        providers
          .filter((provider) => provider.source === 'user' && !provider.removed)
          .map((provider) => storedCustomProviderId(provider.id)),
      );
      const meta = readMeta();
      setRows(() =>
        providers
          .map((provider) => entryFromProviderView(provider, meta))
          .filter((entry): entry is ModelEntry => entry !== null),
      );
      setHydrated(true);
    });
    return loadRef.current;
  }, [setRows]);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  // 卸载即 flush 未决删除（尽力而为）：不等 5s 窗口，直接落 deleteCustomProvider。
  // 进程被强杀时这段不执行——残留语义见文件头注。
  useEffect(
    () => () => {
      for (const [id, record] of pendingDeletesRef.current) {
        if (record.done) continue;
        record.done = true;
        clearTimeout(record.timer);
        void deleteCustomProvider(id).catch(() => {
          // 卸载路径 best-effort：删不掉不阻断，孤儿配置同样「不复活到列表」。
        });
      }
      pendingDeletesRef.current.clear();
    },
    [],
  );

  const findEntry = useCallback(
    (id: string): ModelEntry => {
      const entry = rowsRef.current.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`model gateway entry '${id}' not found`);
      return entry;
    },
    [],
  );

  const add = useCallback(
    async (input: ModelGatewayInput): Promise<string> => {
      await ensureLoaded();
      // 稳定句柄从 model id 派生、撞名递增后缀；保留名（anthropic/openai/…）直接跳过，
      // 否则 createCustomProvider 的校验会拒。
      const providerId = uniqueCustomProviderId(input.modelId, new Set([
        ...RESERVED_PROVIDER_IDS,
        ...knownProviderIdsRef.current,
      ]));
      await createCustomProvider(
        buildModelGatewayConfig(providerId, input.modelId, input.baseUrl),
        { 'claude-code': input.apiKey },
      );
      knownProviderIdsRef.current.add(providerId);
      setRows((prev) => [...prev, entryFromNew(providerId, input)]);
      persistMeta();
      pushMirror();
      return providerId;
    },
    [ensureLoaded, persistMeta, pushMirror, setRows],
  );

  const update = useCallback(
    async (id: string, input: ModelGatewayInput): Promise<void> => {
      await ensureLoaded();
      const entry = findEntry(id);
      // PRD：baseUrl / modelId / 密钥任一变化 → 旧探测结果作废（status 回 untested），
      // 全都没变则保留。密钥不进 state，与 keychain 现值核对（读不到按「有变化」处理，
      // 宁可重测也不留陈旧「已连通」）。
      const endpointChanged = input.baseUrl !== entry.baseUrl || input.modelId !== entry.modelId;
      let fieldsChanged = endpointChanged;
      if (!endpointChanged) {
        let previousKey: string | null = null;
        try {
          previousKey = await readCustomProviderKey(entry.id, 'claude-code');
        } catch {
          previousKey = null;
        }
        fieldsChanged = input.apiKey !== (previousKey ?? '');
      }
      await updateCustomProvider(
        buildModelGatewayConfig(entry.id, input.modelId, input.baseUrl),
        { 'claude-code': input.apiKey },
      );
      // 稳定 id 不动，只写穿 baseUrl / modelId / 密钥；enabled 按 id 挂在 meta 上不重置。
      setRows((prev) =>
        prev.map((candidate) => {
          if (candidate.id !== entry.id) return candidate;
          const next: ModelEntry = {
            ...candidate,
            modelId: input.modelId,
            name: input.modelId,
            baseUrl: input.baseUrl,
          };
          if (fieldsChanged) {
            next.status = 'untested';
            delete next.lastTestedAt;
          }
          return next;
        }),
      );
      persistMeta();
      pushMirror();
    },
    [ensureLoaded, findEntry, persistMeta, pushMirror, setRows],
  );

  const remove = useCallback(
    async (id: string): Promise<UndoHandle> => {
      await ensureLoaded();
      const entry = findEntry(id);
      const index = rowsRef.current.findIndex((candidate) => candidate.id === id);
      // 1) 立即出 entries（含 meta / 镜像快照）。
      setRows((prev) => prev.filter((candidate) => candidate.id !== id));
      persistMeta();
      pushMirror();
      // 2) 表驱动挂起：5s 后才落真正的 deleteCustomProvider（含 keychain 密钥）。
      const record: PendingDelete = {
        entry,
        index,
        timer: setTimeout(() => {
          if (record.done) return;
          record.done = true;
          pendingDeletesRef.current.delete(id);
          void deleteCustomProvider(entry.id).catch(() => {
            // 延迟删除 best-effort：失败残留孤儿配置（同样不复活到列表）。
          });
        }, REMOVE_UNDO_WINDOW_MS),
        done: false,
      };
      pendingDeletesRef.current.set(id, record);
      // 3) 软摘除新表单标记：窗口内强杀进程时残留配置不进列表（store 只收带标记条目）。
      //    空 keys + 端点不变 → main 侧不动 keychain，密钥随残留保留（Review Focus #1）。
      try {
        await updateCustomProvider(buildModelGatewayConfig(entry.id, entry.modelId, entry.baseUrl, false), {});
      } catch {
        // 摘标记失败：仅影响「窗口内强杀不复活」这一残留语义，不阻断删除。
      }
      return {
        undo: () => {
          if (record.done) return;
          record.done = true;
          clearTimeout(record.timer);
          pendingDeletesRef.current.delete(id);
          // 补回标记（fire-and-forget）+ 按原索引插回；meta / 镜像跟着恢复一致。
          void updateCustomProvider(buildModelGatewayConfig(entry.id, entry.modelId, entry.baseUrl), {}).catch(
            () => {
              // 补标记失败：条目回列表但下次加载会被过滤——尽力而为。
            },
          );
          setRows((prev) => {
            const at = Math.min(record.index, prev.length);
            return [...prev.slice(0, at), record.entry, ...prev.slice(at)];
          });
          persistMeta();
          pushMirror();
        },
      };
    },
    [ensureLoaded, findEntry, persistMeta, pushMirror, setRows],
  );

  const toggle = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      await ensureLoaded();
      findEntry(id);
      setRows((prev) =>
        prev.map((candidate) =>
          candidate.id === id ? { ...candidate, enabled } : candidate,
        ),
      );
      persistMeta();
      pushMirror();
    },
    [ensureLoaded, findEntry, persistMeta, pushMirror, setRows],
  );

  const setStatus = useCallback(
    async (id: string, status: ModelStatus): Promise<void> => {
      const entry = rowsRef.current.find((candidate) => candidate.id === id);
      // 重测与删除可能并发；丢弃对已删条目的回写即可，不向调用方抛。
      if (!entry) return;
      setRows((prev) =>
        prev.map((candidate) => {
          if (candidate.id !== id) return candidate;
          const next: ModelEntry = { ...candidate, status };
          if (status === 'untested') delete next.lastTestedAt;
          else next.lastTestedAt = new Date().toISOString();
          return next;
        }),
      );
      persistMeta();
      pushMirror();
    },
    [persistMeta, pushMirror, setRows],
  );

  // 插入序（PRD 推翻 modelId 字母序）：加载顺序 = listProviders 返回序，add 追加末尾。
  const entries = useMemo(() => rows.slice(), [rows]);

  return useMemo(
    () => ({ entries, hydrated, add, update, remove, toggle, setStatus }),
    [entries, hydrated, add, update, remove, toggle, setStatus],
  );
}

const ModelGatewayContext = createContext<ModelGatewayApi | null>(null);

export function ModelGatewayProvider(props: { children?: ReactNode }): ReactElement {
  const value = useModelGatewayStore();
  return createElement(ModelGatewayContext.Provider, { value }, props.children);
}

export function useModelGateway(): ModelGatewayApi {
  const value = useContext(ModelGatewayContext);
  if (!value) throw new Error('useModelGateway must be used within ModelGatewayProvider');
  return value;
}
