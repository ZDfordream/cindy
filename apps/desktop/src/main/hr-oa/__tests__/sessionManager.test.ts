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
  loadOaAvatarCache,
  loadOaProfileCache,
  resolveAccountKey,
  saveOaAvatarCache,
  saveOaLogin,
  saveOaProfileCache,
  type OaCredentialDeps,
} from '../credentialStore.js';
import type { SecretStorageIo } from '../../secrets/providerSecretStore.js';
import type { OaLoginFailure, OaLoginOutcome } from '../errors.js';
import { createOaClient, type OaResponse, type OaTransport } from '../oaClient.js';
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
    clearOaProfileCache: () => credentialStoreNs.clearOaProfileCache(testDeps),
    saveOaAvatarCache: (input) => credentialStoreNs.saveOaAvatarCache(input, testDeps),
    loadOaAvatarCache: (key) => credentialStoreNs.loadOaAvatarCache(key, testDeps),
    clearOaAvatarCache: () => credentialStoreNs.clearOaAvatarCache(testDeps),
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

  it('FR-LOGOUT-03 清理清单：登出清资料缓存与头像缓存（保留映射表与模型配置）', async () => {
    // 失效后果：登出只清钥匙串时，资料缓存 / 头像缓存跨账号残留在 userData 根——
    // 下一账号首启的离线兜底或头像取图可能短暂露出上一人的信息（FR-LOGOUT-03
    // 明确要求登出清「个人信息缓存与头像缓存」）。映射表保留（登出再登不得换键）。
    const manager = makeManager();
    clientProfile = profile({ loginName: 'u1', personId: 'p9' });
    await manager.login('u1', PASSWORD);
    await saveOaAvatarCache(
      { key: 'p9|1', contentType: 'image/png', bytes: new Uint8Array([1, 2]) },
      testDeps,
    );
    expect(await loadOaProfileCache(testDeps)).not.toBeNull();
    expect(await loadOaAvatarCache('p9|1', testDeps)).not.toBeNull();

    await manager.logout();

    expect(await loadOaProfileCache(testDeps)).toBeNull();
    expect(await loadOaAvatarCache('p9|1', testDeps)).toBeNull();
    // 映射表（冻结键）不在清理清单里：clearOaLogin 的键不漂移承诺仍成立。
    expect(clearOaLoginSpy).toHaveBeenCalled();
  });

  it('FR-LOGOUT-05 同样清理：凭证类失效强退也清资料缓存与头像缓存', async () => {
    // 登录态失效强制退出与手动退出同一清理清单（草稿除外——失效保留草稿是
    // FR-SESSION-02 的渲染层行为）。凭证类 silent 重登失败落 reason:'expired'。
    await saveOaProfileCache(
      { accountKey: 'u1', loginName: 'u1', profile: profile({ loginName: 'u1', personId: 'p9' }) },
      testDeps,
    );
    await saveOaAvatarCache(
      { key: 'p9|1', contentType: 'image/png', bytes: new Uint8Array([1, 2]) },
      testDeps,
    );
    await seedStoredLogin();
    clientLogin = { ok: false, kind: 'wrong_credentials' };
    const manager = makeManager();

    const state = await manager.startup();

    expect(state).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(await loadOaProfileCache(testDeps)).toBeNull();
    expect(await loadOaAvatarCache('p9|1', testDeps)).toBeNull();
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

/**
 * 冷启动静默重登 SC-3 回归（计划 Task 1 两条，profile-menu §4.3）。
 *
 * 四项说明：
 * - 生产入口与可观察结果：`createHrOaSessionManager().startup()` 组合**真实**
 *   `createOaClient` + 建模蓝凌 cookie 合同的 portal-jar transport，并让凭证层
 *   secret IO 复现真机冷启动条件（密文在盘、首读读不出——safeStorage 后端未就绪 /
 *   解密瞬时失败，真机日志 `credential encryption backend unavailable`）：
 *   (a) 钥匙串有未过期凭证、cookie jar 为空（OA 会话 cookie 是 session cookie，
 *   应用退出即失效，冷启动恒此态）→ 重试读到凭证后必须落 `signed-in`、
 *   `commitSession('hr', accountKey)`，绝不落 `signed-out` 回 S1；
 *   (b) 凭证在、门户网络不可达 → 落 `offline` + `commitSession('hr', accountKey)`
 *   且钥匙串凭证保留（`loadOaLogin()` 仍非 null、不调 clearOaLogin）。
 * - Bug／规则依据：FR-SESSION-01 / SC-3「下次启动校验有效则直接进首页，不出现
 *   S1、S2」；§4.4 实测 OA 会话 cookie 无 Max-Age，重启后 jar 必空——启动不得依赖
 *   cookie 存在；失败分流 Ruling 6：网络类失败保留凭证、离线进首页。根因（真机
 *   2026-11-01 日志 + 「凭证在盘却回 S1、welcome_view from=launch」签名）：
 *   `loadOaLoginDetailed` 把「密文在盘但暂时读不出」折成 `{status:'none'}`（无凭证
 *   首启），`startup()` 因此根本走不到 `silentRelogin`；读出垃圾时更折成 `expired`
 *   并**顺手删密文**（清凭证）。authManager 早已为此立过界（#1687：只有「加密可用
 *   且文件确实不在」才能当凭证被清，其余按瞬时失败）。
 * - 现有覆盖缺口：表驱动 startup 六行走 fake client + 恒可读的内存 IO，既不经过
 *   oaClient 的 clearCookies → 提交 → 判定链，也建模不了「密文在盘、首读读不出」
 *   这一真机冷启动态；SC-3（重启直接进首页、cookie 不在 / 首读抖动仍能进首页）
 *   此前无任何用例钉住。
 * - 最小失败输入：seed 凭证后让 secret IO 首读回 null（后端未就绪）或垃圾（解密
 *   异常）一次、次读回正本；(a) 叠 `initialSessionAlive:false` 的 portal-jar
 *   transport + 正确口令 → 断言 `signed-in` / `commitSession('hr', accountKey)`；
 *   (b) 叠 transport 全拒（网络不可达）→ 断言 `offline` + `commitSession('hr',
 *   accountKey)` + `loadOaLogin()` 非 null。旧实现首读抖动即判无凭证 → 落
 *   `signed-out`（垃圾首读还清凭证）。review Finding 1 补三类：(c) 读不出**持续**
 *   整轮重试 → 仍必须按资料缓存冻结键落 `offline` + `commitSession('hr', key)`
 *   （缓存缺失才退 signed-out 且不 commit、不清凭证）；(d) 重试之间必须有**非零
 *   退避**（注入 `wait` 记录，零间隔连打盖不住钥匙串未就绪窗口）；(e) 窗口聚焦触发
 *   `retryCredentialLoad`——钥匙串恢复后从 offline 回 `signed-in`，无待恢复时零动作。
 *   tier：unit（无真实网络，transport 注入 fake，凭证层真实模块 + 内存 IO）。
 *   实测耗时：单文件 ~1.5s。
 */
describe('startup silent re-login（SC-3 冷启动回归：不依赖 cookie jar）', () => {
  const OA_BASE = 'http://oa.test';
  const SM2_PUBKEY =
    '04' +
    '32c4ae2c1f1981195f9904466a39c9948fe30bbff2660be1715a4589334c74c7' +
    'bc3736a2f4f6779c59bdcee36b692153d0a9877cc62a474002df32e52139f0a0';

  type PortalRequest = {
    method: 'GET' | 'POST';
    path: string;
    params?: Record<string, string>;
    form?: Record<string, string>;
  };

  /** 注入 `wait` 的调用记录（ms）：重试退避合同的可观察面；测试里不做真实等待。 */
  let waitCalls: number[];

  /**
   * 真机冷启动的凭证读条件（2026-11-01 日志：每个启动都出现
   * `credential encryption backend unavailable { appReady:false }`）：密文在盘
   * （`list()` 认得），但**首读**读不出——后端未就绪回 null，或解密瞬时异常回
   * 垃圾；**次读**恢复正常。旧实现把首读结果直接当终局。
   */
  function blipFirstRead(kind: 'null' | 'garbage'): void {
    const original = testDeps.secretIo.read.bind(testDeps.secretIo);
    let calls = 0;
    testDeps.secretIo.read = (key: string) => {
      calls += 1;
      if (calls === 1) return kind === 'null' ? null : '{not-json';
      return original(key);
    };
  }

  /**
   * 读不出**持续**到整轮重试耗尽（钥匙串未就绪窗口长于退避预算的形态）；`down`
   * 翻回 false 即恢复可读——聚焦恢复用例用它模拟「稍后钥匙串回来了」。
   */
  function holdReads(flag: { down: boolean }, kind: 'null' | 'garbage'): void {
    const original = testDeps.secretIo.read.bind(testDeps.secretIo);
    testDeps.secretIo.read = (key: string) => {
      if (flag.down) return kind === 'null' ? null : '{not-json';
      return original(key);
    };
  }

  /**
   * 蓝凌 cookie 合同的 jar 建模（真机 2026-11-01 实证 + §4.4 会话 cookie 测量）：
   * `sessionAlive` = jar 里是否有存活会话。登录 POST 现场 jar 空（冷启动恒此态，
   * session cookie 退出即失效）就按本次口令判成败；jar 有存活会话则 302 `/`
   * （掩码形态）。资料 GET 需要存活会话，否则弹 anonym.jsp。`loginPosts()` 在
   * request 入口计数（unreachable 拒绝前也计入）——钉「不得发起登录尝试」。
   */
  function makePortalJarTransport(opts: {
    initialSessionAlive: boolean;
    unreachable?: boolean;
  }): {
    transport: OaTransport;
    jar: { sessionAlive: boolean };
    clearCookies: () => Promise<void>;
    loginPosts: () => number;
    setUnreachable: (value: boolean) => void;
  } {
    const jar = { sessionAlive: opts.initialSessionAlive };
    let unreachable = opts.unreachable ?? false;
    let loginPostCount = 0;
    const respond = (input: PortalRequest): OaResponse => {
      if (input.method === 'GET' && input.path.includes('session.jsp')) {
        return {
          status: 200,
          headers: {},
          body: `window.getSM2PubKey = function(){ return "${SM2_PUBKEY}"; }`,
          finalUrl: `${OA_BASE}/resource/js/session.jsp`,
        };
      }
      if (input.method === 'POST' && input.path.includes('j_acegi_security_check')) {
        if (jar.sessionAlive) {
          // 旧会话掩码形态：无视口令直接 302 `/`（P0 账号隔离实证）。
          return { status: 302, headers: { location: '/' }, body: '', finalUrl: input.path };
        }
        // fresh jar：按本次凭证判成败。本用例只喂正确口令——登录成功种下会话。
        jar.sessionAlive = true;
        return { status: 302, headers: { location: '/' }, body: '', finalUrl: input.path };
      }
      if (input.method === 'GET' && input.path.includes('setting.do')) {
        if (!jar.sessionAlive) {
          return {
            status: 200,
            headers: {},
            body: '<html>login</html>',
            finalUrl: `${OA_BASE}/resource/jsp/anonym.jsp`,
          };
        }
        return {
          status: 200,
          headers: {},
          body: [
            '<script>',
            "var userName = '张三';",
            "var loginName = 'u1';",
            '</script>',
            '<input type="hidden" name="fdPersonId" value="p-seed">',
          ].join('\n'),
          finalUrl: `${OA_BASE}/sys/person/setting.do`,
        };
      }
      throw new Error(`unexpected ${input.method} ${input.path}`);
    };
    return {
      jar,
      loginPosts: () => loginPostCount,
      setUnreachable: (value: boolean) => {
        unreachable = value;
      },
      clearCookies: async () => {
        jar.sessionAlive = false;
      },
      transport: {
        clearCookies: async () => {
          jar.sessionAlive = false;
        },
        request(input: PortalRequest): Promise<OaResponse> {
          // 登录尝试计数在拒绝之前：unreachable 也要看见「发起过登录」这件事。
          if (input.method === 'POST' && input.path.includes('j_acegi_security_check')) {
            loginPostCount += 1;
          }
          if (unreachable) {
            return Promise.reject(new TypeError('net::ERR_INTERNET_DISCONNECTED'));
          }
          return Promise.resolve(respond(input));
        },
      },
    };
  }

  function makeRealClientManager(transport: OaTransport, clearCookies: () => Promise<void>) {
    waitCalls = [];
    return createHrOaSessionManager({
      client: createOaClient({ baseUrl: OA_BASE, transport, timeoutMs: 200 }),
      credentials,
      commitSession,
      now: () => clock,
      clearCookies,
      // 退避可观察、测试内零真实等待（性能预算：不得 ≥100ms 真实等待）。
      wait: (ms: number) => {
        waitCalls.push(ms);
        return Promise.resolve();
      },
    });
  }

  it('启动时钥匙串有凭证但 cookie jar 为空 → 仍落 signed-in（不出现 S1）', async () => {
    // OA 会话 cookie 是 session cookie，应用一退出就没了——冷启动 jar 必空。SC-3
    // 要求这种真态下凭钥匙串凭证静默重登直接进首页；真机另证：启动期 safeStorage
    // 后端可能未就绪（首读回 null），一抖就把密文误判成「无凭证」回 S1（from=launch）。
    await seedStoredLogin();
    blipFirstRead('null');
    const portal = makePortalJarTransport({ initialSessionAlive: false });

    const manager = makeRealClientManager(portal.transport, portal.clearCookies);
    const state = await manager.startup();

    // 资料页解析结果：name/loginName/personId 来自门户 HTML；账号键按冻结键 'p-seed'。
    const portalProfile = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    expect(state).toEqual({ status: 'signed-in', accountKey: 'p-seed', profile: portalProfile });
    expect(manager.getState()).toEqual(state);
    // 落定即认领 hr 会话（首页外层门禁据 commitSession 的会话放行）。
    expect(commitSession.mock.calls).toEqual([['hr', 'p-seed']]);
    // 静默重登必须喂钥匙串里那份凭证；成功后凭证仍在（滑动刷新，不被误清）。
    expect(await loadOaLogin(clock, testDeps)).not.toBeNull();
    expect(clearOaLoginSpy).not.toHaveBeenCalled();
  });

  it('启动时凭证在、门户网络不可达 → 落 offline 且凭证保留（不落 signed-out、不清凭证）', async () => {
    // Ruling 6：网络类失败保留凭证、离线进首页——VPN 抖动绝不能把人锁在门外。
    // 首读垃圾（解密瞬时异常）在旧实现走 `expired` 分支：落 signed-out **且顺手删
    // 密文**——「落 signed-out / 清凭证」正是此缺陷的可观察签名。
    await seedStoredLogin();
    blipFirstRead('garbage');
    const portal = makePortalJarTransport({ initialSessionAlive: false, unreachable: true });

    const manager = makeRealClientManager(portal.transport, portal.clearCookies);
    const state = await manager.startup();

    expect(state.status).toBe('offline');
    expect(state).toMatchObject({ accountKey: 'p-seed' });
    // offline 同样认领 hr 会话（home 可读），不是 signed-out。
    expect(commitSession.mock.calls).toEqual([['hr', 'p-seed']]);
    // 不落 signed-out、不清凭证：重试读回正本后凭证仍在。
    expect(manager.getState().status).toBe('offline');
    expect(clearOaLoginSpy).not.toHaveBeenCalled();
    expect(await loadOaLogin(clock, testDeps)).not.toBeNull();
  });

  it('凭证持续读不出 → 仍落 offline 且按资料缓存冻结键认领（不落 signed-out、不清凭证）', async () => {
    // review Finding 1 的主路径：读不出持续到重试耗尽（钥匙串未就绪窗口长于退避
    // 预算）。密文还在——落 signed-out = 把有凭证的人锁回 S1（FR-SESSION-01 破口）；
    // 按资料缓存的冻结键落 offline 才能 home 可读、等钥匙串恢复后静默转 signed-in。
    await seedStoredLogin();
    const cached = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    await credentialStoreNs.saveOaProfileCache(
      { accountKey: 'p-seed', loginName: 'u1', profile: cached },
      testDeps,
    );
    const held = { down: true };
    holdReads(held, 'null');
    const portal = makePortalJarTransport({ initialSessionAlive: false, unreachable: true });

    const manager = makeRealClientManager(portal.transport, portal.clearCookies);
    const state = await manager.startup();

    expect(state).toEqual({ status: 'offline', accountKey: 'p-seed', profile: cached });
    // offline 认领 hr 会话（home 可读），不是 signed-out 首启。
    expect(commitSession.mock.calls).toEqual([['hr', 'p-seed']]);
    // 不清凭证：密文原样留在 secret IO（读不出 ≠ 不存在）。
    expect(clearOaLoginSpy).not.toHaveBeenCalled();
    expect(testDeps.secretIo.list()).toContain('hr_oa_login');
  });

  it('凭证持续读不出且资料缓存缺失 → 退 signed-out 但保留凭证（不 commit、不清凭证）', async () => {
    // 无缓存认领不了数据分区，只能退 signed-out（既有边角行为，本用例钉住）：但
    // **不** commit（不踩启动归一）、**不**清凭证——密文还在，钥匙串恢复后仍可救。
    // 旧实现读出垃圾直接走 expired：commit signed-out 且顺手删密文（误判失效 + 清凭证）。
    await seedStoredLogin();
    const held = { down: true };
    holdReads(held, 'garbage');
    const portal = makePortalJarTransport({ initialSessionAlive: false, unreachable: true });

    const manager = makeRealClientManager(portal.transport, portal.clearCookies);
    const state = await manager.startup();

    expect(state).toEqual({ status: 'signed-out' });
    expect(commitSession).not.toHaveBeenCalled();
    expect(clearOaLoginSpy).not.toHaveBeenCalled();
    expect(testDeps.secretIo.list()).toContain('hr_oa_login');
  });

  it('读不出的重试必须带非零退避（不许零间隔连打）', async () => {
    // review Finding 1：零延迟三连读盖不住毫秒级以上的钥匙串未就绪窗口——退避是
    // 重试有意义的前提。注入 wait 记录调用（测试内不真实等待）。
    await seedStoredLogin();
    const held = { down: true };
    holdReads(held, 'null');
    const portal = makePortalJarTransport({ initialSessionAlive: false, unreachable: true });

    const manager = makeRealClientManager(portal.transport, portal.clearCookies);
    await manager.startup();

    // 两次重试 = 两次退避；每次都必须 > 0（零间隔 = 退化回零延迟连打）。
    expect(waitCalls.length).toBeGreaterThanOrEqual(2);
    for (const ms of waitCalls) expect(ms).toBeGreaterThan(0);
  });

  it('窗口聚焦触发 retryCredentialLoad：钥匙串恢复后从 offline 回 signed-in；无待恢复零动作', async () => {
    // review Finding 1：落 offline 之后若无任何恢复触发，钥匙串恢复也永远停在离线
    // 楔死（网络没抖就永远不走 networkRecovered）。main 侧窗口聚焦是最便宜的触发。
    await seedStoredLogin();
    const cached = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    await credentialStoreNs.saveOaProfileCache(
      { accountKey: 'p-seed', loginName: 'u1', profile: cached },
      testDeps,
    );
    const held = { down: true };
    holdReads(held, 'null');
    const portal = makePortalJarTransport({ initialSessionAlive: false });

    const manager = makeRealClientManager(portal.transport, portal.clearCookies);
    await manager.startup();
    expect(manager.getState().status).toBe('offline');

    // 钥匙串恢复（后端就绪）→ 聚焦触发重试 → 静默重登转 signed-in。
    held.down = false;
    const state = await manager.retryCredentialLoad();
    expect(state).toEqual({
      status: 'signed-in',
      accountKey: 'p-seed',
      profile: profile({ name: '张三', loginName: 'u1', personId: 'p-seed' }),
    });
    expect(commitSession.mock.calls.at(-1)).toEqual(['hr', 'p-seed']);

    // 无待恢复时零动作：signed-in 态聚焦不得重打网络（不得误清、不得重复登录）。
    const postsBefore = portal.loginPosts();
    await manager.retryCredentialLoad();
    expect(portal.loginPosts()).toBe(postsBefore);
    expect(manager.getState().status).toBe('signed-in');
  });

  it('手动登录成功后 retryCredentialLoad 不得再打静默重登（不把健康会话打回 offline）', async () => {
    // review Round 2 Break A：读不出楔子（pending）跨手动登录残留时，下一次聚焦会
    // silentRelogin——网络类失败把健康 signed-in 打回 offline，且没有 online 事件兜底，
    // 反而重新楔死。显式登录成功 = 用户已手工解决登录态，pending 必须收口。
    await seedStoredLogin();
    const cached = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    await credentialStoreNs.saveOaProfileCache(
      { accountKey: 'p-seed', loginName: 'u1', profile: cached },
      testDeps,
    );
    const held = { down: true };
    holdReads(held, 'null');
    const portal = makePortalJarTransport({ initialSessionAlive: false });

    const manager = makeRealClientManager(portal.transport, portal.clearCookies);
    await manager.startup();
    expect(manager.getState().status).toBe('offline');

    // 用户在登录页手动登录（钥匙串也已恢复可读）→ 健康 signed-in。
    held.down = false;
    const loggedIn = await manager.login('u1', PASSWORD);
    expect(loggedIn).toMatchObject({ status: 'signed-in', accountKey: 'p-seed' });
    const postsAfterLogin = portal.loginPosts();

    // 之后门户再挂（无网络抖动信号）：聚焦不得重打静默重登、不得把 signed-in 打回 offline。
    portal.setUnreachable(true);
    const state = await manager.retryCredentialLoad();
    expect(state).toMatchObject({ status: 'signed-in', accountKey: 'p-seed' });
    expect(portal.loginPosts()).toBe(postsAfterLogin);
  });

  it('主动登出后 retryCredentialLoad 不得翻成 expired（FR-HOME-03 不弹登录已过期）', async () => {
    // review Round 2 Break B：logout 落 reason:'logout'（FR-HOME-03 主动登出不得弹
    // 「登录已过期」）后，stale pending 让下一次聚焦把 load 的 'none' 落成
    // reason:'expired'——新开窗口/重挂载的 renderer 会按 FR-SESSION-02 冷启动弹失效
    // toast。主动登出 = 楔子已被用户显式取代，pending 必须收口。
    await seedStoredLogin();
    const cached = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    await credentialStoreNs.saveOaProfileCache(
      { accountKey: 'p-seed', loginName: 'u1', profile: cached },
      testDeps,
    );
    const held = { down: true };
    holdReads(held, 'null');
    const portal = makePortalJarTransport({ initialSessionAlive: false });

    const manager = makeRealClientManager(portal.transport, portal.clearCookies);
    await manager.startup();
    expect(manager.getState().status).toBe('offline');

    // 主动登出（凭证清掉、reason:'logout'）。
    held.down = false;
    await manager.logout();
    expect(manager.getState()).toEqual({ status: 'signed-out', reason: 'logout' });

    // 聚焦不得把主动登出翻成失效：状态原样，不 commit、不清 cookie 收口以外的东西。
    const state = await manager.retryCredentialLoad();
    expect(state).toEqual({ status: 'signed-out', reason: 'logout' });
    expect(manager.getState()).toEqual({ status: 'signed-out', reason: 'logout' });
  });
});
