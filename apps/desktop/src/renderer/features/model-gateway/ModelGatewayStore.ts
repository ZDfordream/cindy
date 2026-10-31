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
 * 上游模型 id，列表按 `modelId` 字母升序。
 *
 * 每条模型条目对应一个 custom provider：单 claude-code runtime、单模型、协议写死
 * `anthropic-messages`。创建时在 runtime 配置上写新表单标记 `catalogPresetId: 'hrbuddy-gateway'`，
 * 加载时只把带标记的条目暴露进 `entries`——旧表单配置留在 localDb 但新列表看不见
 * （清空重来，设计稿 §6.5）。
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
  updateCustomProvider,
} from '@/lib/customProviders';
import { uniqueCustomProviderId } from '@/lib/customProviderId';

import type { ModelEntry, ModelGatewayApi, ModelGatewayInput, ModelStatus } from './types';

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

function buildModelGatewayConfig(
  providerId: string,
  modelId: string,
  baseUrl: string,
): CustomProviderConfig {
  return {
    id: providerId,
    name: modelId,
    runtimes: {
      'claude-code': {
        baseUrl,
        wireProtocol: 'anthropic-messages',
        catalogPresetId: MODEL_GATEWAY_CATALOG_PRESET_ID,
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

function entryFromProviderView(provider: ProviderView, meta: ModelGatewayMeta): ModelEntry | null {
  if (provider.source !== 'user' || provider.removed) return null;
  const model = provider.models['claude-code']?.[0];
  if (model?.catalogPresetId !== MODEL_GATEWAY_CATALOG_PRESET_ID) return null;
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
  // 同步读最新行（update/remove/setStatus 要先拿稳定 id 再发 IPC；persistMeta 也从这重建）。
  const rowsRef = useRef<ModelEntry[]>([]);
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
    });
    return loadRef.current;
  }, [setRows]);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

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
      return providerId;
    },
    [ensureLoaded, persistMeta, setRows],
  );

  const update = useCallback(
    async (id: string, input: ModelGatewayInput): Promise<void> => {
      await ensureLoaded();
      const entry = findEntry(id);
      await updateCustomProvider(
        buildModelGatewayConfig(entry.id, input.modelId, input.baseUrl),
        { 'claude-code': input.apiKey },
      );
      // 稳定 id 不动，只写穿 baseUrl / modelId / 密钥；enabled / status / lastTestedAt
      // 按 id 挂在 meta 上，编辑不重置。
      setRows((prev) =>
        prev.map((candidate) =>
          candidate.id === entry.id
            ? { ...candidate, modelId: input.modelId, name: input.modelId, baseUrl: input.baseUrl }
            : candidate,
        ),
      );
    },
    [ensureLoaded, findEntry, setRows],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await ensureLoaded();
      const entry = findEntry(id);
      await deleteCustomProvider(entry.id);
      setRows((prev) => prev.filter((candidate) => candidate.id !== entry.id));
      persistMeta();
    },
    [ensureLoaded, findEntry, persistMeta, setRows],
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
    },
    [ensureLoaded, findEntry, persistMeta, setRows],
  );

  const setStatus = useCallback(
    (id: string, status: ModelStatus): void => {
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
    },
    [persistMeta, setRows],
  );

  const entries = useMemo(
    () => rows.slice().sort((a, b) => a.modelId.localeCompare(b.modelId)),
    [rows],
  );

  return useMemo(
    () => ({ entries, add, update, remove, toggle, setStatus }),
    [entries, add, update, remove, toggle, setStatus],
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
