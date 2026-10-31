/**
 * ModelGatewayStore —— 模型条目的唯一真源（配置 + 连通状态 + 启停）。
 *
 * 持久化边界（Ruling 2）：配置走既有 custom provider 存储（`create/update/deleteCustomProvider`
 * → localDb + keychain），本 store 不写任何文件；`~/.hrbuddy/models.json` 镜像是 main 侧
 * （Task 5）的职责。密钥经 `keys: { 'claude-code': apiKey }` 直接提交给 IPC，**不进
 * React state**。
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

/** store 内部行：对外只暴露 `entry`，`providerId` 用于 CRUD 定位存储记录。 */
interface InternalRow {
  providerId: string;
  entry: ModelEntry;
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

function entryFromModel(input: ModelGatewayInput): ModelEntry {
  return {
    id: input.modelId,
    name: input.modelId,
    baseUrl: input.baseUrl,
    enabled: true,
    status: 'untested',
  };
}

function rowFromProviderView(provider: ProviderView): InternalRow | null {
  if (provider.source !== 'user' || provider.removed) return null;
  const model = provider.models['claude-code']?.[0];
  if (model?.catalogPresetId !== MODEL_GATEWAY_CATALOG_PRESET_ID) return null;
  return {
    providerId: storedCustomProviderId(provider.id),
    entry: {
      id: model.id,
      name: model.name || model.id,
      baseUrl: provider.routing['claude-code']?.upstream ?? '',
      enabled: true,
      status: 'untested',
    },
  };
}

function useModelGatewayStore(): ModelGatewayApi {
  const [rows, setRowsState] = useState<InternalRow[]>([]);
  // 同步读最新行（update/remove/setStatus 要先拿 providerId 再发 IPC）。
  const rowsRef = useRef<InternalRow[]>([]);
  // 生成新 provider id 时避开全部自定义供应商（含旧表单隐藏项）的已用 id。
  const knownProviderIdsRef = useRef<Set<string>>(new Set());
  const loadRef = useRef<Promise<void> | null>(null);

  const setRows = useCallback((updater: (prev: InternalRow[]) => InternalRow[]) => {
    rowsRef.current = updater(rowsRef.current);
    setRowsState(rowsRef.current);
  }, []);

  const ensureLoaded = useCallback((): Promise<void> => {
    loadRef.current ??= window.electronAPI.maker.listProviders().then(({ providers }) => {
      knownProviderIdsRef.current = new Set(
        providers
          .filter((provider) => provider.source === 'user' && !provider.removed)
          .map((provider) => storedCustomProviderId(provider.id)),
      );
      setRows(() => providers.map(rowFromProviderView).filter((row): row is InternalRow => row !== null));
    });
    return loadRef.current;
  }, [setRows]);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  const findRow = useCallback(
    (id: string): InternalRow => {
      const row = rowsRef.current.find((candidate) => candidate.entry.id === id);
      if (!row) throw new Error(`model gateway entry '${id}' not found`);
      return row;
    },
    [],
  );

  const add = useCallback(
    async (input: ModelGatewayInput): Promise<string> => {
      await ensureLoaded();
      const providerId = uniqueCustomProviderId(input.modelId, knownProviderIdsRef.current);
      await createCustomProvider(
        buildModelGatewayConfig(providerId, input.modelId, input.baseUrl),
        { 'claude-code': input.apiKey },
      );
      knownProviderIdsRef.current.add(providerId);
      setRows((prev) => [...prev, { providerId, entry: entryFromModel(input) }]);
      return input.modelId;
    },
    [ensureLoaded, setRows],
  );

  const update = useCallback(
    async (id: string, input: ModelGatewayInput): Promise<void> => {
      await ensureLoaded();
      const row = findRow(id);
      await updateCustomProvider(
        buildModelGatewayConfig(row.providerId, input.modelId, input.baseUrl),
        { 'claude-code': input.apiKey },
      );
      setRows((prev) =>
        prev.map((candidate) =>
          candidate.providerId === row.providerId
            ? {
                ...candidate,
                entry: {
                  ...candidate.entry,
                  id: input.modelId,
                  name: input.modelId,
                  baseUrl: input.baseUrl,
                },
              }
            : candidate,
        ),
      );
    },
    [ensureLoaded, findRow, setRows],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await ensureLoaded();
      const row = findRow(id);
      await deleteCustomProvider(row.providerId);
      setRows((prev) => prev.filter((candidate) => candidate.providerId !== row.providerId));
    },
    [ensureLoaded, findRow, setRows],
  );

  const toggle = useCallback(
    async (id: string, enabled: boolean): Promise<void> => {
      await ensureLoaded();
      const row = findRow(id);
      setRows((prev) =>
        prev.map((candidate) =>
          candidate.providerId === row.providerId
            ? { ...candidate, entry: { ...candidate.entry, enabled } }
            : candidate,
        ),
      );
    },
    [ensureLoaded, findRow, setRows],
  );

  const setStatus = useCallback(
    (id: string, status: ModelStatus): void => {
      const row = rowsRef.current.find((candidate) => candidate.entry.id === id);
      // 重测与删除可能并发；丢弃对已删条目的回写即可，不向调用方抛。
      if (!row) return;
      setRows((prev) =>
        prev.map((candidate) => {
          if (candidate.providerId !== row.providerId) return candidate;
          const entry: ModelEntry = { ...candidate.entry, status };
          if (status === 'untested') delete entry.lastTestedAt;
          else entry.lastTestedAt = new Date().toISOString();
          return { ...candidate, entry };
        }),
      );
    },
    [setRows],
  );

  const entries = useMemo(
    () => rows.map((row) => row.entry).sort((a, b) => a.id.localeCompare(b.id)),
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
