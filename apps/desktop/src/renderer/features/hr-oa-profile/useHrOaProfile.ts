/**
 * useHrOaProfile — renderer 侧个人资料状态镜像（FR-PROFILE-01~07 的数据面）。
 *
 * 数据源（Task 2 合同，经 preload 桥）：
 *   - `hrOa:profile`（`fetchProfile(source)` → `ProfileResult`）：FR-PROFILE-07 的
 *     登录 / 启动 / 过期刷新 / 重试取数；`fromCache:true` = 有缓存但刷新失败（
 *     `refresh-error`），`kind:'error'` = 无缓存失败（有资料在手则仍按 `refresh-error`
 *     展示，只是不再有可回落的新数据）。
 *   - `hrOa:avatar`（`getAvatar(sTime)` → `AvatarCache | null`）：头像字节转 blob URL。
 *   - `auth:state-change` 的 `hrProfile` 投影：登录/启动落定后**立即**可展示（G1：
 *     1.5s 内看到姓名），取数结果随后覆盖；signed-out 清空（上一账号资料不得残留）。
 *
 * 状态并集（Ruling A，Task 4 的 ProfileMenu 复用同一类型，不得另造）：
 *   `loading`（无资料且在途）/ `ready` / `ready-avatar-fallback`（头像缺失，首字兜底）/
 *   `refresh-error`（有缓存但刷新失败）/ `error`（无缓存且失败 → 未获取到信息 + 重试）。
 * 优先级：error 面 > refresh-error > 头像兜底点缀 > ready；手动重试**不**回骨架
 * （FR-PROFILE-05「请求中显示重试中…」——错误面保持、按钮文案变），由 `ProfileCard`
 * 按 `onRetry` 回传的 Promise 或 props 变化收口按钮态。
 *
 * 头像 sTime（FR-PROFILE-02 缓存键 = personId + s_time）：真值在资料页
 * `img#sys_person_userpic_img` 的 `s_time` 参数上，Task 2 的 `PersonProfile` 契约未携带
 * （`parsePersonProfile` 不提取）。本层取**会话内稳定近似**：同一 personId 首次取图时
 * 生成一次 `Date.now()` 戳并复用——取图失败不落缓存、下次 `getAvatar` 同键重试；
 * 取图成功落盘后本会话命中缓存；换头像的感知边界 = 下次应用启动（新戳 → 缓存 miss
 * 重取）。残留缓存由登出清理清单（Task 5 `clearOaAvatarCache`）收掉。跟进项：在 main
 * 侧从资料页解析真 `s_time` 并经 PersonProfile 携带，即可精确「换头像即换键」。
 *
 * 隐私红线：`mobile` / `sex` 不进本模块的任何输出面（展示层同样不取）；`licenseId`
 * 不提取（Task 2 解析层已排除）。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

import type { AvatarCache } from '../../../main/hr-oa/avatar';
import type { PersonProfile } from '../../../main/hr-oa/profile';
import type { ProfileResult, ProfileSource } from '../../../main/hr-oa/profileService';
import type { HrOaAuthState } from '../../../main/hr-oa/sessionManager';

/**
 * 个人资料状态并集（Ruling A）：Task 4 `ProfileMenu` 的 `profileState` 复用本类型。
 * 改动 = 同时改两处消费方的文档与用例，不得在 Task 4/5 另立第二套。
 */
export type ProfileState =
  | 'loading'
  | 'ready'
  | 'ready-avatar-fallback'
  | 'refresh-error'
  | 'error';

export interface HrOaProfileView {
  profile: PersonProfile | null;
  state: ProfileState;
  /** 头像字节的 blob URL；无头像 / 取图失败为 null（展示层走首字/人形兜底）。 */
  avatarUrl: string | null;
  /**
   * 触发一次取数（FR-PROFILE-07 的 source 标注）。返回 Promise 供调用方收口
   * 「重试中…」按钮态（签名合同为 void，返回 Promise 是超集，`() => void` 调用方不受影响）。
   */
  refresh: (source: ProfileSource) => void | Promise<void>;
}

interface Snapshot {
  profile: PersonProfile | null;
  state: ProfileState;
  avatarUrl: string | null;
}

const INITIAL: Snapshot = { profile: null, state: 'loading', avatarUrl: null };

let snapshot: Snapshot = INITIAL;
const listeners = new Set<() => void>();
let initialized = false;
let unsubscribeAuth: (() => void) | null = null;
/** 取数序号：reset / 新取数顶掉在途结果（renderer 侧 epoch，对应 main 的 epoch 取消）。 */
let fetchSeq = 0;
let avatarSeq = 0;
/** 会话内稳定的头像版本戳（见文件头 sTime 说明）：按 personId 生成一次、复用。 */
let avatarStamp: { personKey: string; sTime: string } | null = null;

function emit(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function getSnapshot(): Snapshot {
  return snapshot;
}

function personKeyOf(profile: PersonProfile | null): string {
  if (!profile) return '';
  return profile.personId || profile.loginName || profile.name;
}

function profileBridge():
  | ((source: ProfileSource) => Promise<ProfileResult>)
  | null {
  const fn = window.electronAPI?.hrOa?.profile?.fetchProfile;
  return typeof fn === 'function' ? (fn as (source: ProfileSource) => Promise<ProfileResult>) : null;
}

function avatarBridge(): ((sTime: string) => Promise<AvatarCache | null>) | null {
  const fn = window.electronAPI?.hrOa?.avatar?.getAvatar;
  return typeof fn === 'function' ? (fn as (sTime: string) => Promise<AvatarCache | null>) : null;
}

function applyFailure(): void {
  // 有资料在手（缓存回落 / 早前投影）→ refresh-error（信息更新失败 · 重试）；
  // 无资料 → error（未获取到信息 + 重试）。同态再落定也换一次 profile 身份，
  // 让 ProfileCard 的「重试中…」在失败重试后收口（不会卡在按钮上）。
  const had = snapshot.profile !== null;
  if (had && snapshot.profile) emit({ profile: { ...snapshot.profile } });
  emit({ state: had ? 'refresh-error' : 'error' });
}

async function ensureAvatar(profile: PersonProfile): Promise<void> {
  const fetchAvatar = avatarBridge();
  const key = personKeyOf(profile);
  if (!fetchAvatar || !key) {
    // 无桥 / 无身份键：头像视图收口为「无头像」（首字/人形兜底），不改变错误面。
    if (snapshot.state === 'ready') emit({ avatarUrl: null, state: 'ready-avatar-fallback' });
    else emit({ avatarUrl: null });
    return;
  }
  if (!avatarStamp || avatarStamp.personKey !== key) {
    avatarStamp = { personKey: key, sTime: String(Date.now()) };
  }
  const seq = ++avatarSeq;
  try {
    const cache = await fetchAvatar(avatarStamp.sTime);
    if (seq !== avatarSeq) return;
    settleAvatar(cache);
  } catch {
    if (seq !== avatarSeq) return;
    settleAvatar(null);
  }
}

function settleAvatar(cache: AvatarCache | null): void {
  const previous = snapshot.avatarUrl;
  let avatarUrl: string | null = null;
  if (cache?.bytes && cache.bytes.length > 0 && typeof URL.createObjectURL === 'function') {
    const blob = new Blob([cache.bytes as BlobPart], {
      type: cache.contentType || 'application/octet-stream',
    });
    avatarUrl = URL.createObjectURL(blob);
  }
  if (previous && previous !== avatarUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(previous);
  }
  // 错误面（refresh-error / error）不被头像结果改写：按钮与文案是更高优先级的信息。
  const state: ProfileState =
    snapshot.state === 'refresh-error' || snapshot.state === 'error'
      ? snapshot.state
      : avatarUrl
        ? 'ready'
        : 'ready-avatar-fallback';
  emit({ avatarUrl, state });
}

function applySuccess(result: Extract<ProfileResult, { ok: true }>): void {
  const profile = result.profile;
  // IR-04：name 为空视为获取失败（FR-PROFILE-05 的 error 面）。
  if (!profile || !profile.name || !profile.name.trim()) {
    applyFailure();
    return;
  }
  const changedPerson = personKeyOf(snapshot.profile) !== personKeyOf(profile);
  emit({
    profile: { ...profile },
    // 换人（账号切换）不得把上一人的头像带过去；同人刷新保留旧图等新图淡入。
    avatarUrl: changedPerson ? null : snapshot.avatarUrl,
    state: result.fromCache ? 'refresh-error' : 'ready',
  });
  void ensureAvatar(profile);
}

async function runFetch(source: ProfileSource): Promise<void> {
  const fetchProfile = profileBridge();
  if (!fetchProfile) {
    // 桥缺失（老 preload / mock 面）：不伪造数据，落错误面可重试。
    applyFailure();
    return;
  }
  const seq = ++fetchSeq;
  // 手动重试 / 后台刷新都不回骨架：有资料保持现面（FR-PROFILE-05）；首次取数本来
  // 就停在 loading（INITIAL），失败后重试停在 error 面，按钮文案由 ProfileCard 收口。
  let result: ProfileResult;
  try {
    result = await fetchProfile(source);
  } catch {
    if (seq !== fetchSeq) return;
    applyFailure();
    return;
  }
  if (seq !== fetchSeq) return;
  if (!result) {
    applyFailure();
    return;
  }
  if (result.ok === true) {
    applySuccess(result);
    return;
  }
  // kind:'cancelled'（换号/登出在途被丢）：静默，不改面（reset 已换新号）。
  if (result.kind === 'cancelled') return;
  // 'expired'：会话失效由登录层强退（FR-LOGOUT-05），显示面按失败收口即可。
  applyFailure();
}

/**
 * 投影落定（`auth:state-change` 的 `hrProfile` / `hrOa:state` 的 profile）：
 * 有名字即立即可展示（G1），取数结果随后覆盖；同人重复投影不打断现面（现面带
 * fromCache 语义），只在 error 面用投影数据升级回可展示。
 */
function applyProjected(profile: PersonProfile | null | undefined): void {
  if (!profile || !profile.name || !profile.name.trim()) return;
  const current = snapshot.profile;
  const samePerson = current && personKeyOf(current) === personKeyOf(profile);
  if (!current || !samePerson) {
    emit({ profile: { ...profile }, avatarUrl: null, state: 'ready' });
    void ensureAvatar(profile);
    return;
  }
  if (snapshot.state === 'error') {
    emit({ profile: { ...profile }, state: 'ready' });
    void ensureAvatar(profile);
  }
}

function onAuthPush(payload: unknown): void {
  const record = payload as { hrProfile?: PersonProfile | null } | null | undefined;
  const hrProfile = record?.hrProfile ?? null;
  if (!hrProfile) {
    // signed-out / 投影收走：清空资料面（上一账号资料绝不残留，FR-PROFILE-09）。
    // 只清数据不动订阅：本镜像可能还挂着重登后的下一次投影。
    if (snapshot.profile || snapshot.avatarUrl || snapshot.state !== 'loading') {
      clearData();
    }
    return;
  }
  applyProjected(hrProfile);
}

async function seedFromState(): Promise<void> {
  const getState = window.electronAPI?.hrOa?.getState;
  if (typeof getState !== 'function') return;
  try {
    const state = (await getState()) as HrOaAuthState | null;
    if (state && (state.status === 'signed-in' || state.status === 'offline')) {
      applyProjected(state.profile);
    }
  } catch {
    // 种子失败不阻断：launch 取数仍会走完整错误分流。
  }
}

function ensureInit(): void {
  if (initialized) return;
  initialized = true;
  const onAuth = window.electronAPI?.onAuthStateChange;
  if (typeof onAuth === 'function') {
    // onAuthStateChange 回调带 AuthStateChangePayload（含 hrProfile 投影）。
    unsubscribeAuth = (onAuth as (cb: (payload: unknown) => void) => () => void)((payload) =>
      onAuthPush(payload),
    );
  }
  void seedFromState();
  // FR-PROFILE-07：启动且登录态有效时取一次（source='launch'）。
  void runFetch('launch');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureInit();
  return () => {
    listeners.delete(listener);
  };
}

function refresh(source: ProfileSource): void | Promise<void> {
  return runFetch(source);
}

/** 清资料面（signed-out 投影 / 测试复位共用）：在途结果作废，头像 blob 释放。 */
function clearData(): void {
  fetchSeq += 1;
  avatarSeq += 1;
  avatarStamp = null;
  if (snapshot.avatarUrl && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(snapshot.avatarUrl);
  }
  snapshot = INITIAL;
  for (const listener of [...listeners]) listener();
}

/** 测试缝（同 `hrOaAuthStore.__testing` 先例）：跨用例清模块级镜像，不走 `vi.resetModules`。 */
function resetStore(): void {
  unsubscribeAuth?.();
  unsubscribeAuth = null;
  initialized = false;
  clearData();
}

export function useHrOaProfile(): HrOaProfileView {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  return {
    profile: snap.profile,
    state: snap.state,
    avatarUrl: snap.avatarUrl,
    refresh,
  };
}

export const __testing = {
  resetHrOaProfileStore: resetStore,
};
