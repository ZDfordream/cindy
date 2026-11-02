/**
 * credentialStore.ts — HR OA 门户登录凭证（钥匙串）、账号键映射与资料缓存（main 进程）。
 *
 * 三份持久数据，生命周期分离：
 *   1. **登录凭证**（username / password / accountKey / loginName / expiresAt）——口令只经
 *      `SecretStorageIo` 落盘（与 providerSecretStore / bootstrap-electron safe-storage IPC
 *      **字节级一致**的 safeStorage 密文格式，不新开加密格式），且**不在 owner 分区内**：
 *      静默重登发生在 owner 认领之前，凭证必须先于分区可读。
 *   2. **账号键映射表**——`loginName → { accountKey, expiresAt }`，落 `userData` 根下全局
 *      明文 JSON（同样不在 owner 分区内，后续任务在 owner 出现前就要查它），原子替换写入。
 *   3. **资料缓存**——`{ accountKey, loginName, profile }`，登录成功时落一份（设计 §4.2
 *      「账号键与个人资料落一份本地缓存，离线启动靠它定位数据分区」），与凭证/映射表同住
 *      `userData` 根、**不在 owner 分区内**（离线启动要在认领分区前读到它）。下次登录成功
 *      覆盖更新。**绝不含口令**——资料缓存是明文 JSON，只有展示字段。
 *
 * 账号键**冻结在首次登录**：映射表里已有条目就永远回冻结键，之后资料里出现的 personId 只进
 * 资料字段，不得顶替账号键——否则 dataOwner 换键会把本地数据分区整体孤儿化。条目的
 * expiresAt 是登录时效（save 时滑动刷新），供后续任务判断新鲜度；**不**参与冻结判定。
 * clearOaLogin 只清凭证密文，映射表与资料缓存保留（登出再登不得换键；资料缓存留作
 * 下次离线启动的兜底，登录成功即覆盖）。
 *
 * 安全红线：口令明文只出现在 secret IO 的密文槽与返回给会话恢复的 OaStoredLogin 里；
 * 映射表、资料缓存、日志与错误文本绝不含口令。
 */

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import type { SecretStorageIo } from '../secrets/providerSecretStore.js';
import type { AvatarCache } from './avatar.js';
import { accountKeyFor, type PersonProfile } from './profile.js';

/** 门户登录时效：距最近一次成功登录 14 天。 */
export const OA_LOGIN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface OaStoredLogin {
  username: string;
  password: string;
  accountKey: string;
  loginName: string;
  expiresAt: number;
}

/**
 * 注入点（照 providerSecretStore 的 SecretStorageIo 注入式做法）：测试给内存 secret IO 与
 * mkdtemp 映射表路径，无需启动 Electron；缺省走 safeStorage + userData。
 */
export interface OaCredentialDeps {
  secretIo: SecretStorageIo;
  mappingFilePath: string;
  /** 映射表写入取此时钟；save/load 的 now 参数优先。 */
  now?: () => number;
}

const log = createLogger('hr-oa');
const OA_LOGIN_STORAGE_KEY = 'hr_oa_login';
const OA_LOGIN_SECRET_DIR = 'safe-storage';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 与 providerSecretStore 物理层同字节格式：safeStorage 密文 base64 落 `<key>.enc`。 */
function physicalSecretIo(): SecretStorageIo {
  const dir = () => path.join(app.getPath('userData'), OA_LOGIN_SECRET_DIR);
  const file = (storageKey: string) => path.join(dir(), `${storageKey}.enc`);
  return {
    ownerScoped: false,
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    read(storageKey) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      if (!fs.existsSync(file(storageKey))) return null;
      return safeStorage.decryptString(Buffer.from(fs.readFileSync(file(storageKey), 'utf-8'), 'base64'));
    },
    write(storageKey, value) {
      if (!safeStorage.isEncryptionAvailable()) return false;
      fs.mkdirSync(dir(), { recursive: true });
      const encrypted = safeStorage.encryptString(value);
      fs.writeFileSync(file(storageKey), encrypted.toString('base64'), 'utf-8');
      return true;
    },
    remove(storageKey) {
      try {
        fs.unlinkSync(file(storageKey));
        return { success: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { success: true };
        return { success: false, error: 'remove_failed' };
      }
    },
    list() {
      try {
        return fs
          .readdirSync(dir())
          .filter((f) => f.endsWith('.enc'))
          .map((f) => f.slice(0, -'.enc'.length));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
  };
}

let defaultDepsCache: OaCredentialDeps | null = null;
/** 惰性构造：import 时不碰磁盘 / safeStorage（避免把钥匙串弹窗提前到启动期）。 */
function defaultDeps(): OaCredentialDeps {
  if (!defaultDepsCache) {
    defaultDepsCache = {
      secretIo: physicalSecretIo(),
      mappingFilePath: path.join(app.getPath('userData'), 'hr-oa-account-map.json'),
    };
  }
  return defaultDepsCache;
}

interface AccountMapEntry {
  accountKey: string;
  expiresAt: number;
}

function readAccountMap(mappingFilePath: string): Record<string, AccountMapEntry> {
  let raw: string;
  try {
    raw = fs.readFileSync(mappingFilePath, 'utf-8');
  } catch {
    return {};
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const map: Record<string, AccountMapEntry> = {};
    for (const [loginName, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!loginName || !entry || typeof entry !== 'object') continue;
      const candidate = entry as { accountKey?: unknown; expiresAt?: unknown };
      if (typeof candidate.accountKey !== 'string' || !candidate.accountKey) continue;
      if (typeof candidate.expiresAt !== 'number') continue;
      map[loginName] = { accountKey: candidate.accountKey, expiresAt: candidate.expiresAt };
    }
    return map;
  } catch {
    return {};
  }
}

/** 原子替换：先写同目录临时文件再 rename，避免半截 JSON 被读到。 */
function writeAccountMap(mappingFilePath: string, map: Record<string, AccountMapEntry>): void {
  const tmp = `${mappingFilePath}.tmp`;
  fs.mkdirSync(path.dirname(mappingFilePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(map), 'utf-8');
  fs.renameSync(tmp, mappingFilePath);
}

function mapWriteFailed(err: unknown): void {
  log.warn('oa account map write failed', { err: errorText(err) });
}

/**
 * 账号键经首次登录冻结：已有映射条目就回冻结键（不看 expiresAt——键漂移会把本地数据
 * 分区孤儿化）；否则键 = accountKeyFor(profile) || loginName 并落映射。两边皆空回 `''`，
 * 不写映射。
 */
export function resolveAccountKey(
  loginName: string,
  profile: PersonProfile,
  deps: OaCredentialDeps = defaultDeps(),
): string {
  const map = readAccountMap(deps.mappingFilePath);
  const frozen = map[loginName]?.accountKey;
  if (frozen) return frozen;
  const key = accountKeyFor(profile) || loginName;
  if (!loginName || !key) return key;
  const now = (deps.now ?? Date.now)();
  map[loginName] = { accountKey: key, expiresAt: now + OA_LOGIN_TTL_MS };
  try {
    writeAccountMap(deps.mappingFilePath, map);
  } catch (err) {
    mapWriteFailed(err);
  }
  return key;
}

/** 同 username 存量凭证里的冻结键（过期也算——键不得因 TTL 换掉）；不是同一账号返回 null。 */
function readPriorFrozenKey(username: string, deps: OaCredentialDeps): string | null {
  if (!username) return null;
  let raw: string | null;
  try {
    raw = deps.secretIo.read(OA_LOGIN_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw == null) return null;
  const record = parseStoredLogin(raw);
  if (!record || record.username !== username) return null;
  return record.accountKey || null;
}

/** 冻结写入：条目已存在且键不同则不动（冻结不漂移）；缺失或同键才写/刷新登录时效。 */
function freezeEntry(
  map: Record<string, AccountMapEntry>,
  key: string,
  accountKey: string,
  expiresAt: number,
): void {
  if (!key || !accountKey) return;
  const existing = map[key];
  if (existing && existing.accountKey !== accountKey) return;
  map[key] = { accountKey, expiresAt };
}

/**
 * 保存（覆盖）当前登录；账号键经 resolveAccountKey 冻结，映射条目的登录时效随之滑动刷新。
 * 口令只经 secret IO 落盘；IO 失败只记 warn（不含任何字段值），不向调用方抛口令相关错误。
 */
export async function saveOaLogin(
  input: { username: string; password: string; profile: PersonProfile; now?: number },
  deps: OaCredentialDeps = defaultDeps(),
): Promise<void> {
  const now = input.now ?? (deps.now ?? Date.now)();
  const expiresAt = now + OA_LOGIN_TTL_MS;
  const loginName = input.profile.loginName || input.username;
  // 冻结源优先级：同 username 存量凭证的冻结键 → 映射表（loginName / username 双标识）
  // → 经 resolveAccountKey 新冻结。三者共同兜住「同一账号的键不得漂移」（Review Focus #3）。
  const priorMap = readAccountMap(deps.mappingFilePath);
  const frozen =
    readPriorFrozenKey(input.username, deps) ??
    priorMap[loginName]?.accountKey ??
    priorMap[input.username]?.accountKey ??
    null;
  const accountKey = frozen ?? resolveAccountKey(loginName, input.profile, deps);
  const record: OaStoredLogin = {
    username: input.username,
    password: input.password,
    accountKey,
    loginName,
    expiresAt,
  };
  try {
    if (!deps.secretIo.write(OA_LOGIN_STORAGE_KEY, JSON.stringify(record))) {
      log.warn('oa credential write failed');
    }
  } catch (err) {
    log.warn('oa credential write failed', { err: errorText(err) });
  }
  // 双标识挂同一把冻结键：username 与 loginName 常不同（资料解析不出 loginName 时尤甚）。
  // 只冻 loginName 一侧的话，登出（映射表保留、凭证清除）后仅凭 username 重登、资料页又
  // 不可用时会另起新键换掉数据分区。已存在且不同的条目不动（冻结不漂移）。
  try {
    const map = readAccountMap(deps.mappingFilePath);
    freezeEntry(map, loginName, accountKey, expiresAt);
    if (input.username && input.username !== loginName) {
      freezeEntry(map, input.username, accountKey, expiresAt);
    }
    writeAccountMap(deps.mappingFilePath, map);
  } catch (err) {
    mapWriteFailed(err);
  }
}

function parseStoredLogin(raw: string): OaStoredLogin | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      typeof record.username !== 'string' ||
      typeof record.password !== 'string' ||
      typeof record.accountKey !== 'string' ||
      typeof record.loginName !== 'string' ||
      typeof record.expiresAt !== 'number'
    ) {
      return null;
    }
    return {
      username: record.username,
      password: record.password,
      accountKey: record.accountKey,
      loginName: record.loginName,
      expiresAt: record.expiresAt,
    };
  } catch {
    return null;
  }
}

/**
 * 载入结果四分（Finding 1 的失效分流来源 + 真机 2026-11-01 冷启动误判修复）：
 *   - `ok`：有未过期凭证；
 *   - `expired` = **曾有**凭证但已不可用（TTL 过期）——FR-SESSION-02 按失效处理
 *     （弹「登录已过期」），密文顺手清除；
 *   - `none` = 无凭证（首启 / 已登出）——不是失效，不弹；
 *   - `unavailable` = **密文在盘但暂时读不出**（safeStorage 后端未就绪 / 解密瞬时
 *     失败 / 密文暂时解析不出）——**绝不能**折成 `none`（会把有凭证的人判回首启、
 *     冷启动落 S1 回 `welcome_view from=launch`，密文却还在盘上——真机 2026-11-01
 *     实证签名）或折成 `expired`（会顺手删密文 = 清凭证）。authManager #1687 同一条
 *     界：只有「加密可用且文件确实不在」才能当凭证被外部清除，其余按瞬时失败。
 *     密文保留、由调用方重试或转 offline。
 */
export type OaLoginLoadResult =
  | { status: 'ok'; record: OaStoredLogin }
  | { status: 'none' }
  | { status: 'expired' }
  | { status: 'unavailable' };

/** 密文是否仍在盘上（不探加密后端、不解密；`list()` 只看文件名）。 */
function ciphertextPresent(deps: OaCredentialDeps): boolean {
  try {
    return deps.secretIo.list().includes(OA_LOGIN_STORAGE_KEY);
  } catch {
    // 列举失败无从判断：按在盘处理（宁可 unavailable 也不误判首启把人锁在 S1）。
    return true;
  }
}

/**
 * 缺失 / 过期 / 暂时读不出的分流版 load。只有 **TTL 过期**（记录完好但时效已过）
 * 才顺手清除密文；读不出 / 解析不出一律保留密文并回 `unavailable`——那可能是
 * 瞬时的钥匙串抖动，删了就是把仍有效的凭证清掉。
 */
export async function loadOaLoginDetailed(
  now?: number,
  deps: OaCredentialDeps = defaultDeps(),
): Promise<OaLoginLoadResult> {
  let raw: string | null;
  try {
    raw = deps.secretIo.read(OA_LOGIN_STORAGE_KEY);
  } catch (err) {
    log.warn('oa credential read failed', { err: errorText(err) });
    return ciphertextPresent(deps) ? { status: 'unavailable' } : { status: 'none' };
  }
  if (raw == null) {
    return ciphertextPresent(deps) ? { status: 'unavailable' } : { status: 'none' };
  }
  const record = parseStoredLogin(raw);
  if (!record) {
    // 密文在但解析不出：可能是一次解密异常的垃圾输出（真机启动期 backend 未就绪
    // 的同族症状），也可能是损坏。删了不可逆——保留并按暂时读不出上报，由调用方
    // 重试（下次读到正本即恢复）或转 offline；下次登录成功会覆盖写正本。
    log.warn('oa credential record unparseable; keeping ciphertext for retry');
    return { status: 'unavailable' };
  }
  const at = now ?? (deps.now ?? Date.now)();
  if (at >= record.expiresAt) {
    try {
      deps.secretIo.remove(OA_LOGIN_STORAGE_KEY);
    } catch (err) {
      log.warn('oa credential remove failed', { err: errorText(err) });
    }
    return { status: 'expired' };
  }
  return { status: 'ok', record };
}

/** 缺失 / 暂时读不出 / 过期均返回 null（区分载入原因用 `loadOaLoginDetailed`）。 */
export async function loadOaLogin(
  now?: number,
  deps: OaCredentialDeps = defaultDeps(),
): Promise<OaStoredLogin | null> {
  const result = await loadOaLoginDetailed(now, deps);
  return result.status === 'ok' ? result.record : null;
}

/**
 * 清除登录凭证（登出 / 凭证类失败）。**不动**账号键映射表——登出再登不得换键，
 * 否则本地数据分区会被孤儿化。本函数也不动资料缓存（离线兜底共用这份读路径）；
 * 自愿登出 / 失效强退的**资料与头像缓存清理**是清理清单的独立一步（FR-LOGOUT-03/05，
 * `clearOaProfileCache` + `clearOaAvatarCache`，由 sessionManager 的 signed-out 收口
 * 对 `logout` / `expired` 落定执行）。
 */
export async function clearOaLogin(deps: OaCredentialDeps = defaultDeps()): Promise<void> {
  try {
    const result = deps.secretIo.remove(OA_LOGIN_STORAGE_KEY);
    if (!result.success) log.warn('oa credential remove failed', { error: result.error ?? 'remove_failed' });
  } catch (err) {
    log.warn('oa credential remove failed', { err: errorText(err) });
  }
}

// ── 资料缓存（设计 §4.2：账号键与个人资料落一份本地缓存，离线启动靠它定位数据分区）──
// 与凭证/映射表同住 userData 根（不在 owner 分区内）。**明文 JSON、绝不含口令**：
// 只存展示字段 + 冻结账号键，登录成功覆盖更新。
//
// 隐私边界（PRD §7.2 不展示 = 不落盘，Task 2）：`mobile` / `sex` **绝不写入**缓存文件，
// `licenseId` 更是从未提取（profile.ts 排除裁决）。落盘键集由 profileService.test.ts
// 的 JSON 键集断言钉死；load 侧同样不回填这两项——缓存不充当它们的第二落点。

export interface OaProfileCache {
  accountKey: string;
  loginName: string;
  profile: PersonProfile;
}

const OA_PROFILE_CACHE_FILE = 'hr-oa-profile-cache.json';

function profileCachePath(deps: OaCredentialDeps): string {
  return path.join(path.dirname(deps.mappingFilePath), OA_PROFILE_CACHE_FILE);
}

/** 可落盘的资料字段（隐私边界）：展示字段 + personId（账号键/头像来源）；**键集**里就没有 mobile/sex。 */
function cacheableProfile(profile: PersonProfile): Omit<PersonProfile, 'mobile' | 'sex'> {
  return {
    name: profile.name,
    loginName: profile.loginName,
    dept: profile.dept,
    email: profile.email,
    title: profile.title,
    personId: profile.personId,
  };
}

/** 登录成功落一份（覆盖写，原子替换）；IO 失败只 warn，不阻断登录。 */
export async function saveOaProfileCache(
  input: OaProfileCache,
  deps: OaCredentialDeps = defaultDeps(),
): Promise<void> {
  const file = profileCachePath(deps);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 隐私边界：只序列化 cacheableProfile——mobile/sex 字段键不进 JSON。
    fs.writeFileSync(
      tmp,
      JSON.stringify({ accountKey: input.accountKey, loginName: input.loginName, profile: cacheableProfile(input.profile) }),
      'utf-8',
    );
    fs.renameSync(tmp, file);
  } catch (err) {
    log.warn('oa profile cache write failed', { err: errorText(err) });
  }
}

/** 清资料缓存（FR-LOGOUT-03/05 清理清单）：换号不得留上一人的资料；IO 失败只 warn。 */
export async function clearOaProfileCache(deps: OaCredentialDeps = defaultDeps()): Promise<void> {
  try {
    fs.rmSync(profileCachePath(deps), { force: true });
  } catch (err) {
    log.warn('oa profile cache clear failed', { err: errorText(err) });
  }
}

/** 读资料缓存；缺失 / 损坏 / 形状不符返回 null（缓存坏了不能拖垮离线启动）。 */
export async function loadOaProfileCache(
  deps: OaCredentialDeps = defaultDeps(),
): Promise<OaProfileCache | null> {
  let raw: string;
  try {
    raw = fs.readFileSync(profileCachePath(deps), 'utf-8');
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.accountKey !== 'string' || !record.accountKey) return null;
    if (typeof record.loginName !== 'string') return null;
    const profile = record.profile;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
    const p = profile as Record<string, unknown>;
    const text = (key: string): string => (typeof p[key] === 'string' ? (p[key] as string) : '');
    return {
      accountKey: record.accountKey,
      loginName: record.loginName,
      profile: {
        name: text('name'),
        loginName: text('loginName'),
        dept: text('dept'),
        // 隐私边界：即使旧缓存文件里残留这两项也丢弃，不回填。
        mobile: '',
        email: text('email'),
        title: text('title'),
        sex: '',
        personId: text('personId'),
      },
    };
  } catch {
    return null;
  }
}

// ── 头像缓存（FR-PROFILE-02：缓存键 = personId + s_time，换 s_time 即换键）──
// 与资料缓存同住 userData 根下 `hr-oa-avatar-cache/`（不在 owner 分区内），每键一份
// JSON（contentType + base64 字节），原子替换写入。文件名 = key 的 hex：外部输入
// （personId / s_time）不直接进文件名，防路径注入；key 本身只出现在载荷里供校验。

const OA_AVATAR_CACHE_DIR = 'hr-oa-avatar-cache';

function avatarCacheDir(deps: OaCredentialDeps): string {
  return path.join(path.dirname(deps.mappingFilePath), OA_AVATAR_CACHE_DIR);
}

function avatarCacheFile(deps: OaCredentialDeps, key: string): string {
  return path.join(avatarCacheDir(deps), `${Buffer.from(key, 'utf-8').toString('hex')}.json`);
}

/** 落一份头像（覆盖写）；IO 失败只 warn，不阻断取图回包。 */
export async function saveOaAvatarCache(
  input: AvatarCache,
  deps: OaCredentialDeps = defaultDeps(),
): Promise<void> {
  const file = avatarCacheFile(deps, input.key);
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(avatarCacheDir(deps), { recursive: true });
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        key: input.key,
        contentType: input.contentType,
        bytes: Buffer.from(input.bytes).toString('base64'),
      }),
      'utf-8',
    );
    fs.renameSync(tmp, file);
  } catch (err) {
    log.warn('oa avatar cache write failed', { err: errorText(err) });
  }
}

/** 按缓存键读头像；缺失 / 损坏 / 键不符返回 null。 */
export async function loadOaAvatarCache(
  key: string,
  deps: OaCredentialDeps = defaultDeps(),
): Promise<AvatarCache | null> {
  if (!key) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(avatarCacheFile(deps, key), 'utf-8');
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    // 载荷键必须与请求键一致（防串键读到别人的图）。
    if (record.key !== key) return null;
    if (typeof record.contentType !== 'string' || !record.contentType) return null;
    if (typeof record.bytes !== 'string') return null;
    return {
      key,
      contentType: record.contentType,
      bytes: new Uint8Array(Buffer.from(record.bytes, 'base64')),
    };
  } catch {
    return null;
  }
}

/** 清空头像缓存（登出清理清单；键空间 = person_id+s_time，换号不得留上一人的图）。 */
export async function clearOaAvatarCache(deps: OaCredentialDeps = defaultDeps()): Promise<void> {
  try {
    fs.rmSync(avatarCacheDir(deps), { recursive: true, force: true });
  } catch (err) {
    log.warn('oa avatar cache clear failed', { err: errorText(err) });
  }
}
