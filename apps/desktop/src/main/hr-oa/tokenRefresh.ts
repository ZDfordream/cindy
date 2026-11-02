/**
 * tokenRefresh.ts — HR OA 登录凭证 12h 静默刷新调度器（main 进程，FR-TOKEN-01~08）。
 *
 * 「刷新」= 静默重登（PRD §7.6 K-4 的「没有刷新接口」是 HRMcp 的处境；HRBuddy 手上有
 * 钥匙串里的口令，`OAClient.login()` 就是刷新，不需要新端点）。本模块只做**调度**：
 * 周期 / 到期检查 / 单飞 / 失败退避 / 取消；重登本身与失败分流的副作用（清凭证强退）
 * 由 sessionManager 的 `refresh` 注入面执行。
 *
 * 合同（FR-TOKEN-01~08）：
 *   - 周期从**最近一次成功登录或成功刷新**（`last`）起算，`next = last + 12h`；两个时间戳
 *     经 `persist` 与凭证一起存本机，应用重启后（`persist.load()`）继续沿用同一周期——
 *     **不从启动起算**（否则天天重启的用户永远刷不到）。
 *   - 到期检查不依赖 12h 长定时器（睡眠/改时会失准）：由外部触发源（每 1 分钟对表 +
 *     启动/唤醒/聚焦/online）调 `onDue`，一律按墙上时钟 `now >= next` 判定；错过多个
 *     周期也只补刷 1 次。失败退避由本模块自排定时器以 `onDue('retry')` 收口。
 *   - 单飞：同一时间最多 1 次刷新，并发触发（唤醒 + 聚焦）只发 1 次；刷新超过
 *     `TOKEN_REFRESH_TIMEOUT_MS`（10s）按 timeout 放弃本次（业务请求闸随之放行）。
 *   - 失败分流（Review Focus #3，Ruling 6 同规）：network_error / timeout 保留计划与
 *     凭证、按 1 → 5 → 15 分钟退避（之后每 15 分钟一次），**不**强退、**不**提示；
 *     rejected（凭证类）清计划（强退收口在 sessionManager）。任一次成功即从成功时刻
 *     开始新 12h 周期、退避序号归零。
 *   - 静默（FR-TOKEN-03）：刷新全程零界面变化——本模块唯一外发通道是 `token_refresh`
 *     埋点触发点（无骨架/无 toast/无焦点变化；字段不含任何凭证值，FR-TOKEN-08）。
 *   - 生命周期（FR-TOKEN-07）：`cancel()` 是**终态**——清计划（删除两个时间戳）且此后
 *     任何触发都不再打网络；未登录（persist 无计划）不刷新。
 *
 * 埋点 `token_refresh`（Task 10 接 sink / 白名单）：`trigger`（本次由哪个触发源发起；
 * 自排退避为 `retry`）、`result`（success / network_error / timeout / rejected /
 * cancelled）、`attempt`（退避序号，首轮 0）、`duration_ms`、`overdue_ms`（实际刷新
 * 时刻 − next，量化对表迟到：睡眠过头 / 1 分钟粒度）。
 */

import fs from 'node:fs';
import path from 'node:path';

import { trackHrOaEvent } from './telemetry.js';

/** 刷新周期：从最近一次成功起算 12 小时（FR-TOKEN-01）。 */
export const TOKEN_REFRESH_PERIOD_MS = 12 * 60 * 60 * 1000;
/** 单次刷新尝试的总超时（FR-TOKEN-04）：挂起超过它按 timeout 收口、放行业务闸。 */
export const TOKEN_REFRESH_TIMEOUT_MS = 10_000;
/**
 * 失败退避序列（FR-TOKEN-06）：按「失败的是第几轮」取等待——第 0 轮失败等 1 分钟、
 * 第 1 轮等 5 分钟、之后每 15 分钟一次。
 */
const BACKOFF_AFTER_FAILURE_MS = [1 * 60_000, 5 * 60_000, 15 * 60_000] as const;

export type TokenRefreshTrigger = 'timer' | 'launch' | 'wake' | 'focus' | 'online' | 'retry';

/** `refresh` 注入面的回包（cancelled 由本模块的 cancel() 产生，不由 refresh 返回）。 */
export type TokenRefreshOutcome = 'success' | 'network_error' | 'timeout' | 'rejected';

/** 埋点 result 维度：refresh 回包 + 被 cancel 打断的在途尝试。 */
export type TokenRefreshResult = TokenRefreshOutcome | 'cancelled';

/** FR-TOKEN-01 的两个时间戳（last_refresh_at / next_refresh_at）。 */
export interface TokenRefreshPlan {
  last: number;
  next: number;
}

/** 计划持久化（与凭证一起存本机；logout / 强退经 cancel() 删除）。 */
export interface TokenRefreshPersist {
  save(t: TokenRefreshPlan): void;
  load(): TokenRefreshPlan | null;
  clear(): void;
}

export interface TokenRefreshScheduler {
  /** 触发一次到期检查（五路触发源 + 自排退避都走这里）；永不 reject。 */
  onDue(trigger: TokenRefreshTrigger): Promise<void>;
  /** 当前计划与退避序号（诊断/测试用；不带任何凭证值）。 */
  state(): { last: number | null; next: number | null; attempt: number };
  /** 取消刷新计划（FR-TOKEN-07）：清两个时间戳、打断在途尝试（结果按 cancelled 记）；
   * 此后该实例永不再触发。 */
  cancel(): void;
}

/**
 * 文件版 persist：时间戳落 `<userData>/hr-oa-token-refresh.json`（与凭证同住 userData 根、
 * 同一台机器的生命周期），原子替换写入；形状损坏按无计划处理（宁可不刷新也不误刷）。
 */
export function createFileTokenRefreshPersist(filePath: string): TokenRefreshPersist {
  return {
    save(t) {
      const tmp = `${filePath}.tmp`;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ last: t.last, next: t.next }), 'utf-8');
        fs.renameSync(tmp, filePath);
      } catch {
        // 计划写失败不阻断业务：下一次成功登录/刷新再落。
      }
    },
    load() {
      try {
        const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const record = value as { last?: unknown; next?: unknown };
        if (typeof record.last !== 'number' || typeof record.next !== 'number') return null;
        return { last: record.last, next: record.next };
      } catch {
        return null;
      }
    },
    clear() {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // 清失败也无妨：cancel 已是终态，残留文件不会再被本实例使用。
      }
    },
  };
}

function backoffDelayMs(failedAttempt: number): number {
  return failedAttempt < BACKOFF_AFTER_FAILURE_MS.length
    ? BACKOFF_AFTER_FAILURE_MS[failedAttempt]
    : BACKOFF_AFTER_FAILURE_MS[BACKOFF_AFTER_FAILURE_MS.length - 1];
}

export function createTokenRefreshScheduler(deps: {
  /** 静默重登（sessionManager 注入）：回包只分类，不带任何界面副作用要求。 */
  refresh: () => Promise<TokenRefreshOutcome>;
  persist: TokenRefreshPersist;
  now: () => number;
}): TokenRefreshScheduler {
  const { refresh, persist, now } = deps;
  /** 退避序号（首轮 0；成功 / rejected / cancel 归零）。进程内状态，不持久化。 */
  let attempt = 0;
  /** 上次见过的计划 `last`：变了 = 外部（登录成功）起了新周期 → 退避序号归零。 */
  let lastSeen: number | null = persist.load()?.last ?? null;
  let cancelled = false;
  let inFlight: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 在途尝试的收口钩子（cancel() 打断时按 cancelled 记）。 */
  let settleActive: ((result: TokenRefreshResult) => void) | null = null;

  function clearRetryTimer(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(delayMs: number): void {
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void onDue('retry');
    }, delayMs);
  }

  async function runAttempt(trigger: TokenRefreshTrigger, dueNext: number): Promise<void> {
    const startedAt = now();
    const myAttempt = attempt;

    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: TokenRefreshResult): void => {
        if (settled) return;
        settled = true;
        settleActive = null;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        // 先摘掉上一轮可能残留的退避计时器（外部触发抢跑过自排 retry 时会留下）；
        // network_error / timeout 分支随后再排新的。
        clearRetryTimer();
        const at = now();
        // 埋点触发点（Task 10 接 sink）：字段就是这五个，绝不携带凭证值（FR-TOKEN-08）。
        trackHrOaEvent('token_refresh', {
          trigger,
          result,
          attempt: myAttempt,
          duration_ms: Math.max(0, at - startedAt),
          // 实际刷新时刻 − 计划到期点：对表迟到量（睡眠过头 / 1 分钟检查粒度）。
          overdue_ms: startedAt - dueNext,
        });
        resolve();
        if (result === 'cancelled') return;
        if (result === 'success') {
          // 任一次成功即从成功时刻开始新 12h 周期（FR-TOKEN-01）。
          attempt = 0;
          lastSeen = at;
          persist.save({ last: at, next: at + TOKEN_REFRESH_PERIOD_MS });
          return;
        }
        if (result === 'rejected') {
          // 凭证类被拒：计划随强退一并删除（FR-TOKEN-05/07）。
          attempt = 0;
          lastSeen = null;
          persist.clear();
          return;
        }
        // network_error / timeout：保留计划与凭证，按 1 → 5 → 15 分钟退避（FR-TOKEN-06）。
        attempt = myAttempt + 1;
        const delayMs = backoffDelayMs(myAttempt);
        const prior = persist.load();
        persist.save({ last: prior?.last ?? lastSeen ?? startedAt, next: at + delayMs });
        scheduleRetry(delayMs);
      };
      settleActive = finish;

      // 10s 超时哨兵（FR-TOKEN-04）：挂起的刷新放弃本次、按 timeout 进退避；被放弃的
      // promise 迟到落定走 finish 的 settled 守卫，不再回写计划。
      timer = setTimeout(() => finish('timeout'), TOKEN_REFRESH_TIMEOUT_MS);
      refresh().then(
        (outcome) => {
          finish(outcome);
        },
        () => {
          // refresh 不该抛（注入面按分类回包）；抛出按网络类失败分流。
          finish('network_error');
        },
      );
    });
  }

  async function onDue(trigger: TokenRefreshTrigger): Promise<void> {
    if (cancelled) return;
    // 单飞：并发触发（唤醒 + 聚焦）只发 1 次，后到者等同一轮。
    if (inFlight) return inFlight;
    const plan = persist.load();
    if (!plan) {
      // 未登录 / 计划已删：不刷新（FR-TOKEN-07）。
      attempt = 0;
      lastSeen = null;
      return;
    }
    if (plan.last !== lastSeen) {
      // 外部（登录成功）起了新周期：退避序号归零。
      attempt = 0;
      lastSeen = plan.last;
    }
    if (now() < plan.next) return;
    const dueNext = plan.next;
    // .catch：注入面若违反「回 Promise、不抛」合同（同步抛），onDue 仍永不 reject。
    const run = runAttempt(trigger, dueNext).catch(() => undefined);
    inFlight = run;
    try {
      await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  }

  function state(): { last: number | null; next: number | null; attempt: number } {
    const plan = cancelled ? null : persist.load();
    return { last: plan?.last ?? null, next: plan?.next ?? null, attempt: cancelled ? 0 : attempt };
  }

  function cancel(): void {
    if (cancelled) return;
    cancelled = true;
    clearRetryTimer();
    settleActive?.('cancelled');
    settleActive = null;
    attempt = 0;
    lastSeen = null;
    persist.clear();
  }

  return { onDue, state, cancel };
}
