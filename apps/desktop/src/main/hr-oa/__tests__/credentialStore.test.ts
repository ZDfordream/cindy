/**
 * 测试价值
 * - 生产入口与可观察结果：saveOaLogin() → loadOaLogin() 往返还原 username / password /
 *   accountKey；resolveAccountKey() 的账号键冻结（首次 loginName='u1' 无 personId → 键='u1'，
 *   之后同一 loginName 拉到 personId='p9' → 键仍='u1'，personId 只进资料字段）；now 推进超过
 *   OA_LOGIN_TTL_MS 后 loadOaLogin() 返回 null 并清掉过期密文，clearOaLogin() 后立即 null；
 *   口令只经 secret IO 落盘——账号映射 JSON 与所有日志对象字段都不含口令明文。
 * - Bug／规则依据：登录门禁计划 Task 2 Step 3/4；凭证与本地存储规则「日志、错误、遥测和
 *   调试输出不得包含凭证明文」「不要新增自定义明文凭证文件」——映射表是 userData 根下全局
 *   非密文 JSON，只允许 accountKey/expiresAt；口令只进 SecretStorageIo 同源密文槽。
 * - 现有覆盖缺口：新模块，此前没有 OA 门户凭证持久化、账号键冻结与登录 TTL 覆盖。
 * - 最小失败输入：往返一组假凭证（'pw-not-a-real-secret'）；resolveAccountKey 两次调用
 *   （第二次 personId 变化）；now 从 T0 推到 T0+TTL+1；save 后读映射文件原文断言无口令。
 * - tier：unit（内存 fake SecretStorageIo + mkdtemp 映射文件，无真实 safeStorage / userData）。
 * - 实测耗时：单文件 ~1.7s 墙钟（pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/credentialStore.test.ts）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logCalls = vi.hoisted(() => [] as Array<{ level: string; args: unknown[] }>);

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: (...args: unknown[]) => logCalls.push({ level: 'debug', args }),
    info: (...args: unknown[]) => logCalls.push({ level: 'info', args }),
    warn: (...args: unknown[]) => logCalls.push({ level: 'warn', args }),
    error: (...args: unknown[]) => logCalls.push({ level: 'error', args }),
  }),
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
import type { PersonProfile } from '../profile.js';

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

/** 进程内 fake secret IO：按存储键名读写一个 Map，模拟 safeStorage 文件层。 */
function createMemoryIo(): SecretStorageIo & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
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

let tempDir: string;
let mappingFilePath: string;
let memoryIo: ReturnType<typeof createMemoryIo>;
let deps: OaCredentialDeps;

beforeEach(() => {
  logCalls.length = 0;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-credential-store-test-'));
  mappingFilePath = path.join(tempDir, 'hr-oa-account-map.json');
  memoryIo = createMemoryIo();
  deps = { secretIo: memoryIo, mappingFilePath, now: () => clock };
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

let clock = 1_000;

describe('oa credential store', () => {
  it('round-trips username, password and account key through the secret IO', async () => {
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: profile({ loginName: 'u1', personId: 'p42' }), now: clock },
      deps,
    );
    const loaded = await loadOaLogin(clock, deps);
    expect(loaded).toEqual({
      username: 'u1',
      password: PASSWORD,
      accountKey: 'p42',
      loginName: 'u1',
      expiresAt: clock + OA_LOGIN_TTL_MS,
    });
  });

  it('freezes the account key at first login even when personId appears later', async () => {
    // 首次：无 personId → 键退化为 loginName。
    expect(resolveAccountKey('u1', profile({ loginName: 'u1' }), deps)).toBe('u1');
    // 之后：同一 loginName 拉到 personId → 键仍是 'u1'，personId 只进资料字段。
    expect(resolveAccountKey('u1', profile({ loginName: 'u1', personId: 'p9' }), deps)).toBe('u1');
    // 经 save 落盘的 accountKey 同样是冻结键，不被 personId 顶替。
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: profile({ loginName: 'u1', personId: 'p9' }), now: clock },
      deps,
    );
    const loaded = await loadOaLogin(clock, deps);
    expect(loaded?.accountKey).toBe('u1');
  });

  it('expires the stored login past the TTL and clears it on demand', async () => {
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: profile({ loginName: 'u1' }), now: clock },
      deps,
    );
    expect(await loadOaLogin(clock + OA_LOGIN_TTL_MS + 1, deps)).toBeNull();
    // 过期密文顺手清除：secret IO 里不再留口令。
    expect(memoryIo.store.size).toBe(0);

    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: profile({ loginName: 'u1' }), now: clock },
      deps,
    );
    await clearOaLogin(deps);
    expect(await loadOaLogin(clock, deps)).toBeNull();
    expect(memoryIo.store.size).toBe(0);
  });

  it('persists the password only through the secret IO and never into log or mapping fields', async () => {
    await saveOaLogin(
      { username: 'u1', password: PASSWORD, profile: profile({ loginName: 'u1', personId: 'p42' }), now: clock },
      deps,
    );
    // 映射表是明文 JSON：只允许 accountKey / expiresAt，绝无口令。
    const mappingRaw = fs.readFileSync(mappingFilePath, 'utf8');
    expect(mappingRaw).not.toContain(PASSWORD);
    expect(JSON.parse(mappingRaw)).toEqual({
      u1: { accountKey: 'p42', expiresAt: clock + OA_LOGIN_TTL_MS },
    });
    // 口令只经 secret IO 落盘（密文槽是唯一落点）。
    expect(memoryIo.store.size).toBe(1);
    expect([...memoryIo.store.values()].join('\n')).toContain(PASSWORD);
    // 任何日志对象字段都不含口令明文。
    for (const call of logCalls) {
      expect(JSON.stringify(call.args)).not.toContain(PASSWORD);
    }
  });
});
