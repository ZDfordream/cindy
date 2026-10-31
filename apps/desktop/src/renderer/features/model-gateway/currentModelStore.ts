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
  const { entries } = useModelGateway();
  const enabled = useMemo(() => entries.filter((entry) => entry.enabled), [entries]);
  const stillAvailable = stored !== null && enabled.some((entry) => entry.id === stored);
  const effective = stillAvailable ? stored : (enabled[0]?.id ?? null);

  // 删除 / 关闭当前条目 → 回落到第一个 enabled；存储跟对外值保持一致。
  useEffect(() => {
    if (effective !== stored) writeStoredId(effective);
  }, [effective, stored]);

  const setCurrent = useCallback((id: string) => {
    writeStoredId(id);
  }, []);

  return useMemo(() => ({ currentId: effective, setCurrent }), [effective, setCurrent]);
}
