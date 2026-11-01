/**
 * 测试价值
 * - 生产入口与可观察结果：createHrOaSessionManager() 的 startup() 静默重登分流（表驱动六行：
 *   无凭证 / 成功 / wrong_credentials / network_error / timeout / 资料拉取失败）——只认
 *   wrong_credentials、locked 清钥匙串，network_error、timeout 保留凭证并进 offline（home 仍可读，
 *   commitSession('hr', key)）；logout() 清凭证 + commitSession('signed-out') + client.resetSession()；
 *   login() 手输账号写入经 resolveAccountKey 冻结的新键，显式登录失败只回 { error } 不改状态与
 *   存量凭证（Ruling 3：登录页留在原地出内联错误，只有 startup 静默重登会产生 offline）。
 * - Bug／规则依据：登录门禁计划 Task 2 Step 5/6 失败分流表；Ruling 3 显式登录失败不进 offline；
 *   「资料失败不阻断登录，键退化用已缓存的冻结键」；VPN 抖动（网络类失败）绝不能清凭证把人锁在
 *   门外；logout 必须 client.resetSession()（OA client 在内存里记着口令做会话恢复，不复位会跨
 *   登出口令泄漏）。
 * - 现有覆盖缺口：新模块，此前没有 HR 会话生命周期与失败分流覆盖；oaClient.test.ts 只覆盖单次
 *   登录 outcome，不覆盖凭证去留与会话状态。
 * - 最小失败输入：见表驱动 startup 六行 + 手输新账号 / 冻结键 / 显式失败四类 / logout；凭证层
 *   用真实 credentialStore（内存 secret IO + mkdtemp 映射表），client 全 fake。
 * - tier：unit（无真实网络；client/commitSession 注入 fake，凭证走真实模块 + 假 IO）。
 * - 实测耗时：单文件 ~1.5s 墙钟（pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/sessionManager.test.ts）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

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
      name: 'wrong_credentials clears the credential and commits signed-out',
      seed: true,
      login: { ok: false, kind: 'wrong_credentials' },
      profile: freshProfile,
      expected: { status: 'signed-out' },
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
    expect(manager.getState()).toEqual({ status: 'signed-out' });
    expect(commitSession.mock.calls.at(-1)).toEqual(['signed-out']);
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
