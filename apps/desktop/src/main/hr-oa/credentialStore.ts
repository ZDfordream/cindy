/**
 * credentialStore.ts — HR OA 门户登录凭证（钥匙串）与账号键映射（main 进程）。
 *
 * 两份持久数据，生命周期分离：
 *   1. **登录凭证**（username / password / accountKey / loginName / expiresAt）——口令只经
 *      `SecretStorageIo` 落盘（与 providerSecretStore / bootstrap-electron safe-storage IPC
 *      **字节级一致**的 safeStorage 密文格式，不新开加密格式），且**不在 owner 分区内**：
 *      静默重登发生在 owner 认领之前，凭证必须先于分区可读。
 *   2. **账号键映射表**——`loginName → { accountKey, expiresAt }`，落 `userData` 根下全局
 *      明文 JSON（同样不在 owner 分区内，后续任务在 owner 出现前就要查它），原子替换写入。
 *
 * 账号键**冻结在首次登录**：映射表里已有条目就永远回冻结键，之后资料里出现的 personId 只进
 * 资料字段，不得顶替账号键——否则 dataOwner 换键会把本地数据分区整体孤儿化。条目的
 * expiresAt 是登录时效（save 时滑动刷新），供后续任务判断新鲜度；**不**参与冻结判定。
 * clearOaLogin 只清凭证密文，映射表保留（登出再登不得换键）。
 *
 * 安全红线：口令明文只出现在 secret IO 的密文槽与返回给会话恢复的 OaStoredLogin 里；
 * 映射表、日志与错误文本绝不含口令。
 */

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import type { SecretStorageIo } from '../secrets/providerSecretStore.js';
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

/** 缺失 / 损坏 / 过期均返回 null；过期或损坏的密文顺手清除。 */
export async function loadOaLogin(
  now?: number,
  deps: OaCredentialDeps = defaultDeps(),
): Promise<OaStoredLogin | null> {
  let raw: string | null;
  try {
    raw = deps.secretIo.read(OA_LOGIN_STORAGE_KEY);
  } catch (err) {
    log.warn('oa credential read failed', { err: errorText(err) });
    return null;
  }
  if (raw == null) return null;
  const record = parseStoredLogin(raw);
  const at = now ?? (deps.now ?? Date.now)();
  if (!record || at >= record.expiresAt) {
    try {
      deps.secretIo.remove(OA_LOGIN_STORAGE_KEY);
    } catch (err) {
      log.warn('oa credential remove failed', { err: errorText(err) });
    }
    return null;
  }
  return record;
}

/**
 * 清除登录凭证（登出 / 凭证类失败）。**不动**账号键映射表——登出再登不得换键，
 * 否则本地数据分区会被孤儿化。
 */
export async function clearOaLogin(deps: OaCredentialDeps = defaultDeps()): Promise<void> {
  try {
    const result = deps.secretIo.remove(OA_LOGIN_STORAGE_KEY);
    if (!result.success) log.warn('oa credential remove failed', { error: result.error ?? 'remove_failed' });
  } catch (err) {
    log.warn('oa credential remove failed', { err: errorText(err) });
  }
}
