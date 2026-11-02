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
 * - **失效通知双源（Finding 1/4）**：①had-session → signed-out 的落差（非自愿）；
 *   ②状态自带 `reason:'expired'`（startup / 网络恢复的凭证类失败、TTL 过期）——**冷启动
 *   也弹**「登录已过期，请重新登录」（FR-SESSION-02 主触发路径，此前被 in-process
 *   落差判据吞掉）。首启无凭证（无 reason）不是失效，不弹。
 * - **主动登出抑制**：`requestHrOaLogout()` 先标记 voluntary，且 main 的 `logout()` 落
 *   `reason:'logout'` 随推送带给**每个**窗口（voluntary 标记只在本窗有，兄弟窗口靠
 *   reason 抑制——Finding 4）；had-session → signed-out 的落差不再计入失效通知
 *   （FR-HOME-03 主动登出不得弹「登录已过期」；LocalDbGate 的 fatal-DB 离开路径同款）。
 * - **T9/T10 转场锁**：登出 / 失效的落差记 600ms 锁（PRD §9.2）；失效 toast 在锁末
 *   弹出（FR-SESSION-02），登出动作在锁内防重入。冷启动发现失效无锁（没有首页可淡出）。
 * - **离线只读（Finding 2）**：`offline` 落定暴露 `useHrOaSessionOffline()`——composer
 *   发送置灰与模型连通「未知」共用它；网络恢复（`window 'online'`）触发 main 静默重登。
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { captureActiveOwnerComposerDrafts } from '@/lib/composerDraftStore';
import { createLogger } from '@/lib/logger';
import { clearHrOaHomeArrival, noteHrOaHomeArrival, trackHrOaEvent } from '@/lib/hrOaTelemetry';
// Ruling B / F 把「进行中任务」的计数/真停放在 hr-oa-profile/runningTasks.ts（跨 feature
// 引用是裁决指定位置的结果，不是层级倒置）。该模块对 makerChatStore 仅类型引用
// （store 自登记，见其头注），静态 import 无重模块装入代价，可在落定处同步调用。
import { stopRunningAgentRuns } from '../hr-oa-profile/runningTasks';

import type { OaLoginFailure } from '../../../main/hr-oa/errors';
import type { PersonProfile } from '../../../main/hr-oa/profile';
import type { HrOaAuthState, HrOaSignedOutReason } from '../../../main/hr-oa/sessionManager';

const log = createLogger('HrOaAuthStore');

export type { HrOaAuthState, HrOaSignedOutReason, OaLoginFailure, PersonProfile };

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

/**
 * T15 确认拍时长（PRD §9.2，FR-LOGOUT-02）：确认后「正在退出…」按钮至少保持
 * 400ms 再落 signed-out（可感反馈，不闪断）。确认链经
 * `requestHrOaLogout({ confirmBeatMs })` 传入；LocalDbGate 等无确认路径不带拍。
 */
export const HR_OA_LOGOUT_CONFIRM_BEAT_MS = 400;

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
  /**
   * HR OA `offline` 落定中（设计 §4.2 离线只读）：composer 发送置灰、模型连通展示
   * 「未知」都认这一个信号（Finding 2）。
   */
  sessionOffline: boolean;
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
  /**
   * S1 曝光原因（`welcome_view.from`，PRD §10.2）：本次 signed-out 周期怎么来的——
   * 冷启动无会话 = launch；主动登出 = logout；会话失效 = token_expired。
   * sticky 到下一次状态转移（S1↔S2 来回不改因）。
   */
  welcomeFrom: 'launch' | 'logout' | 'token_expired';
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
  welcomeFrom: 'launch',
};

let gateMemorySnapshot: HrOaGateMemorySnapshot = {
  loginInFlight: false,
  successBeatActive: false,
  expiryNoticeSeq: 0,
  sessionOffline: false,
};
const gateMemoryListeners = new Set<() => void>();

function publishGateMemory(): void {
  gateMemorySnapshot = {
    loginInFlight: gateMemory.loginInFlight,
    successBeatActive: gateMemory.successBeatDeadline !== null,
    expiryNoticeSeq: gateMemory.expiryNoticeSeq,
    sessionOffline: gateMemory.lastStatus === 'offline',
  };
  for (const listener of gateMemoryListeners) listener();
}

/**
 * 真停当前账号的在途 Agent 轮（Ruling F：**凡落 signed-out 先停**，不只确认路径）。
 * 见 runningTasks 头注：stop 同步执行（store 自登记），失败吞掉只记 warn——停失败
 * 不得拦住落定，否则用户被卡在半失效态；顺序合同仍是**停的尝试先于落定**。
 */
function stopInFlightAgentRunsSafely(): void {
  try {
    stopRunningAgentRuns();
  } catch (err) {
    log.warn('stop in-flight agent runs failed', err);
  }
}

/**
 * 落定一个登录态：记录 had-session 落差与 signed-out 原因（跨重挂载存活）。
 *
 * 失效通知（FR-SESSION-02 的 toast）两类来源（Finding 1/4）：
 *   1. **in-process 落差**：had-session（signed-in/offline）→ signed-out 且非自愿——
 *      合成推送 / 无 reason 的兼容路径都走这条，T9 转场锁从落差起算；
 *   2. **状态自带 `reason:'expired'`**（startup / 网络恢复的凭证类失败、TTL 过期）：
 *      **冷启动（previous === null）也弹**——这是 FR-SESSION-02 的主触发路径，旧实现
 *      只认 in-process 落差，冷启动静默重登失效被吞（最终分支评审 Finding 1）。
 *
 * 自愿性双源：本窗 `requestHrOaLogout` 的 voluntary 标记（一次性消费）+ 状态携带的
 * `reason:'logout'`（main 的 logout() 是唯一自愿来源，兄弟窗口只看得到后者——
 * Finding 4：只靠本窗标记，另一窗口登出会让这边误弹「登录已过期」）。
 *
 * 同一 signed-out 的重复落定（多次 sync 重拉）不重复弹、不改 S1 曝光因（sticky）。
 */
function landHrOaState(next: HrOaAuthState): void {
  const previous = gateMemory.lastStatus;
  // Ruling F：**先停后落**——凡**进入** signed-out 的落定（手动 / 失效强退 FR-LOGOUT-05 /
  // 冷启动发现失效 / 多窗口推送）都先真停在途 Agent 轮（幂等）。同步执行、失败吞掉：
  // 不得把 S1 落定拖在停任务的异步装入之后（顺序合同 = 停的尝试先于落定）。
  if (next.status === 'signed-out' && previous !== 'signed-out') {
    stopInFlightAgentRunsSafely();
  }
  gateMemory.lastStatus = next.status;
  const wasActive = previous === 'signed-in' || previous === 'offline';
  if (next.status === 'signed-out') {
    const entered = previous !== 'signed-out';
    const voluntary = gateMemory.voluntaryLogout || next.reason === 'logout';
    if (entered) {
      const expiry = next.reason === 'expired' || (wasActive && !voluntary);
      if (expiry) gateMemory.expiryNoticeSeq += 1;
      if (wasActive) {
        // T9/T10 转场锁从落差起算（PRD §9.2）：失效 toast 在锁末弹出。
        gateMemory.leaveDeadline = Date.now() + HR_OA_LEAVE_LOCK_MS;
        // 埋点（PRD §10.2 + profile-menu §11）：退出登录 / 登录态失效共一个事件，reason
        // 区分；entry 记会话是从哪条链收掉的（自愿登出只有 profile_menu 一条入口；失效
        // 默认 session_check，token_refresh 凭证被拒强退由状态带 entry）。account_hash
        // 走上下文（signed-out 保留末次账号键）。冷启动发现失效（无 in-process 会话）
        // 不发 logout 事件——没有可归因的登出动作，只改 S1 曝光因。
        trackHrOaEvent('logout', {
          reason: voluntary ? 'user' : 'token_expired',
          entry: next.entry ?? (voluntary ? 'profile_menu' : 'session_check'),
        });
        // 登出即一次首页到达周期结束：丢弃未消费的到达账，防下次登录串台。
        clearHrOaHomeArrival();
      }
      // S1 曝光原因（welcome_view.from，PRD §10.2）。
      gateMemory.welcomeFrom = voluntary ? 'logout' : expiry ? 'token_expired' : 'launch';
    }
    gateMemory.voluntaryLogout = false;
  }
  if (next.status === 'signed-in' || next.status === 'offline') {
    gateMemory.voluntaryLogout = false;
    // 冷启动静默恢复落定（此前无会话）= launch 到达；显式登录在 login() 里另记。
    if (previous === null) {
      noteHrOaHomeArrival('launch');
    }
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

function getSessionOffline(): boolean {
  return gateMemorySnapshot.sessionOffline;
}

/**
 * HR OA 离线只读信号（设计 §4.2，Finding 2）：`offline` 落定中返回 true。
 * composer 发送置灰、模型连通展示「未知」共用这一个来源——不另开镜像。
 * 骑模块级门禁记忆（不发 IPC）：状态由 `useHrOaAuth` 的 sync 落进来。
 */
export function useHrOaSessionOffline(): boolean {
  return useSyncExternalStore(subscribeHrOaGateMemory, getSessionOffline);
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

/**
 * 本次 signed-out 周期的 S1 曝光原因（`welcome_view.from`，PRD §10.2）：
 * launch = 冷启动无会话；logout = 主动登出后；token_expired = 会话失效后。
 */
export function getHrOaWelcomeFrom(): 'launch' | 'logout' | 'token_expired' {
  return gateMemory.welcomeFrom;
}

/** T9 首页淡出的 JS 等待窗口：从 motion token 读出（reduce / jsdom 下 0 即瞬时）。 */
function leaveFadeMs(): number {
  if (typeof window === 'undefined') return 0;
  const style = window.getComputedStyle(document.documentElement);
  return parseFloat(style.getPropertyValue('--motion-exit')) || 0;
}

/**
 * 退出登录（FR-LOGOUT-01~05 / FR-HOME-03 / FR-SESSION-03 / T9）的单一入口：
 * 个人弹层末项的确认弹窗（Task 5）与 LocalDbGate 的 fatal-DB 离开路径共用。
 *
 * 顺序合同（PRD §9.2 T9/T15 + owner 裁定 Ruling B / Review Focus #1）：
 *   1. **先真停**当前账号的在途 Agent 轮（含伙伴后台轮）——只靠 UI 卸载会留下
 *      「登出后旧进程仍往旧 owner 分区写、用旧凭证发请求」的账号隔离漏洞；
 *   2. 首页淡出（`data-hr-leave`）与确认拍（`confirmBeatMs`，FR-LOGOUT-02 的
 *      「正在退出…」≥400ms）并行计时，取较长者；
 *   3. 清登录态与未发送草稿（**保留**该账号模型配置——模型配置不在这条链上动）
 *      → 落 signed-out 回 S1。
 * 主动登出**不**弹「登录已过期」（voluntary 抑制）；转场锁内重复触发直接丢弃
 * （防重入）。
 *
 * 回 true = 登出已落定（调用方可切 UI）；回 false = 链路失败（登录态未变，标志位
 * 已收回，留在原界面等下一次触发）。**不抛错**——失败是可恢复状态，不是异常面。
 */
export async function requestHrOaLogout(options?: { confirmBeatMs?: number }): Promise<boolean> {
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
    // Ruling B / Review Focus #1：**先停后落**。真停走用户 Stop 的同一生产路径
    // （stopSession：renderer 立即收口 + input.stop 中断在途轮 / 伙伴轮），必须
    // 发生在 hrOa.logout（落 signed-out 的 commit）之前；定时任务（自动化）的
    // 在途执行轮同形态计入并一并停（runningTasks 口径）。幂等——随后
    // landHrOaState 的进入 signed-out 停（Ruling F）会再调一次，零动作。
    stopInFlightAgentRunsSafely();
    const fadeMs = leaveFadeMs();
    const beatMs = options?.confirmBeatMs ?? 0;
    // 确认拍（T15）与首页淡出并行，取较长者：确认路径「正在退出…」≥400ms 才落定。
    const waitMs = Math.max(fadeMs, beatMs);
    if (waitMs > 0) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
    await window.electronAPI.hrOa.logout();
    destroyDrafts();
    // reason:'logout' 随后到的推送同款（main 的 logout() 落的也是它）：重复落定不再
    // 计一次失效，兄弟窗口也认这个 reason 抑制 toast（Finding 4）。
    landHrOaState({ status: 'signed-out', reason: 'logout' });
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
          // 失效强退等所有进入 signed-out 的落定由 landHrOaState 统一「先停后落」
          // （Ruling F，见该函数头注），此处不另拦——单一收口点。
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
    // 网络恢复（设计 §4.2「网络恢复后静默重登刷新会话」）：main 侧没有网络变化信号
    // （grep network-changed/'online'/reachability 只有 device-link/relay），本仓既有
    // 恢复信号就是渲染层 `window 'online'`（botGroupOutbox / localCatalogSnapshot 同款）。
    // 触发 main 的 networkRecovered()：只在 offline 落定后重登，多窗口同响单飞合并。
    const onOnline = (): void => {
      // 事件回调里不许抛：测试桥 / 老桥可能没接这条通道，缺了静默跳过。
      const recover = window.electronAPI.hrOa.networkRecovered;
      if (typeof recover !== 'function') return;
      void Promise.resolve(recover()).catch((err) => {
        log.warn('hrOa network-recovered failed', err);
      });
    };
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('online', onOnline);
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
        // 埋点（PRD §10.2）：显式登录成功 = 一次「登录到达」（entry=login）；
        // S3 若弹出，skip/save 会在弹窗结束处改写为 skip/save。
        noteHrOaHomeArrival('login');
      }
      return result;
    } finally {
      noteHrOaLoginInFlight(false);
    }
  }, []);

  const logout = useCallback(async () => {
    // 失败（回 false）不切 UI：登录态未变，等下一次触发。
    if (await requestHrOaLogout()) setState({ status: 'signed-out', reason: 'logout' });
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
    gateMemory.welcomeFrom = 'launch';
    publishGateMemory();
  },
  /** 走生产 `landHrOaState` 落一个登录态（离线门禁 / 失效分流用例的状态来源）。 */
  landHrOaState,
};
