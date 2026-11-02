/**
 * profileService.ts — 登录人个人资料 / 头像的取数编排（main 进程）。
 *
 * 资料来源是**登录人自己的 OA 会话**直连门户（`client.getPersonProfile`，复用
 * `parsePersonProfile` 的固定字段来源），**绝不走 HRMcp MCP**——那是单账号工具，
 * 接了会显示成 HRMcp 那个号而不是当前登录人（集成设计 §4.1 反目标）。
 *
 * 职责合同（Task 2）：
 *   1. **单飞**：同 epoch 的并发 `fetchProfile` 合并为一次门户请求；
 *   2. **epoch 取消**：`cancelOutstanding()` / `bumpEpoch()`（logout / 账号切换）后，
 *      迟到结果一律丢弃为 `{ok:false,kind:'cancelled'}` 且**不写缓存**——上一个账号的
 *      资料绝不能落进下一个账号的缓存；epoch 推进后新取数不得被 stale 在途请求挂住；
 *   3. **失败分流**：会话失效（anonym.jsp 重登失败，OaLoginError 会话语义）→
 *      `'expired'`（FR-LOGOUT-05 强退源，终态、**不**回落缓存）；其余失败在有同账号
 *      缓存时 `{ok:true, fromCache:true}` 兜底（串号缓存不采信），没有则 `'error'`；
 *   4. **缓存写入**：成功即覆盖写资料缓存，键 = **冻结** accountKey（经
 *      `resolveAccountKey`，后到的 personId 不得顶替——键漂移 = 换 dataOwner）；
 *   5. **头像编排**：`getAvatar(sTime)` 按缓存键 `personId + s_time`（FR-PROFILE-02）
 *      先读盘、miss 才取图（`fetchAvatar`，同会话、10s 超时、失败回 null）并落盘。
 *
 * 客户端超时 10s：oaClient / fetchAvatar 各自的本端超时哨兵，本层不另设。
 * 隐私红线：mobile / sex 不进缓存盘（credentialStore 收口）；person_id / 口令不进日志。
 */

import { createLogger } from '../logger.js';

import { avatarCacheKey, fetchAvatar, type AvatarCache } from './avatar.js';
import { OaLoginError } from './errors.js';
import { SESSION_RECOVERY_FAIL_MSG, type OaClient, type OaTransport } from './oaClient.js';
import type { PersonProfile } from './profile.js';

/** 取数触发源（信息性标注，供上层/日志区分场景；不改变分流行为）。 */
export type ProfileSource = 'login' | 'launch' | 'stale' | 'retry';

export type ProfileResult =
  | { ok: true; profile: PersonProfile; fromCache: false }
  | { ok: true; profile: PersonProfile; fromCache: true }
  | { ok: false; kind: 'error' | 'expired' | 'cancelled' };

export interface ProfileService {
  fetchProfile(source: ProfileSource): Promise<ProfileResult>;
  /** 放弃在途取数（迟到结果丢弃为 cancelled、不写缓存）；下次 fetchProfile 照常。 */
  cancelOutstanding(): void;
  /** 切换 epoch（logout / 账号切换）：旧 epoch 在途结果丢弃；返回新 epoch。 */
  bumpEpoch(): number;
  getAvatar(sTime: string): Promise<AvatarCache | null>;
}

export function createProfileService(deps: {
  client: OaClient;
  cache: typeof import('./credentialStore');
  now?: () => number;
  /**
   * 头像拉取通道（与 client 同一 OA 会话 / OaTransport）。缺省时 `getAvatar` 只读
   * 磁盘缓存、miss 回 null（构造器合同只有 client + cache；此为 additive 注入点）。
   */
  avatar?: { baseUrl: string; transport: OaTransport };
}): ProfileService {
  const { client, cache } = deps;
  const log = createLogger('hr-oa');
  let epoch = 0;
  let inFlight: { epoch: number; promise: Promise<ProfileResult> } | null = null;
  /** 头像单飞按 sTime 合并（同一头像版本的并发调用只取一张图）。 */
  const avatarInFlight = new Map<string, { epoch: number; promise: Promise<AvatarCache | null> }>();
  /** 最近一次取数认领的 personId（头像键左半）；冷启动由资料缓存兜底。 */
  let lastPersonId = '';

  function invalidate(): number {
    epoch += 1;
    // 身份随 epoch 失效：换号后旧 personId 不得继续拼头像键。
    lastPersonId = '';
    return epoch;
  }

  function isCancelled(startEpoch: number): boolean {
    return startEpoch !== epoch;
  }

  /** 会话语义（Ruling 4 复用 network_error）：只有 anonym.jsp 重登失败标记算会话失效。 */
  function isSessionExpired(e: unknown): boolean {
    return e instanceof OaLoginError && e.message === SESSION_RECOVERY_FAIL_MSG;
  }

  /**
   * 可信缓存身份（缓存回落与头像 personId 共用）：资料缓存**只有在当前凭证可读且
   * accountKey 对得上**时才采信。凭证读不出（含登出后——凭证清了、缓存按 Task 1 裁决
   * **故意保留**）一律不采信：那正是上一账号残骸，采信 = 把别人的资料/头像当成当前人
   * （Review Finding 1）。Task 1 的离线认领（钥匙串读不出时用缓存冻结键落 offline）在
   * sessionManager 里**直接读缓存**、不经过本函数，不受此收紧影响。
   */
  async function verifiedCachedProfile(): Promise<PersonProfile | null> {
    const rec = await cache.loadOaProfileCache();
    if (!rec) return null;
    const stored = await cache.loadOaLogin();
    if (!stored || rec.accountKey !== stored.accountKey) return null;
    return rec.profile;
  }

  async function runFetch(startEpoch: number, source: ProfileSource): Promise<ProfileResult> {
    // source 是触发源标注（封闭集合、非敏感），只进 debug 级日志，不改变分流行为。
    log.debug('[hr-oa] profile fetch', { source });
    try {
      const profile = await client.getPersonProfile();
      if (isCancelled(startEpoch)) return { ok: false, kind: 'cancelled' };
      lastPersonId = profile.personId || lastPersonId;
      // 键 = 冻结 accountKey：personId 只进资料字段，不得顶替（键漂移 = 换 dataOwner）。
      const accountKey = cache.resolveAccountKey(profile.loginName, profile);
      await cache.saveOaProfileCache({ accountKey, loginName: profile.loginName, profile });
      return { ok: true, profile, fromCache: false };
    } catch (e) {
      if (isCancelled(startEpoch)) return { ok: false, kind: 'cancelled' };
      // 会话失效是终态（FR-LOGOUT-05 强退源）：不得被缓存兜底盖成「看起来还活着」。
      if (isSessionExpired(e)) return { ok: false, kind: 'expired' };
      const cached = await verifiedCachedProfile();
      if (isCancelled(startEpoch)) return { ok: false, kind: 'cancelled' };
      if (cached) return { ok: true, profile: cached, fromCache: true };
      return { ok: false, kind: 'error' };
    }
  }

  function fetchProfile(source: ProfileSource): Promise<ProfileResult> {
    if (inFlight && inFlight.epoch === epoch) return inFlight.promise;
    const startEpoch = epoch;
    let entry: { epoch: number; promise: Promise<ProfileResult> };
    const promise = runFetch(startEpoch, source).then((result) => {
      if (inFlight === entry) inFlight = null;
      return result;
    });
    entry = { epoch: startEpoch, promise };
    inFlight = entry;
    return promise;
  }

  async function runAvatar(sTime: string): Promise<AvatarCache | null> {
    const startEpoch = epoch;
    // personId 两源：本进程最近一次成功取数（会话活时认领的）；缺省从**已验明归属**的
    // 资料缓存兜底（无凭证/串号缓存不得当身份源，Review Finding 1）。
    const personId = lastPersonId || (await verifiedCachedProfile())?.personId || '';
    if (!personId || !sTime) return null;
    const key = avatarCacheKey(personId, sTime);
    const hit = await cache.loadOaAvatarCache(key);
    if (hit) return hit;
    const channel = deps.avatar;
    if (!channel) return null;
    const fetched = await fetchAvatar({
      baseUrl: channel.baseUrl,
      transport: channel.transport,
      personId,
      sTime,
    });
    if (!fetched) return null;
    // 迟到结果（logout / 换号在途）丢弃且不落盘：上一账号的图不得进缓存。
    if (isCancelled(startEpoch)) return null;
    await cache.saveOaAvatarCache(fetched);
    return fetched;
  }

  function getAvatar(sTime: string): Promise<AvatarCache | null> {
    const existing = avatarInFlight.get(sTime);
    if (existing && existing.epoch === epoch) return existing.promise;
    let entry: { epoch: number; promise: Promise<AvatarCache | null> };
    const promise = runAvatar(sTime).then((result) => {
      if (avatarInFlight.get(sTime) === entry) avatarInFlight.delete(sTime);
      return result;
    });
    entry = { epoch, promise };
    avatarInFlight.set(sTime, entry);
    return promise;
  }

  return {
    fetchProfile,
    cancelOutstanding: invalidate,
    bumpEpoch: invalidate,
    getAvatar,
  };
}
