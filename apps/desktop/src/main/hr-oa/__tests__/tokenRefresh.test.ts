/**
 * 测试价值
 * - 生产入口与可观察结果：`createTokenRefreshScheduler()`（FR-TOKEN-01~08 的 12h 凭证静默刷新
 *   调度器）的周期/到期/单飞/失败分流/取消/静默/埋点字段；以及 `createHrOaSessionManager`
 *   接上调度器后的可观察结果：刷新成功与网络类失败零 UI 通知（onDidChange 不触发，
 *   FR-TOKEN-03「断言不调用 UI 通知回调」）、`rejected` 落 `{status:'signed-out',reason:'expired'}`
 *   （FR-LOGOUT-05 强退 + toast 源）、`whenRefreshIdle()` 在刷新中挂起业务请求（FR-TOKEN-04）、
 *   登录起新周期 / 登出清计划（FR-TOKEN-07）。
 * - Bug／规则依据：PRD FR-TOKEN-01~08（周期从最近一次成功起算、重启沿用、每分钟对表、
 *   错过多个周期只补刷 1 次、单飞、10s 超时、网络/超时按 1/5/15 分钟退避且不强退不提示、
 *   凭证被拒强退清计划、成功起新周期、cancel 清计划、零界面变化、凭证不进埋点）；
 *   失败分流沿用登录门禁 Ruling 6（只有凭证类失败清凭证强退，一次 VPN 抖动不得把人锁在门外）。
 * - 现有覆盖缺口：新模块；sessionManager.test.ts 只覆盖启动/登录/登出的凭证分流，完全没有
 *   12h 刷新调度、退避、单飞、刷新期业务请求闸与「刷新不打扰界面」的覆盖。
 * - 最小失败输入：见表驱动失败分流四行（network_error / timeout / 挂起 10s / rejected）与
 *   退避 1→5→15→15 序列；周期两行（未到期不刷 / 错过 3 周期只补 1 次）；单飞并发两触发；
 *   静默一行（onDidChange 零调用）；闸一行（刷新中 whenRefreshIdle 不放行）；文件 persist
 *   两行（save→load→clear 重启可恢复 / 损坏按无计划）。
 * - tier：unit（无真实网络、无真实等待——vi.useFakeTimers + 注入 now；client/凭证全 fake，
 *   调度器用真实 tokenRefresh 模块）。
 * - 实测耗时：单文件 ~0.5s 墙钟（pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/tokenRefresh.test.ts）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// 埋点触发点（Task 10 接 sink）：mock 后可断言 token_refresh 的字段与「零其它事件」。
const trackHrOaEvent = vi.fn();
vi.mock('../telemetry.js', () => ({
  trackHrOaEvent: (...args: unknown[]) => trackHrOaEvent(...args),
}));

import type { OaLoginOutcome } from '../errors.js';
import { createOaClient, type OaClient, type OaTransport } from '../oaClient.js';
import type { PersonProfile } from '../profile.js';
import {
  TOKEN_REFRESH_PERIOD_MS,
  TOKEN_REFRESH_TIMEOUT_MS,
  createFileTokenRefreshPersist,
  createTokenRefreshScheduler,
  type TokenRefreshPersist,
  type TokenRefreshPlan,
  type TokenRefreshOutcome,
} from '../tokenRefresh.js';
import { createHrOaSessionManager } from '../sessionManager.js';
import type * as CredentialStoreNs from '../credentialStore.js';

const MINUTE_MS = 60_000;

function profile(overrides: Partial<PersonProfile> = {}): PersonProfile {
  return {
    name: '',
    loginName: '',
    dept: '',
    mobile: '',
    email: '',
    title: '',
    sex: '',
    personId: '',
    ...overrides,
  };
}

/** 内存 persist：记录 save/clear 调用（FR-TOKEN-07「删除时间戳」的可观察点）。 */
function makePersist(initial: TokenRefreshPlan | null = null): TokenRefreshPersist & {
  store: TokenRefreshPlan | null;
  clearSpy: ReturnType<typeof vi.fn>;
  saveSpy: ReturnType<typeof vi.fn>;
} {
  let store = initial;
  const clearSpy = vi.fn(() => {
    store = null;
  });
  const saveSpy = vi.fn((t: TokenRefreshPlan) => {
    store = { ...t };
  });
  return {
    get store() {
      return store;
    },
    save: saveSpy,
    load: () => (store ? { ...store } : null),
    clear: clearSpy,
    clearSpy,
    saveSpy,
  };
}

type RefreshQueue = Array<TokenRefreshOutcome | 'hang'>;

/** 可控 refresh：每次入队一个结果；'hang' = 永不落定（测 10s 超时哨兵）。 */
function makeRefresh(queue: RefreshQueue = []) {
  const refresh = vi.fn(() => {
    const next = queue.shift() ?? 'success';
    if (next === 'hang') return new Promise<TokenRefreshOutcome>(() => {});
    return Promise.resolve(next as TokenRefreshOutcome);
  });
  return { refresh };
}

function telemetryEvents(name: string): Array<Record<string, unknown>> {
  return trackHrOaEvent.mock.calls
    .filter((c) => c[0] === name)
    .map((c) => c[1] as Record<string, unknown>);
}

/** 浮动 promise（void onDue('retry') 等）的微任务排水。 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const start = new Date('2026-11-02T08:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  trackHrOaEvent.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createTokenRefreshScheduler 周期与到期检查（FR-TOKEN-01/02）', () => {
  it('周期从最近一次成功起算（next = last + 12h），构造时刻不算启动起算', async () => {
    // 计划：6 小时前登录成功 → next 在 6 小时后。构造（=「启动」）不得把周期推到构造+12h。
    const persist = makePersist({ last: start - 6 * 3_600_000, next: start + 6 * 3_600_000 });
    const { refresh } = makeRefresh(['success']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    await scheduler.onDue('launch');
    expect(refresh).not.toHaveBeenCalled();
    expect(scheduler.state().next).toBe(start + 6 * 3_600_000);

    // 到点才刷；成功后从成功时刻起新 12h 周期。
    vi.setSystemTime(start + 6 * 3_600_000);
    await scheduler.onDue('timer');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(scheduler.state()).toEqual({
      last: start + 6 * 3_600_000,
      next: start + 6 * 3_600_000 + TOKEN_REFRESH_PERIOD_MS,
      attempt: 0,
    });
  });

  it('重启后沿用同一周期（persist.load），不重置到构造时刻', async () => {
    const saved: TokenRefreshPlan = { last: start - 3_600_000, next: start + 11 * 3_600_000 };
    const persist = makePersist(saved);
    // 「重启」= 新建调度器；计划从 persist.load() 恢复。
    const { refresh } = makeRefresh(['success']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    vi.setSystemTime(start + 11 * 3_600_000 - 1);
    await scheduler.onDue('launch');
    expect(refresh).not.toHaveBeenCalled();

    vi.setSystemTime(start + 11 * 3_600_000);
    await scheduler.onDue('launch');
    expect(refresh).toHaveBeenCalledTimes(1);
    // 成功时刻 = 到期时刻 → 新周期从成功时刻起算。
    expect(scheduler.state().last).toBe(start + 11 * 3_600_000);
  });

  it('错过多个周期也只补刷 1 次', async () => {
    // 计划过期 3 个周期（36h）。
    const persist = makePersist({ last: start - 36 * 3_600_000, next: start - 24 * 3_600_000 });
    const { refresh } = makeRefresh(['success']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    await scheduler.onDue('timer');
    await scheduler.onDue('timer');
    await scheduler.onDue('wake');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(telemetryEvents('token_refresh')[0]?.overdue_ms).toBe(24 * 3_600_000);
    expect(scheduler.state().next).toBe(start + TOKEN_REFRESH_PERIOD_MS);
  });
});

describe('createTokenRefreshScheduler 单飞与超时（FR-TOKEN-04）', () => {
  it('并发触发（唤醒 + 聚焦）只发 1 次刷新', async () => {
    const persist = makePersist({ last: start - TOKEN_REFRESH_PERIOD_MS, next: start });
    let release: (r: TokenRefreshOutcome) => void = () => {};
    const refresh = vi.fn(
      () => new Promise<TokenRefreshOutcome>((resolve) => (release = resolve)),
    );
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    const p1 = scheduler.onDue('wake');
    const p2 = scheduler.onDue('focus');
    expect(refresh).toHaveBeenCalledTimes(1);

    release('success');
    await Promise.all([p1, p2]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('刷新挂起超过 10s 按 timeout 收口（放行业务闸并进入退避）', async () => {
    const persist = makePersist({ last: start - TOKEN_REFRESH_PERIOD_MS, next: start });
    const { refresh } = makeRefresh(['hang']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    const p = scheduler.onDue('timer');
    await vi.advanceTimersByTimeAsync(TOKEN_REFRESH_TIMEOUT_MS);
    await p;

    expect(scheduler.state().attempt).toBe(1);
    expect(scheduler.state().next).toBe(start + TOKEN_REFRESH_TIMEOUT_MS + MINUTE_MS);
    expect(telemetryEvents('token_refresh')[0]?.result).toBe('timeout');
  });
});

describe('createTokenRefreshScheduler 失败分流（FR-TOKEN-05/06，Review Focus #3）', () => {
  it('network_error 保留凭证与计划，按 1 → 5 → 15 分钟退避，之后每 15 分钟一次', async () => {
    const last = start - TOKEN_REFRESH_PERIOD_MS;
    const persist = makePersist({ last, next: start });
    const { refresh } = makeRefresh([
      'network_error',
      'timeout',
      'network_error',
      'network_error',
      'network_error',
    ]);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    // 第 0 轮（首轮）失败 → 1 分钟后重试。
    await scheduler.onDue('timer');
    expect(scheduler.state()).toEqual({ last, next: start + MINUTE_MS, attempt: 1 });

    // 第 1 轮失败 → 5 分钟。
    vi.setSystemTime(start + MINUTE_MS);
    await scheduler.onDue('timer');
    expect(scheduler.state()).toEqual({
      last,
      next: start + MINUTE_MS + 5 * MINUTE_MS,
      attempt: 2,
    });

    // 第 2 轮失败 → 15 分钟。
    vi.setSystemTime(start + MINUTE_MS + 5 * MINUTE_MS);
    await scheduler.onDue('timer');
    expect(scheduler.state()).toEqual({
      last,
      next: start + MINUTE_MS + 5 * MINUTE_MS + 15 * MINUTE_MS,
      attempt: 3,
    });

    // 第 3 轮起每 15 分钟一次。
    vi.setSystemTime(start + MINUTE_MS + 5 * MINUTE_MS + 15 * MINUTE_MS);
    await scheduler.onDue('timer');
    expect(scheduler.state()).toEqual({
      last,
      next: start + MINUTE_MS + 5 * MINUTE_MS + 15 * MINUTE_MS + 15 * MINUTE_MS,
      attempt: 4,
    });

    // 全程保留计划（不 clear）、不发任何强退/提示事件（只有 token_refresh 埋点）。
    expect(persist.clearSpy).not.toHaveBeenCalled();
    expect(persist.store?.last).toBe(last);
    const names = trackHrOaEvent.mock.calls.map((c) => c[0]);
    expect(new Set(names)).toEqual(new Set(['token_refresh']));
  });

  it('调度器自排的退避重试以 trigger=retry 触发', async () => {
    const persist = makePersist({ last: start - TOKEN_REFRESH_PERIOD_MS, next: start });
    const { refresh } = makeRefresh(['network_error', 'success']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    await scheduler.onDue('timer');
    expect(telemetryEvents('token_refresh')[0]?.trigger).toBe('timer');

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    await flushAsync();
    expect(refresh).toHaveBeenCalledTimes(2);
    const events = telemetryEvents('token_refresh');
    expect(events[1]?.trigger).toBe('retry');
    expect(events[1]?.attempt).toBe(1);
  });

  it('rejected（凭证类）清计划、不再触发（强退收口由 sessionManager 执行）', async () => {
    const persist = makePersist({ last: start - TOKEN_REFRESH_PERIOD_MS, next: start });
    const { refresh } = makeRefresh(['rejected', 'success']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    await scheduler.onDue('timer');
    expect(persist.clearSpy).toHaveBeenCalledTimes(1);
    expect(scheduler.state()).toEqual({ last: null, next: null, attempt: 0 });
    expect(telemetryEvents('token_refresh')[0]?.result).toBe('rejected');

    // 计划已删 → 后续任何触发都不再打网络。
    await scheduler.onDue('timer');
    await scheduler.onDue('online');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('任一次成功即从成功时刻开始新 12h 周期、attempt 归零', async () => {
    const last = start - TOKEN_REFRESH_PERIOD_MS;
    const persist = makePersist({ last, next: start });
    const { refresh } = makeRefresh(['network_error', 'network_error', 'success']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    await scheduler.onDue('timer');
    vi.setSystemTime(start + MINUTE_MS);
    await scheduler.onDue('timer');
    expect(scheduler.state().attempt).toBe(2);

    vi.setSystemTime(start + MINUTE_MS + 5 * MINUTE_MS);
    await scheduler.onDue('timer');
    expect(scheduler.state()).toEqual({
      last: start + MINUTE_MS + 5 * MINUTE_MS,
      next: start + MINUTE_MS + 5 * MINUTE_MS + TOKEN_REFRESH_PERIOD_MS,
      attempt: 0,
    });
    expect(persist.clearSpy).not.toHaveBeenCalled();
  });
});

describe('createTokenRefreshScheduler 生命周期与静默（FR-TOKEN-03/07）', () => {
  it('cancel() 清计划且此后不再触发（终态）', async () => {
    const persist = makePersist({ last: start - TOKEN_REFRESH_PERIOD_MS, next: start });
    const { refresh } = makeRefresh(['success']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    scheduler.cancel();
    expect(persist.clearSpy).toHaveBeenCalledTimes(1);
    expect(scheduler.state()).toEqual({ last: null, next: null, attempt: 0 });

    // 即便外部再写入计划（误用），cancelled 实例也永不再跑。
    persist.save({ last: start, next: start });
    await scheduler.onDue('timer');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('cancel() 打断在途刷新：该次结果按 cancelled 记且不回写计划', async () => {
    const persist = makePersist({ last: start - TOKEN_REFRESH_PERIOD_MS, next: start });
    let release: (r: TokenRefreshOutcome) => void = () => {};
    const refresh = vi.fn(
      () => new Promise<TokenRefreshOutcome>((resolve) => (release = resolve)),
    );
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    const p = scheduler.onDue('timer');
    scheduler.cancel();
    release('success');
    await p;

    expect(telemetryEvents('token_refresh')[0]?.result).toBe('cancelled');
    // 成功不得把计划写回来（cancel 已清）。
    expect(persist.saveSpy).not.toHaveBeenCalled();
    expect(persist.store).toBeNull();
  });

  it('FR-TOKEN-03 静默：刷新全程只发 token_refresh 埋点，无任何其它界面事件', async () => {
    const persist = makePersist({ last: start - TOKEN_REFRESH_PERIOD_MS, next: start });
    const { refresh } = makeRefresh(['success', 'network_error']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    await scheduler.onDue('timer');
    vi.setSystemTime(start + TOKEN_REFRESH_PERIOD_MS);
    await scheduler.onDue('timer');

    // 无骨架、无 toast：唯一外发通道是 token_refresh 埋点，事件名集合不含任何 UI 事件。
    const names = new Set(trackHrOaEvent.mock.calls.map((c) => c[0] as string));
    expect([...names]).toEqual(['token_refresh']);
  });

  it('埋点字段：overdue_ms = 实际刷新时刻 − next，带 trigger/attempt/duration_ms/result', async () => {
    const due = start;
    const persist = makePersist({ last: start - TOKEN_REFRESH_PERIOD_MS, next: due });
    const { refresh } = makeRefresh(['success']);
    const scheduler = createTokenRefreshScheduler({ refresh, persist, now: () => Date.now() });

    // 睡过头 5s 才被对表检查捡起。
    vi.setSystemTime(start + 5_000);
    await scheduler.onDue('wake');

    const event = telemetryEvents('token_refresh')[0];
    expect(event).toEqual({
      trigger: 'wake',
      result: 'success',
      attempt: 0,
      duration_ms: 0,
      overdue_ms: 5_000,
    });
    // 埋点绝不带凭证值（FR-TOKEN-08）：载荷键集就是上面五个字段。
    expect(Object.keys(event ?? {}).sort()).toEqual(
      ['attempt', 'duration_ms', 'overdue_ms', 'result', 'trigger'].sort(),
    );
  });
});

describe('createFileTokenRefreshPersist（FR-TOKEN-01「与凭证一起存本机」）', () => {
  // 生产重启路径的持久化契约：save→load 落盘可恢复（调度器的「重启后沿用同一周期」
  // 靠它）；文件损坏按无计划处理（宁可不刷新也不误刷）。此前只有 fake persist 覆盖。
  let tempDir: string;
  let file: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-token-refresh-test-'));
    file = path.join(tempDir, 'hr-oa-token-refresh.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('save → load 落盘可恢复；clear 删除（登出/强退清两个时间戳）', () => {
    const persist = createFileTokenRefreshPersist(file);
    expect(persist.load()).toBeNull();
    persist.save({ last: 1_000, next: 2_000 });
    // 同一路径重新构造 = 应用重启。
    expect(createFileTokenRefreshPersist(file).load()).toEqual({ last: 1_000, next: 2_000 });
    persist.clear();
    expect(createFileTokenRefreshPersist(file).load()).toBeNull();
  });

  it('文件损坏 / 形状不符按无计划处理，不抛错', () => {
    fs.writeFileSync(file, '{ not json', 'utf-8');
    expect(createFileTokenRefreshPersist(file).load()).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ last: 'x', next: 2 }), 'utf-8');
    expect(createFileTokenRefreshPersist(file).load()).toBeNull();
  });
});

// ── sessionManager 接线（FR-TOKEN-03/04/05/07 的集成可观察面）──────────────────

describe('sessionManager 接调度器（FR-TOKEN-03/04/05/07）', () => {
  let stored: { username: string; password: string; accountKey: string; loginName: string; expiresAt: number };
  let clearOaLoginSpy: ReturnType<typeof vi.fn>;
  let resetSessionSpy: ReturnType<typeof vi.fn>;
  let clientLoginResults: OaLoginOutcome[];
  let loginGate: Promise<void> | null;
  let client: OaClient;
  let credentials: typeof CredentialStoreNs;
  let commitSession: ReturnType<typeof vi.fn>;
  let clearCookiesSpy: ReturnType<typeof vi.fn>;
  let persist: ReturnType<typeof makePersist>;
  let manager: ReturnType<typeof createHrOaSessionManager>;

  beforeEach(() => {
    stored = {
      username: 'u1',
      password: 'pw-not-a-real-secret',
      accountKey: 'p-seed',
      loginName: 'u1',
      expiresAt: start + 14 * 24 * 3_600_000,
    };
    clearOaLoginSpy = vi.fn(async () => {
      stored = { ...stored, expiresAt: 0 };
    });
    resetSessionSpy = vi.fn();
    clientLoginResults = [{ ok: true }];
    loginGate = null;
    client = {
      login: vi.fn(async (): Promise<OaLoginOutcome> => {
        if (loginGate) await loginGate;
        return clientLoginResults.shift() ?? { ok: true };
      }),
      getPersonProfile: vi.fn(async () => profile({ loginName: 'u1', personId: 'p-seed' })),
      resetSession: resetSessionSpy,
    };
    credentials = {
      OA_LOGIN_TTL_MS: 14 * 24 * 3_600_000,
      saveOaLogin: async () => {},
      loadOaLogin: async () => ({ ...stored }),
      loadOaLoginDetailed: async () =>
        stored.expiresAt === 0 ? ({ status: 'none' } as const) : ({ status: 'ok', record: { ...stored } } as const),
      clearOaLogin: clearOaLoginSpy as unknown as typeof CredentialStoreNs.clearOaLogin,
      resolveAccountKey: () => 'p-seed',
      saveOaProfileCache: async () => {},
      loadOaProfileCache: async () => ({
        accountKey: 'p-seed',
        loginName: 'u1',
        profile: profile({ loginName: 'u1', personId: 'p-seed' }),
      }),
      clearOaProfileCache: vi.fn(async () => {}),
      saveOaAvatarCache: async () => {},
      loadOaAvatarCache: async () => null,
      clearOaAvatarCache: vi.fn(async () => {}),
    } as unknown as typeof CredentialStoreNs;
    commitSession = vi.fn();
    clearCookiesSpy = vi.fn(async () => {});
    persist = makePersist(null);
    manager = createHrOaSessionManager({
      client,
      credentials,
      commitSession,
      now: () => Date.now(),
      clearCookies: clearCookiesSpy,
      tokenRefreshPersist: persist,
    });
  });

  function seedDuePlan(): void {
    persist.save({ last: start - TOKEN_REFRESH_PERIOD_MS, next: start });
  }

  it('FR-TOKEN-03：刷新成功与网络类失败都不调 UI 通知回调（onDidChange 零调用）', async () => {
    const listener = vi.fn();
    manager.onDidChange(listener);
    seedDuePlan();

    clientLoginResults = [{ ok: true }];
    await manager.tokenRefreshDue('timer');
    expect(listener).not.toHaveBeenCalled();

    // 网络类失败同样零界面变化（不提示、不落 offline——人还在主界面干活）。
    vi.setSystemTime(start + TOKEN_REFRESH_PERIOD_MS);
    seedDuePlan();
    clientLoginResults = [{ ok: false, kind: 'network_error' }];
    await manager.tokenRefreshDue('timer');
    expect(listener).not.toHaveBeenCalled();
    expect(manager.getState().status).toBe('signed-out'); // 初始状态未被刷新触碰
  });

  it('FR-TOKEN-05：刷新被拒（凭证类）强退——落 signed-out reason:expired、清凭证与计划', async () => {
    const listener = vi.fn();
    manager.onDidChange(listener);
    seedDuePlan();

    clientLoginResults = [{ ok: false, kind: 'wrong_credentials' }];
    await manager.tokenRefreshDue('timer');

    expect(listener).toHaveBeenCalledTimes(1);
    // entry:'token_refresh'（profile-menu PRD §11）：刷新被拒的强退带来源标记，渲染层
    // 据此记 logout(entry=token_refresh) 而非 session_check——整形状钉死，含新字段。
    expect(listener).toHaveBeenCalledWith({
      status: 'signed-out',
      reason: 'expired',
      entry: 'token_refresh',
    });
    expect(clearOaLoginSpy).toHaveBeenCalled();
    expect(resetSessionSpy).toHaveBeenCalled();
    expect(persist.clearSpy).toHaveBeenCalled();
  });

  it('FR-TOKEN-04：刷新进行中 whenRefreshIdle 挂起业务请求，刷新结束才放行', async () => {
    seedDuePlan();
    let releaseLogin: () => void = () => {};
    loginGate = new Promise<void>((resolve) => (releaseLogin = resolve));

    // 先让刷新进入 in-flight，再从业务侧扣闸——「刷新进行中发起的业务请求」。
    const due = manager.tokenRefreshDue('timer');
    await flushAsync();
    let released = false;
    const gate = manager.whenRefreshIdle().then(() => {
      released = true;
    });
    await flushAsync();
    expect(released).toBe(false);

    releaseLogin();
    await Promise.all([due, gate]);
    expect(released).toBe(true);
  });

  it('FR-TOKEN-07：登录成功起新周期，登出取消刷新计划并删除时间戳', async () => {
    // 登录成功 → 计划落盘（last=now，next=+12h）。
    await manager.login('u1', 'pw-not-a-real-secret');
    expect(persist.store).toEqual({
      last: start,
      next: start + TOKEN_REFRESH_PERIOD_MS,
    });

    // 登出 → persist.clear（时间戳删除）且此后触发不再打网络。
    await manager.logout();
    expect(persist.clearSpy).toHaveBeenCalled();
    expect(persist.store).toBeNull();

    clientLoginResults = [{ ok: true }];
    await manager.tokenRefreshDue('timer');
    expect(client.login).toHaveBeenCalledTimes(1); // 只有那次手动登录
  });

  it('启动静默重登不重置进行中的周期（重启后沿用同一周期）', async () => {
    // 上次成功 3h 前 → next 还有 9h。
    persist.save({ last: start - 3 * 3_600_000, next: start + 9 * 3_600_000 });
    await manager.startup();
    // 启动的静默重登成功也**不**把周期推到启动时刻（FR-TOKEN-01「不从启动起算」）。
    expect(persist.store).toEqual({ last: start - 3 * 3_600_000, next: start + 9 * 3_600_000 });

    // 计划缺失（升级后首跑）→ 启动成功补种，否则永不刷新。
    const persist2 = makePersist(null);
    const manager2 = createHrOaSessionManager({
      client,
      credentials,
      commitSession,
      now: () => Date.now(),
      clearCookies: vi.fn(async () => {}),
      tokenRefreshPersist: persist2,
    });
    await manager2.startup();
    expect(persist2.store).toEqual({
      last: start,
      next: start + TOKEN_REFRESH_PERIOD_MS,
    });
  });

  // ── Review Important 1：被弃/被取代的刷新尝试不得执行会话副作用（生命周期合同）──
  // 调度器的 settled 只护计划回写；runTokenRefresh 的 clearOaLogin / dropToSignedOut
  // 需要会话代次守卫。两条最小失败序列（登出→新登录被迟到的凭证类失败清掉；登出后
  // 迟到的失败翻掉 reason:'logout' 误弹「登录已过期」）先红后绿。

  it('迟到的凭证类失败不得清掉新登录的凭证、不得把人踢回 S1（代次守卫）', async () => {
    seedDuePlan();
    let releaseZombie: (o: OaLoginOutcome) => void = () => {};
    const zombieLogin = new Promise<OaLoginOutcome>((resolve) => (releaseZombie = resolve));
    vi.mocked(client.login).mockImplementationOnce(() => zombieLogin);

    const due = manager.tokenRefreshDue('timer');
    await flushAsync();
    expect(client.login).toHaveBeenCalledTimes(1);

    // 会话边界：登出 → 以新口令重新登录（新凭证落钥匙串、新会话落定）。
    await manager.logout();
    clearOaLoginSpy.mockClear();
    await manager.login('u1', 'new-password');
    expect(manager.getState().status).toBe('signed-in');

    // 被弃的刷新尝试迟到落定 wrong_credentials：不得清凭证、不得把新登录踢出。
    releaseZombie({ ok: false, kind: 'wrong_credentials' });
    await flushAsync();
    await due;
    expect(clearOaLoginSpy).not.toHaveBeenCalled();
    expect(manager.getState().status).toBe('signed-in');
  });

  it('登出后迟到的失败不得翻掉 reason:logout 误弹「登录已过期」（FR-HOME-03 Break B）', async () => {
    seedDuePlan();
    let releaseZombie: (o: OaLoginOutcome) => void = () => {};
    const zombieLogin = new Promise<OaLoginOutcome>((resolve) => (releaseZombie = resolve));
    vi.mocked(client.login).mockImplementationOnce(() => zombieLogin);

    const due = manager.tokenRefreshDue('timer');
    await flushAsync();
    await manager.logout();
    expect(manager.getState()).toEqual({ status: 'signed-out', reason: 'logout' });
    const listener = vi.fn();
    manager.onDidChange(listener);

    releaseZombie({ ok: false, kind: 'wrong_credentials' });
    await flushAsync();
    await due;
    // 自愿登出后不得再落 expired（toast「登录已过期」唯一来源），reason 必须停在 logout。
    expect(listener).not.toHaveBeenCalled();
    expect(manager.getState()).toEqual({ status: 'signed-out', reason: 'logout' });
    expect(clearOaLoginSpy).toHaveBeenCalledTimes(1); // 只有 logout 自己那次
  });

  it('登出后迟到的刷新成功不得留下门户 cookie（persist:hr-oa 账号隔离）', async () => {
    seedDuePlan();
    let releaseZombie: (o: OaLoginOutcome) => void = () => {};
    const zombieLogin = new Promise<OaLoginOutcome>((resolve) => (releaseZombie = resolve));
    vi.mocked(client.login).mockImplementationOnce(() => zombieLogin);

    const due = manager.tokenRefreshDue('timer');
    await flushAsync();
    await manager.logout();
    clearCookiesSpy.mockClear();

    // 迟到的成功把旧会话 cookie 重新种进 jar——必须收口清掉，旧账号会话不得滞留。
    releaseZombie({ ok: true });
    await flushAsync();
    await due;
    expect(clearCookiesSpy).toHaveBeenCalled();
    expect(persist.store).toBeNull(); // 计划仍随 logout 删除，不被迟到成功复活
  });

  it('失败分流表补 5xx 行：网关 5xx → network_error 保计划退避、不强退（FR-TOKEN-06）', async () => {
    seedDuePlan();
    // 端到端：真 OaClient + 假 transport——登录 POST 回 502（网关错误、无 login_error
    // 信号）→ 判 network_error（保凭证）→ 调度器按退避收口，不进 rejected 强退。
    const transport: OaTransport = {
      request: (input) =>
        Promise.resolve(
          input.path.includes('session.jsp')
            ? {
                status: 200,
                headers: {},
                body: 'window.getSM2PubKey = function(){ return "00"; }',
                finalUrl: input.path,
              }
            : { status: 502, headers: {}, body: 'Bad Gateway', finalUrl: input.path },
        ),
    };
    const gateway5xx = createOaClient({
      baseUrl: 'http://oa.test',
      transport,
      fetchPubkey: async () => null,
    });
    const manager5xx = createHrOaSessionManager({
      client: gateway5xx,
      credentials,
      commitSession,
      now: () => Date.now(),
      clearCookies: clearCookiesSpy,
      tokenRefreshPersist: persist,
    });
    const listener = vi.fn();
    manager5xx.onDidChange(listener);

    await manager5xx.tokenRefreshDue('timer');

    expect(listener).not.toHaveBeenCalled();
    expect(clearOaLoginSpy).not.toHaveBeenCalled();
    expect(persist.clearSpy).not.toHaveBeenCalled();
    expect(persist.store).toEqual({
      last: start - TOKEN_REFRESH_PERIOD_MS,
      next: start + MINUTE_MS, // 1 分钟退避，而不是「成功」推 12h
    });
  });
});
