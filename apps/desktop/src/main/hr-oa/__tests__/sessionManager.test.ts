/**
 * 测试价值
 * - 生产入口与可观察结果：createHrOaSessionManager() 的 startup() 静默重登分流（表驱动六行：
 *   无凭证 / 成功 / wrong_credentials / network_error / timeout / 资料拉取失败）——只认
 *   wrong_credentials、locked 清钥匙串，network_error、timeout 保留凭证并进 offline（home 仍可读，
 *   commitSession('hr', key)）；logout() 清凭证 + commitSession('signed-out') + client.resetSession()；
 *   login() 手输账号写入经 resolveAccountKey 冻结的新键，显式登录失败只回 { error } 不改状态与
 *   存量凭证（Ruling 3：登录页留在原地出内联错误，只有 startup 静默重登会产生 offline）。
 *   失效原因分流（FR-SESSION-02 冷启动 toast 来源）：凭证类失败 / TTL 过期落
 *   `{status:'signed-out', reason:'expired'}`，主动登出 `reason:'logout'`，无凭证首启无 reason；
 *   离线契约（设计 §4.2）：登录成功落本地资料缓存（**无口令**），offline 启动优先用缓存资料，
 *   networkRecovered() 在网络恢复后静默重登回 signed-in。
 * - Bug／规则依据：登录门禁计划 Task 2 Step 5/6 失败分流表；Ruling 3 显式登录失败不进 offline；
 *   「资料失败不阻断登录，键退化用已缓存的冻结键」；VPN 抖动（网络类失败）绝不能清凭证把人锁在
 *   门外；logout 必须 client.resetSession()（OA client 在内存里记着口令做会话恢复，不复位会跨
 *   登出口令泄漏）；集成设计 §4.2（wrong_credentials/locked → 清钥匙串 + toast「登录已过期」；
 *   network_error/timeout → 保留凭证离线只读 + 网络恢复静默重登 + 资料本地缓存）。账号隔离
 *   P0（真机 2026-11-01 实证）：登出/凭证失效只清钥匙串与内存会话、不清门户 cookie jar 时，
 *   旧会话残留在 persist:hr-oa 分区——下一个账号的错口令会被旧会话「判成功」落进前一个
 *   账号。修法合同：signed-out 收口必须清门户 cookie（clearCookies 回调），且清完 cookie
 *   才落状态（迟清会误删下一次登录种下的新会话）。
 * - 现有覆盖缺口：新模块，此前没有 HR 会话生命周期与失败分流覆盖；oaClient.test.ts 只覆盖单次
 *   登录 outcome，不覆盖凭证去留与会话状态。评审 Finding 1/2 前：startup 不报告 signed-out
 *   原因（冷启动失效无法弹 toast）、无资料缓存、无网络恢复重登。账号隔离：此前
 *   clearCookies 接线挂在 bootstrap 的 onDidChange 上（fire-and-forget），sessionManager
 *   生命周期本身不清 cookie，也无任何测试钉住这条收口。
 * - 最小失败输入：见表驱动 startup 六行 + 手输新账号 / 冻结键 / 显式失败四类 / logout +
 *   TTL 过期 reason / networkRecovered 三态 / 资料缓存与无口令；凭证层用真实 credentialStore
 *   （内存 secret IO + mkdtemp 映射表），client 全 fake。账号隔离见「portal cookie 收口」：
 *   注入 clearCookies fake，断言登出/凭证类失效调它且先于状态落定（顺序错了 = 清 cookie
 *   迟到落地会误删下一次登录的新会话）。
 * - tier：unit（无真实网络；client/commitSession 注入 fake，凭证走真实模块 + 假 IO）。
 * - 实测耗时：单文件 ~2.0s 墙钟（pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/sessionManager.test.ts）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as credentialStoreNs from '../credentialStore.js';
import {
  OA_LOGIN_TTL_MS,
  clearOaLogin,
  loadOaLogin,
  resolveAccountKey,
  saveOaLogin,
  type OaCredentialDeps,
} from '../credentialStore.js';
import type { SecretStorageIo } from '../../secrets/providerSecretStore.js';
import type { OaLoginFailure, OaLoginOutcome } from '../errors.js';
import type { OaClient } from '../oaClient.js';
import type { PersonProfile } from '../profile.js';
import { createHrOaSessionManager, type HrOaAuthState } from '../sessionManager.js';

const PASSWORD = 'pw-not-a-real-secret';

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

const blank = profile();

/** 首登资料（无 loginName 干扰）：冻结键 = personId 'p-seed'。 */
const seededProfile = profile({ loginName: 'u1', personId: 'p-seed' });
/** 重登时的新资料：personId 变化不得顶掉冻结键。 */
const freshProfile = profile({ loginName: 'u1', personId: 'p9' });

function createMemoryIo(): SecretStorageIo {
  const store = new Map<string, string>();
  return {
    isAvailable: () => true,
    read: (k) => (store.has(k) ? (store.get(k) as string) : null),
    write: (k, v) => {
      store.set(k, v);
      return true;
    },
    remove: (k) => {
      store.delete(k);
      return { success: true };
    },
    list: () => [...store.keys()],
  };
}

let clock = 10_000;
let tempDir: string;
let testDeps: OaCredentialDeps;
let clearOaLoginSpy: ReturnType<typeof vi.fn>;
let credentials: typeof import('../credentialStore.js');
let commitSession: ReturnType<typeof vi.fn>;
let clearCookiesSpy: ReturnType<typeof vi.fn>;
let client: OaClient;
let clientLogin: OaLoginOutcome;
let clientProfile: PersonProfile | Error;
let resetSession: ReturnType<typeof vi.fn>;

/** 用真实 credentialStore（注入假 IO）做凭证层，按模块命名空间形状适配给 sessionManager。 */
function makeCredentials(): typeof import('../credentialStore.js') {
  clearOaLoginSpy = vi.fn(async () => clearOaLogin(testDeps));
  return {
    OA_LOGIN_TTL_MS,
    saveOaLogin: (input) => saveOaLogin(input, testDeps),
    loadOaLogin: (now?: number) => loadOaLogin(now, testDeps),
    // 失效原因分流（Finding 1）与离线资料缓存（Finding 2）走同一注入层。
    loadOaLoginDetailed: (now?: number) => credentialStoreNs.loadOaLoginDetailed(now, testDeps),
    saveOaProfileCache: (input) => credentialStoreNs.saveOaProfileCache(input, testDeps),
    loadOaProfileCache: () => credentialStoreNs.loadOaProfileCache(testDeps),
    clearOaLogin: clearOaLoginSpy as typeof clearOaLogin,
    resolveAccountKey: (loginName, forProfile) => resolveAccountKey(loginName, forProfile, testDeps),
  };
}

function makeManager() {
  return createHrOaSessionManager({
    client,
    credentials,
    commitSession,
    now: () => clock,
    clearCookies: clearCookiesSpy,
  });
}

async function seedStoredLogin(): Promise<void> {
  await saveOaLogin(
    { username: 'u1', password: PASSWORD, profile: seededProfile, now: clock },
    testDeps,
  );
}

beforeEach(() => {
  clock = 10_000;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-session-manager-test-'));
  testDeps = {
    secretIo: createMemoryIo(),
    mappingFilePath: path.join(tempDir, 'hr-oa-account-map.json'),
    now: () => clock,
  };
  credentials = makeCredentials();
  commitSession = vi.fn();
  clearCookiesSpy = vi.fn(async () => {});
  clientLogin = { ok: true };
  clientProfile = freshProfile;
  resetSession = vi.fn();
  client = {
    login: vi.fn(async () => clientLogin),
    getPersonProfile: vi.fn(async () => {
      if (clientProfile instanceof Error) throw clientProfile;
      return clientProfile;
    }),
    resetSession,
  };
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('startup silent re-login', () => {
  const cases: Array<{
    name: string;
    seed: boolean;
    login: OaLoginOutcome;
    profile: PersonProfile | 'reject';
    expected: HrOaAuthState;
    expectedCleared: boolean;
    expectedCommit: unknown[] | null;
  }> = [
    {
      name: 'no stored credential stays signed-out',
      seed: false,
      login: { ok: true },
      profile: freshProfile,
      expected: { status: 'signed-out' },
      expectedCleared: false,
      expectedCommit: null,
    },
    {
      name: 'login and profile success signs in under the frozen key',
      seed: true,
      login: { ok: true },
      profile: freshProfile,
      expected: { status: 'signed-in', accountKey: 'p-seed', profile: freshProfile },
      expectedCleared: false,
      expectedCommit: ['hr', 'p-seed'],
    },
    {
      name: 'wrong_credentials clears the credential and commits signed-out as an expiry',
      seed: true,
      login: { ok: false, kind: 'wrong_credentials' },
      profile: freshProfile,
      // reason:'expired' 是渲染层冷启动弹「登录已过期」的唯一来源（FR-SESSION-02）。
      expected: { status: 'signed-out', reason: 'expired' },
      expectedCleared: true,
      expectedCommit: ['signed-out'],
    },
    {
      name: 'network_error keeps the credential and goes offline with a readable home',
      seed: true,
      login: { ok: false, kind: 'network_error' },
      profile: freshProfile,
      expected: { status: 'offline', accountKey: 'p-seed', profile: blank },
      expectedCleared: false,
      expectedCommit: ['hr', 'p-seed'],
    },
    {
      name: 'timeout keeps the credential and goes offline like network_error',
      seed: true,
      login: { ok: false, kind: 'timeout' },
      profile: freshProfile,
      expected: { status: 'offline', accountKey: 'p-seed', profile: blank },
      expectedCleared: false,
      expectedCommit: ['hr', 'p-seed'],
    },
    {
      name: 'profile fetch failure still signs in under the cached frozen key',
      seed: true,
      login: { ok: true },
      profile: 'reject',
      expected: { status: 'signed-in', accountKey: 'p-seed', profile: blank },
      expectedCleared: false,
      expectedCommit: ['hr', 'p-seed'],
    },
  ];

  it.each(cases)('$name', async (c) => {
    if (c.seed) await seedStoredLogin();
    clientLogin = c.login;
    clientProfile = c.profile === 'reject' ? new Error('profile down') : c.profile;

    const manager = makeManager();
    const state = await manager.startup();

    expect(state).toEqual(c.expected);
    expect(manager.getState()).toEqual(c.expected);
    if (c.seed) {
      // 静默重登必须喂已存凭证给 client。
      expect(client.login).toHaveBeenCalledWith('u1', PASSWORD);
    }
    if (c.expectedCleared) {
      expect(clearOaLoginSpy).toHaveBeenCalled();
      expect(await loadOaLogin(clock, testDeps)).toBeNull();
    } else {
      expect(clearOaLoginSpy).not.toHaveBeenCalled();
      if (c.seed) expect(await loadOaLogin(clock, testDeps)).not.toBeNull();
    }
    if (c.expectedCommit === null) expect(commitSession).not.toHaveBeenCalled();
    else expect(commitSession.mock.calls).toEqual([c.expectedCommit]);
  });

  it('does not fork the frozen mapping key when the refreshed profile lacks loginName', async () => {
    // 首登 username='u1' 但资料 loginName='login-u1'：映射键按 loginName 冻结。
    clientProfile = profile({ loginName: 'login-u1' });
    const manager = makeManager();
    await manager.login('u1', PASSWORD);
    expect(await loadOaLogin(clock, testDeps)).toMatchObject({
      loginName: 'login-u1',
      accountKey: 'login-u1',
    });

    // 静默重登时资料缺 loginName（页面解析异常）：save 侧不得另起 'u1' 映射键重解账号键，
    // 否则存量凭证的 accountKey 与会话状态分叉，下轮启动换数据分区。
    clientLogin = { ok: true };
    clientProfile = profile({ personId: 'p9' });
    const state = await manager.startup();
    expect(state).toMatchObject({ status: 'signed-in', accountKey: 'login-u1' });
    expect(await loadOaLogin(clock, testDeps)).toMatchObject({ accountKey: 'login-u1' });
  });

  it('TTL-expired stored login settles signed-out with an expiry reason and drops the ciphertext', async () => {
    // Finding 1：14 天 TTL 过期与凭证类失败同为「曾有凭证的失效」→ reason:'expired'
    // （FR-SESSION-02 要弹「登录已过期」）；与「首启无凭证」（表首行，无 reason）分流。
    await seedStoredLogin();
    clock += OA_LOGIN_TTL_MS;
    const manager = makeManager();
    const state = await manager.startup();
    expect(state).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(clearOaLoginSpy).not.toHaveBeenCalled();
    expect(await loadOaLogin(clock, testDeps)).toBeNull();
    expect(client.login).not.toHaveBeenCalled();
    // 与凭证类失败同口径：曾有凭证的失效落定 signed-out 会话（无凭证首启才不 commit）。
    expect(commitSession.mock.calls).toEqual([['signed-out']]);
  });
});

describe('offline profile cache（设计 §4.2 本地缓存）', () => {
  it('login success persists the profile cache and offline startup prefers it over blank', async () => {
    const manager = makeManager();
    clientProfile = profile({ loginName: 'u1', personId: 'p-seed', name: '张三' });
    await manager.login('u1', PASSWORD);

    // 模拟重启：网络类失败 → offline 应带缓存资料（用户还认得出自己的名字），不是 blank。
    clientLogin = { ok: false, kind: 'network_error' };
    const restarted = makeManager();
    const state = await restarted.startup();
    expect(state).toEqual({
      status: 'offline',
      accountKey: 'p-seed',
      profile: profile({ loginName: 'u1', personId: 'p-seed', name: '张三' }),
    });
  });

  it('offline startup falls back to blank when the cache belongs to another account', async () => {
    const manager = makeManager();
    clientProfile = profile({ loginName: 'u1', personId: 'p-seed', name: '张三' });
    await manager.login('u1', PASSWORD);
    // 换账号但写缓存失败后的残骸场景：缓存键对不上时宁可 blank，不得串号展示别人的资料。
    await credentialStoreNs.saveOaProfileCache(
      { accountKey: 'other-key', loginName: 'other', profile: profile({ loginName: 'other', name: '李四' }) },
      testDeps,
    );
    clientLogin = { ok: false, kind: 'timeout' };
    const state = await makeManager().startup();
    expect(state).toEqual({ status: 'offline', accountKey: 'p-seed', profile: blank });
  });

  it('the profile cache never contains the password', async () => {
    const manager = makeManager();
    clientProfile = profile({ loginName: 'u1', personId: 'p-seed' });
    await manager.login('u1', PASSWORD);
    const raw = fs.readFileSync(path.join(tempDir, 'hr-oa-profile-cache.json'), 'utf-8');
    expect(raw).not.toContain(PASSWORD);
    expect(raw.toLowerCase()).not.toContain('password');
    expect(raw).toContain('p-seed');
  });
});

describe('networkRecovered（网络恢复静默重登，设计 §4.2）', () => {
  it('re-runs the silent re-login from offline and settles signed-in', async () => {
    await seedStoredLogin();
    const manager = makeManager();
    clientLogin = { ok: false, kind: 'network_error' };
    await manager.startup();
    expect(manager.getState().status).toBe('offline');

    clientLogin = { ok: true };
    clientProfile = freshProfile;
    const state = await manager.networkRecovered();
    expect(state).toEqual({ status: 'signed-in', accountKey: 'p-seed', profile: freshProfile });
    expect(manager.getState()).toEqual(state);
    expect(client.login).toHaveBeenLastCalledWith('u1', PASSWORD);
  });

  it('stays offline (credential kept) when the network is still down', async () => {
    await seedStoredLogin();
    const manager = makeManager();
    clientLogin = { ok: false, kind: 'timeout' };
    await manager.startup();
    clientLogin = { ok: false, kind: 'network_error' };
    const state = await manager.networkRecovered();
    expect(state).toMatchObject({ status: 'offline', accountKey: 'p-seed' });
    expect(await loadOaLogin(clock, testDeps)).not.toBeNull();
  });

  it('clears a dead credential and settles expired signed-out', async () => {
    await seedStoredLogin();
    const manager = makeManager();
    clientLogin = { ok: false, kind: 'network_error' };
    await manager.startup();
    clientLogin = { ok: false, kind: 'locked' };
    const state = await manager.networkRecovered();
    expect(state).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(clearOaLoginSpy).toHaveBeenCalled();
    expect(await loadOaLogin(clock, testDeps)).toBeNull();
  });

  it('is a no-op when not offline', async () => {
    const manager = makeManager();
    clientProfile = profile({ loginName: 'u1' });
    await manager.login('u1', PASSWORD);
    clientLogin = { ok: false, kind: 'wrong_credentials' };
    await manager.networkRecovered();
    // 只有显式登录那一次打过网络；signed-in 态的「恢复」不得重登（更不得被误清凭证）。
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(manager.getState().status).toBe('signed-in');
  });
});

describe('manual login', () => {
  it('stores the frozen key for a newly typed account and replaces the previous one', async () => {
    const manager = makeManager();
    clientProfile = profile({ loginName: 'u1' });
    const first = await manager.login('u1', PASSWORD);
    expect(first).toMatchObject({ status: 'signed-in', accountKey: 'u1' });
    expect(await loadOaLogin(clock, testDeps)).toMatchObject({ username: 'u1', accountKey: 'u1' });

    clientProfile = profile({ loginName: 'u2', personId: 'p2' });
    const second = await manager.login('u2', 'pw-two');
    expect(second).toMatchObject({ status: 'signed-in', accountKey: 'p2' });
    expect(await loadOaLogin(clock, testDeps)).toMatchObject({ username: 'u2', accountKey: 'p2' });
    expect(commitSession.mock.calls.at(-1)).toEqual(['hr', 'p2']);
  });

  it('keeps the frozen key on re-login and lets personId only reach profile fields', async () => {
    const manager = makeManager();
    clientProfile = profile({ loginName: 'u1' });
    await manager.login('u1', PASSWORD);
    clientProfile = profile({ loginName: 'u1', personId: 'p9' });
    const state = await manager.login('u1', PASSWORD);
    // personId 只进资料字段，账号键仍是首次冻结的 'u1'。
    expect(state).toMatchObject({
      status: 'signed-in',
      accountKey: 'u1',
      profile: { personId: 'p9' },
    });
  });

  it('does not fork the frozen mapping key when an explicit re-login cannot fetch the profile', async () => {
    // 首登 username='u1' 但资料 loginName='login-u1'：映射键按 loginName 冻结。
    clientProfile = profile({ loginName: 'login-u1' });
    const manager = makeManager();
    await manager.login('u1', PASSWORD);
    expect(await loadOaLogin(clock, testDeps)).toMatchObject({
      loginName: 'login-u1',
      accountKey: 'login-u1',
    });

    // 显式重登时资料页不可用（profile reject）：不得退化成用 username 'u1' 另起新键，
    // 否则 dataOwner 换键、本地数据分区被孤儿化（Review Focus #3 账号键漂移）。
    clientProfile = new Error('profile down');
    const state = await manager.login('u1', PASSWORD);
    expect(state).toMatchObject({ status: 'signed-in', accountKey: 'login-u1' });
    expect(await loadOaLogin(clock, testDeps)).toMatchObject({
      loginName: 'login-u1',
      accountKey: 'login-u1',
    });
  });

  it('keeps the frozen key across logout when the re-login cannot fetch the profile', async () => {
    clientProfile = profile({ loginName: 'login-u1' });
    const manager = makeManager();
    await manager.login('u1', PASSWORD);
    await manager.logout();
    // clearOaLogin 的承诺：登出（映射表保留、凭证清除）后重登不得换键。仅凭 username、
    // 资料页又不可用时也必须仍命中冻结键，不得另起 'u1' 新键。
    clientProfile = new Error('profile down');
    const state = await manager.login('u1', PASSWORD);
    expect(state).toMatchObject({ status: 'signed-in', accountKey: 'login-u1' });
    expect(await loadOaLogin(clock, testDeps)).toMatchObject({ accountKey: 'login-u1' });
  });

  it.each(['wrong_credentials', 'locked', 'network_error', 'timeout'] as const)(
    'explicit login %s returns an inline error and leaves state and stored credential untouched',
    async (kind: OaLoginFailure) => {
      await seedStoredLogin();
      const manager = makeManager();
      clientLogin = { ok: false, kind };
      const result = await manager.login('u1', 'bad-' + kind);
      // Ruling 3：显式登录失败只回 { error }，登录页留在原地；不产生 offline、不动存量凭证
      // （被测的是手输口令，不是钥匙串里那份；误清会把 offline home 的人锁在门外）。
      expect(result).toEqual({ error: kind });
      expect(manager.getState()).toEqual({ status: 'signed-out' });
      expect(clearOaLoginSpy).not.toHaveBeenCalled();
      expect(await loadOaLogin(clock, testDeps)).not.toBeNull();
      expect(commitSession).not.toHaveBeenCalled();
    },
  );
});

describe('logout', () => {
  it('clears the credential, resets the OA client session and commits signed-out', async () => {
    const manager = makeManager();
    clientProfile = profile({ loginName: 'u1', personId: 'p9' });
    await manager.login('u1', PASSWORD);
    await manager.logout();
    expect(resetSession).toHaveBeenCalled();
    expect(await loadOaLogin(clock, testDeps)).toBeNull();
    // reason:'logout' = 自愿登出：兄弟窗口据此抑制失效 toast（Finding 4）。
    expect(manager.getState()).toEqual({ status: 'signed-out', reason: 'logout' });
    expect(commitSession.mock.calls.at(-1)).toEqual(['signed-out']);
  });
});

describe('portal cookie 收口（P0 账号隔离，设计 §4.2）', () => {
  it('logout empties the portal cookie jar before settling signed-out', async () => {
    // 失效后果：登出不清门户 cookie，A 的会话残留在 persist:hr-oa——B 输错口令会被
    // 蓝凌按 A 的存活会话 302 到 `/`、被分类「登录成功」落进 A 的账号（真机实证）。
    // 顺序合同：清 cookie 必须先于状态落定（commitSession 标记）——落定后渲染层可
    // 立即发起新登录，迟到落地的清 cookie 会误删新会话。
    const order: string[] = [];
    clearCookiesSpy = vi.fn(async () => {
      order.push('clearCookies');
    });
    commitSession = vi.fn(() => {
      order.push('commitSession');
    });
    const manager = makeManager();
    clientProfile = profile({ loginName: 'u1', personId: 'p9' });
    await manager.login('u1', PASSWORD);
    order.length = 0; // 只看登出这一次的收口顺序

    await manager.logout();

    expect(clearCookiesSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['clearCookies', 'commitSession']);
  });

  it('credential-class silent re-login failure clears the portal cookie jar', async () => {
    // 失效后果：startup 静默重登撞 wrong_credentials 清了钥匙串却不清 cookie 时，
    // 失效的门户会话继续存活，下一个账号的登录判定被它污染。
    await seedStoredLogin();
    clientLogin = { ok: false, kind: 'wrong_credentials' };
    const manager = makeManager();

    const state = await manager.startup();

    expect(state).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(clearCookiesSpy).toHaveBeenCalledTimes(1);
  });

  it('TTL-expired startup also clears the portal cookie jar', async () => {
    // 失效后果：曾有凭证的失效（TTL 过期、密文已由 load 侧清掉）同样不得把旧门户
    // 会话留在 jar 里跨账号。
    await seedStoredLogin();
    clock += OA_LOGIN_TTL_MS;
    const manager = makeManager();

    const state = await manager.startup();

    expect(state).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(clearCookiesSpy).toHaveBeenCalledTimes(1);
    expect(client.login).not.toHaveBeenCalled();
  });
});

describe('onDidChange', () => {
  it('notifies listeners on state transitions and the returned disposer unsubscribes', async () => {
    const manager = makeManager();
    const seen: HrOaAuthState[] = [];
    const dispose = manager.onDidChange((s) => seen.push(s));
    clientProfile = profile({ loginName: 'u1' });
    await manager.login('u1', PASSWORD);
    expect(seen).toEqual([{ status: 'signed-in', accountKey: 'u1', profile: profile({ loginName: 'u1' }) }]);
    dispose();
    await manager.logout();
    expect(seen).toHaveLength(1);
  });
});
