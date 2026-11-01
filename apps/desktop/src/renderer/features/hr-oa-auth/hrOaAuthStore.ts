/**
 * hrOaAuthStore.ts — renderer 侧 HR OA 登录态镜像。
 *
 * 经 preload 桥（`window.electronAPI.hrOa.*`）消费 Task 2 的 `hrOa:login` / `hrOa:logout` /
 * `hrOa:state` IPC；状态变化不另开推送通道，**骑现有 `auth:state-change`**（payload 带
 * `hrProfile`）后重拉一次 `hrOa:state`，以拿到含 accountKey 的完整 `HrOaAuthState`。
 *
 * 口令只经 `login(username, password)` 入参过桥进 main；不进本模块的 state、不落盘。
 */

import { useCallback, useEffect, useState } from 'react';

import type { OaLoginFailure } from '../../../main/hr-oa/errors';
import type { PersonProfile } from '../../../main/hr-oa/profile';
import type { HrOaAuthState } from '../../../main/hr-oa/sessionManager';

export type { HrOaAuthState, OaLoginFailure, PersonProfile };

/** `hrOa:login` 的原样回包：显式登录失败恒为 `{ error }`（Ruling 3），成功为新状态。 */
export type HrOaLoginResult = HrOaAuthState | { error: OaLoginFailure };

/**
 * 「登录成功」拍时长（PRD §9.2 / FR-LOGIN-04）。
 */
export const HR_OA_SUCCESS_BEAT_MS = 500;

// ── 门禁记忆（模块级）────────────────────────────────────────────────────────
// `OwnerScopedRouter` 用 `${dataOwnerId}:${ownerGeneration}` 作 RouterProvider 的 key，
// 每次 hr 落定（登录 commit 冻结账号键 / 登出 commit null）都会改 ownerKey、**重挂载
// 整棵路由树**（含 HrOaGate / LoginScreen）。组件 state 与 ref 过不了这次重挂载：
// 失效落差（FR-SESSION-02 toast）与「登录成功」拍（FR-LOGIN-04）恰好只在这两次转移上
// 需要记忆，记在组件里就会被恰好抹掉。因此记忆放模块级，随进程存活。
interface HrOaGateMemorySnapshot {
  /** 显式登录在途（提交发出 → 结果落定）：压住 children，重挂载不丢。 */
  loginInFlight: boolean;
  /** 「登录成功」拍进行中（结果落定 → +HR_OA_SUCCESS_BEAT_MS）：压住 children。 */
  successBeatActive: boolean;
  /** had-session → signed-out 的失效通知（`consumeHrOaExpiryNotice` 消费）。 */
  expiryNoticeSeq: number;
}

const gateMemory: {
  lastStatus: HrOaAuthState['status'] | null;
  loginInFlight: boolean;
  successBeatDeadline: number | null;
  expiryNoticeSeq: number;
  noticeConsumedSeq: number;
} = {
  lastStatus: null,
  loginInFlight: false,
  successBeatDeadline: null,
  expiryNoticeSeq: 0,
  noticeConsumedSeq: 0,
};

let gateMemorySnapshot: HrOaGateMemorySnapshot = {
  loginInFlight: false,
  successBeatActive: false,
  expiryNoticeSeq: 0,
};
const gateMemoryListeners = new Set<() => void>();

function publishGateMemory(): void {
  gateMemorySnapshot = {
    loginInFlight: gateMemory.loginInFlight,
    successBeatActive: gateMemory.successBeatDeadline !== null,
    expiryNoticeSeq: gateMemory.expiryNoticeSeq,
  };
  for (const listener of gateMemoryListeners) listener();
}

/** 落定一个登录态：记录 had-session 落差（跨重挂载存活）。 */
function landHrOaState(next: HrOaAuthState): void {
  const previous = gateMemory.lastStatus;
  gateMemory.lastStatus = next.status;
  const wasActive = previous === 'signed-in' || previous === 'offline';
  if (wasActive && next.status === 'signed-out') {
    gateMemory.expiryNoticeSeq += 1;
  }
  publishGateMemory();
}

function noteHrOaLoginInFlight(inFlight: boolean): void {
  gateMemory.loginInFlight = inFlight;
  publishGateMemory();
}

function beginHrOaSuccessBeat(): void {
  const deadline = Date.now() + HR_OA_SUCCESS_BEAT_MS;
  gateMemory.successBeatDeadline = deadline;
  publishGateMemory();
  window.setTimeout(() => {
    if (gateMemory.successBeatDeadline === deadline) {
      gateMemory.successBeatDeadline = null;
      publishGateMemory();
    }
  }, HR_OA_SUCCESS_BEAT_MS);
}

export function subscribeHrOaGateMemory(listener: () => void): () => void {
  gateMemoryListeners.add(listener);
  return () => {
    gateMemoryListeners.delete(listener);
  };
}

export function getHrOaGateMemorySnapshot(): HrOaGateMemorySnapshot {
  return gateMemorySnapshot;
}

/** 「登录成功」拍剩余毫秒；无拍返回 0（LoginScreen 重挂载续拍用）。 */
export function hrOaSuccessBeatRemainingMs(now = Date.now()): number {
  return gateMemory.successBeatDeadline === null
    ? 0
    : Math.max(0, gateMemory.successBeatDeadline - now);
}

/** 消费一次失效通知（有则取走并返回 true；幂等，多门禁实例不双弹）。 */
export function consumeHrOaExpiryNotice(): boolean {
  if (gateMemory.noticeConsumedSeq >= gateMemory.expiryNoticeSeq) return false;
  gateMemory.noticeConsumedSeq = gateMemory.expiryNoticeSeq;
  return true;
}

export interface HrOaAuthApi {
  /** 当前登录态；桥不可用或尚未拉回时为 `null`。 */
  state: HrOaAuthState | null;
  login: (username: string, password: string) => Promise<HrOaLoginResult>;
  logout: () => Promise<void>;
}

export function useHrOaAuth(): HrOaAuthApi {
  const [state, setState] = useState<HrOaAuthState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sync = (): void => {
      void window.electronAPI.hrOa
        .getState()
        .then((next) => {
          if (!cancelled) {
            landHrOaState(next);
            setState(next);
          }
        })
        .catch(() => {
          // 桥尚未接线（Task 4 前）或拉取失败：保持 null，不伪造 signed-out。
        });
    };
    sync();
    const unsubscribe = window.electronAPI.onAuthStateChange(() => {
      sync();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    // 登录在途记忆先于 IPC 落笔：结果落定前 ownerKey 重挂载也会继续压住 children。
    noteHrOaLoginInFlight(true);
    try {
      const result = await window.electronAPI.hrOa.login(username, password);
      if (!('error' in result)) {
        landHrOaState(result);
        beginHrOaSuccessBeat();
        setState(result);
      }
      return result;
    } finally {
      noteHrOaLoginInFlight(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await window.electronAPI.hrOa.logout();
    landHrOaState({ status: 'signed-out' });
    setState({ status: 'signed-out' });
  }, []);

  return { state, login, logout };
}

export const __testing = {
  resetHrOaGateMemory(): void {
    gateMemory.lastStatus = null;
    gateMemory.loginInFlight = false;
    gateMemory.successBeatDeadline = null;
    gateMemory.expiryNoticeSeq = 0;
    gateMemory.noticeConsumedSeq = 0;
    publishGateMemory();
  },
};
