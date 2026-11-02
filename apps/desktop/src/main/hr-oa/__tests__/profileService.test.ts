/**
 * 测试价值
 * - 生产入口与可观察结果：`createProfileService()` 的 `fetchProfile()` 单飞（并发两次只打
 *   一次 getPersonProfile、同回包）；`cancelOutstanding()` / `bumpEpoch()` 的在途丢弃（迟到
 *   结果 `{ok:false,kind:'cancelled'}` 且**不写缓存**；epoch 推进后新取数不被 stale 在途
 *   挂死）；失败分流（无缓存 + 接口失败 → `kind:'error'`；有缓存 + 刷新失败 →
 *   `{ok:true, fromCache:true}`，**串号缓存**（accountKey 对不上当前凭证）不采信；
 *   会话失效（anonym.jsp 重登失败，OaLoginError 会话语义）→ `kind:'expired'` 且终态不
 *   回落缓存）；成功写资料缓存（键 = **冻结** accountKey，personId 不得顶替）；隐私边界：
 *   落盘 JSON 键集不含 `mobile` / `sex`；`getAvatar()` miss 取图落盘、命中不再打网络、
 *   personId 可从资料缓存兜底、epoch 丢弃不落盘。
 * - Bug／规则依据：profile-menu 计划 Task 2 Step 3/4 矩阵；集成设计 §4.1（资料/头像一律用
 *   登录人自己的 OA 会话直连门户，不走 HRMcp MCP）、§4.2 资料缓存；账号键冻结裁决（键漂移
 *   = 换 dataOwner、孤儿化本地数据分区）；PRD §7.2 不展示手机号/性别 → 两者绝不落缓存盘；
 *   计划 Ruling 4/6 后续：「HRMcp 会话失效」对我们就是 anonym.jsp 重登失败（现映射
 *   network_error），按 FR-LOGOUT-05 源必须能被上层识别为会话失效（'expired'）。
 * - 现有覆盖缺口：新模块，此前无取数单飞 / epoch 取消 / 缓存回落 / 头像编排覆盖；
 *   sessionManager.test.ts 只覆盖登录生命周期，不覆盖登录后的资料刷新编排。
 * - 最小失败输入：deferred getPersonProfile 控制完成时机（单飞 / 取消 / epoch 三用例）；
 *   假 client 分别抛 network_error 与 SESSION_RECOVERY_FAIL_MSG 观察分流；真实
 *   credentialStore（内存 secret IO + mkdtemp）断言落盘 JSON 键集与冻结键。
 * - tier：unit（无真实网络；client/transport 注入 fake，凭证与缓存走真实模块 + 假 IO）。
 * - 实测耗时：见文件末尾运行记录（单文件须 ≤5s）。
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
  resolveAccountKey,
  saveOaLogin,
  saveOaProfileCache,
  type OaCredentialDeps,
} from '../credentialStore.js';
import type { SecretStorageIo } from '../../secrets/providerSecretStore.js';
import { OaLoginError } from '../errors.js';
import { SESSION_RECOVERY_FAIL_MSG, type OaClient, type OaTransport } from '../oaClient.js';
import type { PersonProfile } from '../profile.js';
import { createProfileService, type ProfileService } from '../profileService.js';
import { createHrOaSessionManager } from '../sessionManager.js';

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

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let clock = 10_000;
let tempDir: string;
let testDeps: OaCredentialDeps;
let cache: typeof import('../credentialStore.js');
let client: OaClient;
let profileImpl: () => Promise<PersonProfile>;
let getPersonProfile: ReturnType<typeof vi.fn>;
let avatarRequest: ReturnType<typeof vi.fn>;
let avatarTransport: OaTransport;

/** 真实 credentialStore（注入假 IO）按模块命名空间形状适配给 profileService。 */
function makeCache(): typeof import('../credentialStore.js') {
  return {
    OA_LOGIN_TTL_MS,
    saveOaLogin: (input) => saveOaLogin(input, testDeps),
    loadOaLogin: (now?: number) => credentialStoreNs.loadOaLogin(now, testDeps),
    loadOaLoginDetailed: (now?: number) => credentialStoreNs.loadOaLoginDetailed(now, testDeps),
    clearOaLogin: () => credentialStoreNs.clearOaLogin(testDeps),
    resolveAccountKey: (loginName, forProfile) => resolveAccountKey(loginName, forProfile, testDeps),
    saveOaProfileCache: (input) => saveOaProfileCache(input, testDeps),
    loadOaProfileCache: () => credentialStoreNs.loadOaProfileCache(testDeps),
    saveOaAvatarCache: (input) => credentialStoreNs.saveOaAvatarCache(input, testDeps),
    loadOaAvatarCache: (key) => credentialStoreNs.loadOaAvatarCache(key, testDeps),
    clearOaAvatarCache: () => credentialStoreNs.clearOaAvatarCache(testDeps),
  };
}

function makeService(): ProfileService {
  return createProfileService({
    client,
    cache,
    now: () => clock,
    avatar: { baseUrl: 'http://oa.example', transport: avatarTransport },
  });
}

function profileCacheFile(): string {
  return path.join(tempDir, 'hr-oa-profile-cache.json');
}

beforeEach(() => {
  clock = 10_000;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-profile-service-test-'));
  testDeps = {
    secretIo: createMemoryIo(),
    mappingFilePath: path.join(tempDir, 'hr-oa-account-map.json'),
    now: () => clock,
  };
  cache = makeCache();
  profileImpl = async () => profile();
  getPersonProfile = vi.fn(() => profileImpl());
  client = {
    login: vi.fn(async () => ({ ok: true as const })),
    getPersonProfile,
    resetSession: vi.fn(),
  };
  avatarRequest = vi.fn(async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: String.fromCharCode(0x89, 0x50, 0x4e, 0x47),
    finalUrl: 'http://oa.example/sys/person/image.jsp',
  }));
  avatarTransport = { request: avatarRequest };
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('fetchProfile 单飞与 epoch 取消', () => {
  it('并发 fetchProfile 单飞：两次调用只打一次 getPersonProfile', async () => {
    const pending = defer<PersonProfile>();
    profileImpl = () => pending.promise;
    const svc = makeService();

    const first = svc.fetchProfile('launch');
    const second = svc.fetchProfile('stale');
    const fresh = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    pending.resolve(fresh);

    expect(await first).toEqual({ ok: true, profile: fresh, fromCache: false });
    expect(await second).toEqual({ ok: true, profile: fresh, fromCache: false });
    expect(getPersonProfile).toHaveBeenCalledTimes(1);
  });

  it('cancelOutstanding 后的迟到结果丢弃为 cancelled，且不写缓存', async () => {
    const pending = defer<PersonProfile>();
    profileImpl = () => pending.promise;
    const svc = makeService();

    const inFlight = svc.fetchProfile('launch');
    svc.cancelOutstanding();
    pending.resolve(profile({ name: '张三', loginName: 'u1', personId: 'p-seed' }));

    expect(await inFlight).toEqual({ ok: false, kind: 'cancelled' });
    // 迟到成功结果不得落缓存（cancel 后的数据属于已放弃的账号/会话）。
    expect(await cache.loadOaProfileCache()).toBeNull();
  });

  it('bumpEpoch 丢弃旧 epoch 的迟到结果；epoch 推进后新取数不被 stale 在途挂死', async () => {
    const staleFetch = defer<PersonProfile>();
    const fresh = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    let call = 0;
    profileImpl = () => {
      call += 1;
      return call === 1 ? staleFetch.promise : Promise.resolve(fresh);
    };
    const svc = makeService();

    const stale = svc.fetchProfile('launch');
    expect(svc.bumpEpoch()).toBe(1);
    // epoch 已推进：新调用不得复用旧 epoch 的在途请求（否则只拿到 cancelled）。
    expect(await svc.fetchProfile('launch')).toEqual({ ok: true, profile: fresh, fromCache: false });

    staleFetch.resolve(profile({ name: '李四', loginName: 'u2', personId: 'p-other' }));
    expect(await stale).toEqual({ ok: false, kind: 'cancelled' });
    expect(getPersonProfile).toHaveBeenCalledTimes(2);
  });

  it('登录态落 signed-out 时取消在途取数（迟到结果 cancelled、不写缓存）', async () => {
    // Review Finding 2 / Controller Ruling D：epoch 只有真被认证边界触发才算数。
    // 生产接线 = sessionManager 在离开当前账号（signed-out / 换 accountKey）时回调
    // profileService.bumpEpoch()；本用例走同一条真实链路（manager + service），断言
    // 登出后迟到的资料结果丢弃、**不写缓存**（否则换号窗口会把上一账号资料落盘）。
    const profiles = makeService();
    const manager = createHrOaSessionManager({
      client,
      credentials: cache,
      commitSession: vi.fn(),
      now: () => clock,
      clearCookies: vi.fn(async () => {}),
      // 生产同款接线（bootstrap）：认证边界 → 作废资料层在途取数。
      onAccountBoundary: () => {
        profiles.bumpEpoch();
      },
    });

    // 先落 signed-in（signed-out → signed-in 不是「离开账号」，不得误取消）。
    profileImpl = async () => profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    await manager.login('u1', PASSWORD);
    expect(manager.getState().status).toBe('signed-in');
    const cacheAfterLogin = await cache.loadOaProfileCache();

    // 在途取数（deferred）→ 主动登出（落 signed-out）→ 迟到结果必须被丢弃。
    const lateFetch = defer<PersonProfile>();
    profileImpl = () => lateFetch.promise;
    const inFlight = profiles.fetchProfile('stale');
    await manager.logout();
    lateFetch.resolve(profile({ name: '李四', loginName: 'u2', personId: 'p-other' }));

    expect(await inFlight).toEqual({ ok: false, kind: 'cancelled' });
    // 不写缓存：登录时落的缓存不得被迟到结果覆盖（更不得落成另一账号）。
    const cacheAfterLate = await cache.loadOaProfileCache();
    expect(cacheAfterLate?.profile.name).toBe(cacheAfterLogin?.profile.name);
    expect(cacheAfterLate?.profile.name).not.toBe('李四');
  });
});

describe('fetchProfile 失败分流与缓存回落', () => {
  it('无缓存 + 接口失败 → error；有缓存 + 刷新失败 → fromCache；串号缓存不采信', async () => {
    profileImpl = async () => {
      throw new OaLoginError('network_error', 'portal unreachable');
    };
    const svc = makeService();

    // 无缓存：拿不到任何可用资料 → error（不是空资料冒充成功）。
    expect(await svc.fetchProfile('retry')).toEqual({ ok: false, kind: 'error' });

    // 有缓存且与当前凭证同键：离线兜底可读（设计 §4.2），fromCache 标记让上层可提示。
    const cached = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: cached, now: clock },
      testDeps,
    );
    await saveOaProfileCache({ accountKey: 'p-seed', loginName: 'u1', profile: cached }, testDeps);
    expect(await svc.fetchProfile('retry')).toEqual({ ok: true, profile: cached, fromCache: true });

    // 串号缓存（键对不上当前凭证）：宁可 error，不得展示别人 / 旧账号的资料。
    await saveOaProfileCache(
      { accountKey: 'other-key', loginName: 'other', profile: profile({ loginName: 'other', name: '李四' }) },
      testDeps,
    );
    expect(await svc.fetchProfile('retry')).toEqual({ ok: false, kind: 'error' });
  });

  it('会话失效（anonym.jsp 重登失败）→ expired，终态不回落缓存', async () => {
    const cached = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: cached, now: clock },
      testDeps,
    );
    await saveOaProfileCache({ accountKey: 'p-seed', loginName: 'u1', profile: cached }, testDeps);
    profileImpl = async () => {
      throw new OaLoginError('network_error', SESSION_RECOVERY_FAIL_MSG);
    };

    // 会话失效必须原样上报（FR-LOGOUT-05 强退源），不得被缓存兜底盖成「看起来还活着」。
    expect(await makeService().fetchProfile('launch')).toEqual({ ok: false, kind: 'expired' });
  });

  it('登出后（凭证已清）不得回落残留缓存身份：fetchProfile 回 error、getAvatar 不发请求', async () => {
    // Review Finding 1：登出后凭证没了、资料缓存**故意保留**（Task 1 裁决）——此时
    // loadOaLogin() 恒 null，若把「无凭证」当信任放行，刷新失败会把上一账号的资料
    // 当当前人回给上层（fromCache:true），头像键也会用残留 personId 拼出别人的图。
    const cached = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: cached, now: clock },
      testDeps,
    );
    await saveOaProfileCache({ accountKey: 'p-seed', loginName: 'u1', profile: cached }, testDeps);
    await credentialStoreNs.clearOaLogin(testDeps);
    profileImpl = async () => {
      throw new OaLoginError('network_error', 'portal unreachable');
    };

    // 无凭证 = 无法证明缓存归属 → 一律不采信（宁可 error，不展示旧账号资料）。
    expect(await makeService().fetchProfile('retry')).toEqual({ ok: false, kind: 'error' });
    // 同一条身份红线：头像键的 personId 不得来自未验明归属的残留缓存。
    expect(await makeService().getAvatar('1710')).toBeNull();
    expect(avatarRequest).not.toHaveBeenCalled();
  });
});

describe('资料缓存落盘（键 = 冻结 accountKey；隐私边界）', () => {
  it('成功后写资料缓存，键 = 冻结 accountKey（后到的 personId 不得顶替）', async () => {
    // 首登无 personId → 冻结键退化为 loginName 'u1'（saveOaLogin 落映射）。
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: profile({ loginName: 'u1' }), now: clock },
      testDeps,
    );
    const fresh = profile({ name: '张三', loginName: 'u1', personId: 'p9', dept: 'HR' });
    profileImpl = async () => fresh;

    expect(await makeService().fetchProfile('login')).toEqual({
      ok: true,
      profile: fresh,
      fromCache: false,
    });
    const raw = JSON.parse(fs.readFileSync(profileCacheFile(), 'utf-8')) as {
      accountKey: string;
      loginName: string;
      profile: Record<string, unknown>;
    };
    // 冻结键 'u1'：personId 'p9' 只进资料字段。写 'p9' = 换 dataOwner、孤儿化本地分区。
    expect(raw.accountKey).toBe('u1');
    expect(raw.loginName).toBe('u1');
    expect(raw.profile.name).toBe('张三');
  });

  it('资料缓存落盘键集不含 mobile / sex（隐私边界）', async () => {
    profileImpl = async () =>
      profile({
        name: '张三',
        loginName: 'u1',
        personId: 'p9',
        dept: 'HR',
        email: 'a@b.c',
        title: '经理',
        mobile: '1380000secret',
        sex: 'sex-secret',
      });

    expect(await makeService().fetchProfile('login')).toMatchObject({ ok: true, fromCache: false });
    const rawText = fs.readFileSync(profileCacheFile(), 'utf-8');
    const raw = JSON.parse(rawText) as { profile: Record<string, unknown> };
    // 键集钉死：展示字段 + personId（头像/账号键来源）；mobile、sex 一律不落盘。
    expect(Object.keys(raw).sort()).toEqual(['accountKey', 'loginName', 'profile']);
    expect(Object.keys(raw.profile).sort()).toEqual([
      'dept',
      'email',
      'loginName',
      'name',
      'personId',
      'title',
    ]);
    expect(rawText).not.toContain('1380000secret');
    expect(rawText).not.toContain('sex-secret');
  });
});

describe('getAvatar 编排（缓存键 personId+sTime）', () => {
  it('miss 取图落盘、命中不再打网络；personId 可从资料缓存兜底', async () => {
    const cached = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    // 身份前提：凭证在盘且与缓存同键（verifiedCachedProfile 的采信条件）。
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: cached, now: clock },
      testDeps,
    );
    await saveOaProfileCache({ accountKey: 'p-seed', loginName: 'u1', profile: cached }, testDeps);
    const svc = makeService();

    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const first = await svc.getAvatar('1710');
    expect(first).toEqual({ key: 'p-seed1710', bytes, contentType: 'image/png' });
    expect(avatarRequest).toHaveBeenCalledTimes(1);
    // 磁盘缓存载荷可回读（登出清理 / 重启复用都走这份）。
    expect(await cache.loadOaAvatarCache('p-seed1710')).toEqual(first);

    // 命中：不再打网络。
    expect(await svc.getAvatar('1710')).toEqual(first);
    expect(avatarRequest).toHaveBeenCalledTimes(1);

    // 全新服务实例（无内存 personId）：personId 从资料缓存兜底后仍能命中头像缓存。
    expect(await makeService().getAvatar('1710')).toEqual(first);
    expect(avatarRequest).toHaveBeenCalledTimes(1);
  });

  it('epoch 推进后在途头像结果丢弃且不落盘', async () => {
    const cached = profile({ name: '张三', loginName: 'u1', personId: 'p-seed' });
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: cached, now: clock },
      testDeps,
    );
    await saveOaProfileCache({ accountKey: 'p-seed', loginName: 'u1', profile: cached }, testDeps);
    const pending = defer<{ status: number; headers: Record<string, string>; body: string; finalUrl: string }>();
    avatarRequest = vi.fn(() => pending.promise);
    avatarTransport = { request: avatarRequest };
    const svc = makeService();

    const inFlight = svc.getAvatar('1710');
    svc.bumpEpoch();
    pending.resolve({
      status: 200,
      headers: { 'content-type': 'image/png' },
      body: String.fromCharCode(0x89, 0x50),
      finalUrl: 'http://oa.example/sys/person/image.jsp',
    });

    // 登出 / 换号后的迟到头像属于上一个账号：结果丢弃、不得落盘。
    expect(await inFlight).toBeNull();
    expect(await cache.loadOaAvatarCache('p-seed1710')).toBeNull();
    expect(avatarRequest).toHaveBeenCalledTimes(1);
  });
});
