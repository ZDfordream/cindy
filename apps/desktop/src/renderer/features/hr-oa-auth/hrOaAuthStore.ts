/**
 * hrOaAuthStore.ts — renderer 侧 HR OA 登录态镜像。
 *
 * 经 preload 桥（`window.electronAPI.hrOa.*`）消费 Task 2 的 `hrOa:login` / `hrOa:logout` /
 * `hrOa:state` IPC；状态变化不另开推送通道，**骑现有 `auth:state-change`**（payload 带
 * `hrProfile`）后重拉一次 `hrOa:state`，以拿到含 accountKey 的完整 `HrOaAuthState`。
 *
 * 口令只经 `login(username, password)` 入参过桥进 main；不进本模块的 state、不落盘。
 *
 * 会话规则（FR-SESSION-02…05）也记在这份模块级门禁记忆里（跨 ownerKey 重挂载存活）：
 * - **显式登录资格**：只有 `login()`（用户在 S2 手输）成功才立起 S3 引导资格——
 *   「仅启动且登录态有效」走 `getState` 静默落定，**不**立资格，S3 不再弹（FR-SESSION-05）。
 * - **主动登出抑制**：`requestHrOaLogout()` 先标记 voluntary，had-session → signed-out
 *   的落差不再计入失效通知（FR-HOME-03 主动登出不得弹「登录已过期」；LocalDbGate
 *   的 fatal-DB 离开路径同款）。
 * - **T9/T10 转场锁**：登出 / 失效的落差记 600ms 锁（PRD §9.2）；失效 toast 在锁末
 *   弹出（FR-SESSION-02），登出动作在锁内防重入。
 */

import { useCallback, useEffect, useState } from 'react';

import { captureActiveOwnerComposerDrafts } from '@/lib/composerDraftStore';
import { createLogger } from '@/lib/logger';

import type { OaLoginFailure } from '../../../main/hr-oa/errors';
import type { PersonProfile } from '../../../main/hr-oa/profile';
import type { HrOaAuthState } from '../../../main/hr-oa/sessionManager';

const log = createLogger('HrOaAuthStore');

export type { HrOaAuthState, OaLoginFailure, PersonProfile };

/** `hrOa:login` 的原样回包：显式登录失败恒为 `{ error }`（Ruling 3），成功为新状态。 */
export type HrOaLoginResult = HrOaAuthState | { error: OaLoginFailure };

/**
 * 「登录成功」拍时长（PRD §9.2 / FR-LOGIN-04）。
 */
export const HR_OA_SUCCESS_BEAT_MS = 500;

/**
 * T9/T10 转场锁时长（PRD §9.2）：退出登录 / 登录态失效的转场窗口。行为锁（防重入 +
 * 失效 toast 的弹出时机），不是 CSS 时长——CSS 动效另走 motion token。
 */
export const HR_OA_LEAVE_LOCK_MS = 600;

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
  /** 显式登录成功后未消费的 S3 引导资格（FR-SESSION-05）。 */
  onboardingEligible: boolean;
  /** 主动登出（voluntary）标记：下一落 signed-out 的落差不计入失效通知。 */
  voluntaryLogout: boolean;
  /** T9/T10 转场锁截止时刻（Date.now() 基）。 */
  leaveDeadline: number | null;
  /** 登出转场在途（防重入；与 leaveDeadline 分工：这只锁 logout 动作）。 */
  leaveInFlight: boolean;
} = {
  lastStatus: null,
  loginInFlight: false,
  successBeatDeadline: null,
  expiryNoticeSeq: 0,
  noticeConsumedSeq: 0,
  onboardingEligible: false,
  voluntaryLogout: false,
  leaveDeadline: null,
  leaveInFlight: false,
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
    // T9/T10 转场锁从落差起算（PRD §9.2）：失效 toast 在锁末弹出。
    gateMemory.leaveDeadline = Date.now() + HR_OA_LEAVE_LOCK_MS;
    // 主动登出（requestHrOaLogout）不弹「登录已过期」（FR-HOME-03）；voluntary 标记
    // 一次性消费——下一次真正失效（凭证过期 / 吊销）恢复弹 toast。
    if (!gateMemory.voluntaryLogout) {
      gateMemory.expiryNoticeSeq += 1;
    }
    gateMemory.voluntaryLogout = false;
  }
  if (next.status === 'signed-in' || next.status === 'offline') {
    gateMemory.voluntaryLogout = false;
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

/**
 * S3 引导资格是否待决（**只读**，不消费）：显式登录成功后、S3 宿主做出「弹 / 不弹」
 * 决定前都为 true。宿主可能在 hydrate 前被切走（离开首页），所以决定前不得消费。
 */
export function hrOaOnboardingEligibilityPending(): boolean {
  return gateMemory.onboardingEligible;
}

/**
 * 消费 S3 引导资格（一次显式登录只弹一次 S3，FR-SESSION-05）。宿主在 **做出决定**
 * 时消费：条目为空 → 弹 S3；已有模型 → 直接 S4a（T3b）。两者都消费，避免重挂载后再弹。
 */
export function consumeHrOaOnboardingEligibility(): boolean {
  const eligible = gateMemory.onboardingEligible;
  gateMemory.onboardingEligible = false;
  publishGateMemory();
  return eligible;
}

/** T9/T10 转场锁剩余毫秒；无锁返回 0（失效 toast 在锁末弹出）。 */
export function hrOaLeaveLockRemainingMs(now = Date.now()): number {
  return gateMemory.leaveDeadline === null
    ? 0
    : Math.max(0, gateMemory.leaveDeadline - now);
}

/** T9 首页淡出的 JS 等待窗口：从 motion token 读出（reduce / jsdom 下 0 即瞬时）。 */
function leaveFadeMs(): number {
  if (typeof window === 'undefined') return 0;
  const style = window.getComputedStyle(document.documentElement);
  return parseFloat(style.getPropertyValue('--motion-exit')) || 0;
}

/**
 * 「更多 → 退出登录」（FR-HOME-03 / FR-SESSION-03 / T9）的单一入口。
 *
 * 顺序照 PRD §9.2 T9：首页淡出（`data-hr-leave`）→ 清登录态与未发送草稿（**保留**
 * 该账号模型配置——模型配置不在这条链上动）→ 落 signed-out 回 S1。主动登出**不**弹
 * 「登录已过期」（voluntary 抑制）；转场锁内重复触发直接丢弃（防重入）。
 * LocalDbGate 的 fatal-DB 离开路径同样走这里，不再裸调 `hrOa.logout`。
 *
 * 回 true = 登出已落定（调用方可切 UI）；回 false = 链路失败（登录态未变，标志位
 * 已收回，留在原界面等下一次触发）。**不抛错**——失败是可恢复状态，不是异常面。
 */
export async function requestHrOaLogout(): Promise<boolean> {
  if (gateMemory.leaveInFlight) return false;
  gateMemory.leaveInFlight = true;
  gateMemory.voluntaryLogout = true;
  gateMemory.leaveDeadline = Date.now() + HR_OA_LEAVE_LOCK_MS;
  if (typeof document !== 'undefined') document.body.dataset.hrLeave = 'leaving';
  // 草稿销毁器先**捕获**（此刻 owner 前缀还是登录账号），登出**成功**才销毁
  // （FR-SESSION-03）：失败 = 登录态与草稿都留在原状，等下一次触发。推送可能在
  // IPC 期间把 active owner 切走，事后再按当前前缀找就找不到这批草稿（见
  // composerDraftStore 的 capture 头注）。expiry 路径刻意不走这里（FR-SESSION-02
  // 同账号重新登录恢复草稿）。
  const destroyDrafts = captureActiveOwnerComposerDrafts();
  try {
    const fadeMs = leaveFadeMs();
    if (fadeMs > 0) await new Promise((resolve) => window.setTimeout(resolve, fadeMs));
    await window.electronAPI.hrOa.logout();
    destroyDrafts();
    landHrOaState({ status: 'signed-out' });
    publishGateMemory();
    return true;
  } catch (err) {
    // 登出失败（keychain / IPC）：登录态未变、草稿未动，留在原界面；口令照旧保留。
    log.warn('hrOa logout failed', err);
    return false;
  } finally {
    gateMemory.leaveInFlight = false;
    if (typeof document !== 'undefined') delete document.body.dataset.hrLeave;
    // 登出链失败没落成 signed-out 时，把 voluntary 标记收回来——否则下一次
    // **真正**的失效落差会被误抑制（过期 toast 反而不弹）。
    if (gateMemory.lastStatus !== 'signed-out') gateMemory.voluntaryLogout = false;
  }
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
        // FR-SESSION-05：只有显式登录成功才立 S3 引导资格；启动静默恢复不走这里。
        gateMemory.onboardingEligible = true;
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
    // 失败（回 false）不切 UI：登录态未变，等下一次触发。
    if (await requestHrOaLogout()) setState({ status: 'signed-out' });
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
    gateMemory.onboardingEligible = false;
    gateMemory.voluntaryLogout = false;
    gateMemory.leaveDeadline = null;
    gateMemory.leaveInFlight = false;
    publishGateMemory();
  },
};
