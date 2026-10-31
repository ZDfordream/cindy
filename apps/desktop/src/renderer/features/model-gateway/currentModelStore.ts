/**
 * currentModelStore —— 全局当前模型（设计稿 §6.4：所有对话共用，跨重启记住上次选的）。
 *
 * 单一职责：**全局单一值 + localStorage**。持久化键 `hrbuddy.currentModel`，存
 * `ModelEntry.id`（稳定句柄，Ruling 4——存 modelId 的话改名即悬空）。
 *
 * 回落（Review Focus #4）：`useCurrentModel().currentId` 永远指向**存在且 enabled**
 * 的条目——当前模型被删除 / 关闭后自动回落到第一个 enabled（按 store 的 modelId
 * 升序）；没有可用条目时为 null。首个可用模型自动成为当前模型（设计稿 §6.5）。
 * 回落结果写回 localStorage，存储与对外值始终一致。
 *
 * 需在 `ModelGatewayProvider` 之下使用（回落要读条目表）。
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { useModelGateway } from './ModelGatewayStore';

/** 全局当前模型的 localStorage key（简报指定的字面量）。 */
export const CURRENT_MODEL_STORAGE_KEY = 'hrbuddy.currentModel';

/** 模块级单一值；`null` = 未选 / 无可用模型。 */
let storedId: string | null = readStoredId();
const listeners = new Set<() => void>();

function readStoredId(): string | null {
  try {
    return window.localStorage.getItem(CURRENT_MODEL_STORAGE_KEY);
  } catch {
    // localStorage 不可用：退化为会话内状态，不阻塞选择。
    return null;
  }
}

function writeStoredId(id: string | null): void {
  storedId = id;
  try {
    if (id === null) window.localStorage.removeItem(CURRENT_MODEL_STORAGE_KEY);
    else window.localStorage.setItem(CURRENT_MODEL_STORAGE_KEY, id);
  } catch {
    // 配额满 / 隐私模式：只影响持久化，不影响本次会话。
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string | null {
  return storedId;
}

/** 全局当前模型读写：`currentId` 为回落后的有效值；`setCurrent` 只接受稳定 id。 */
export interface CurrentModelApi {
  currentId: string | null;
  setCurrent(id: string): void;
}

export function useCurrentModel(): CurrentModelApi {
  const stored = useSyncExternalStore(subscribe, getSnapshot);
  const { entries, hydrated } = useModelGateway();
  const enabled = useMemo(() => entries.filter((entry) => entry.enabled), [entries]);
  // 加载窗口内（条目表尚未 hydrate）保持已持久化值**不动**：entries 的 [] 只是
  // 「还没读到」，不是「没有可用模型」——把窗口内的 null 写回去会在每次重启 /
  // ChatInput remount 时抹掉用户的当前模型（review Important 1）。
  const stillAvailable = stored !== null && enabled.some((entry) => entry.id === stored);
  const effective = !hydrated
    ? stored
    : stillAvailable
      ? stored
      : (enabled[0]?.id ?? null);

  // 删除 / 关闭当前条目 → 回落到第一个 enabled；存储跟对外值保持一致。
  // 只在条目表确定已加载后才写回。
  useEffect(() => {
    if (!hydrated) return;
    if (effective !== stored) writeStoredId(effective);
  }, [hydrated, effective, stored]);

  const setCurrent = useCallback((id: string) => {
    writeStoredId(id);
  }, []);

  return useMemo(() => ({ currentId: effective, setCurrent }), [effective, setCurrent]);
}

/** 发送路径读到的路由（Ruling 18）：全局当前模型 → 本条消息要用的 (providerId, modelId)。 */
export interface CurrentModelRoute {
  /** 稳定句柄 = 自定义供应商 id，直接作为发送的 providerId。 */
  providerId: string;
  /** 上游模型 id，直接作为发送的 wire model。 */
  modelId: string;
}

/**
 * 主聊天发送路径消费的当前路由。`currentId` 经 `useCurrentModel` 回落后恒指向
 * 存在且 enabled 的条目；这里把它解析成发送需要的 (providerId, modelId) 对。
 * 无可用模型时返回 null（发送回落调用方原有的默认链路）。
 */
export function useCurrentModelRoute(): CurrentModelRoute | null {
  const { currentId } = useCurrentModel();
  const { entries } = useModelGateway();
  return useMemo(() => {
    if (currentId === null) return null;
    const entry = entries.find((candidate) => candidate.id === currentId);
    return entry ? { providerId: entry.id, modelId: entry.modelId } : null;
  }, [currentId, entries]);
}
