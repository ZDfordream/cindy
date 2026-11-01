/**
 * sessionManager.ts — HR OA 登录态生命周期（main 进程）。
 *
 * 状态机：`signed-out` ↔ `signed-in` / `offline`。**失败分流是核心**：
 *   - 只有凭证类失败（wrong_credentials / locked）清钥匙串并落 `signed-out`；
 *   - 网络类失败（network_error / timeout）**保留**凭证、进 `offline`（home 仍可读，
 *     commitSession('hr', key)）——VPN 抖动绝不能把人锁在门外；
 *   - 资料拉取失败不阻断登录，账号键退化用已缓存的冻结键（键按缓存，不回空）。
 *
 * Ruling 3：**显式** login() 失败只回 `{ error: kind }`——登录页留在原地出内联错误，
 * 不产生 offline、不改状态、不动存量凭证（被测的是手输口令；误清会连坐钥匙串里另一份
 * 可能仍有效的凭证）。`offline` 只由 startup() 的静默重登产生。
 *
 * logout() 必须 `client.resetSession()`：OA client 在内存里记着口令做会话恢复，
 * 不复位会把口令跨登出留在进程里。凭证持久化走 credentialStore（口令不进日志）。
 */

import type { OaLoginFailure } from './errors.js';
import type { OaClient } from './oaClient.js';
import type { PersonProfile } from './profile.js';

export type HrOaAuthState =
  | { status: 'signed-out' }
  | { status: 'offline'; accountKey: string; profile: PersonProfile }
  | { status: 'signed-in'; accountKey: string; profile: PersonProfile };

export interface HrOaSessionManager {
  /** 冷启动静默重登（有凭证才打网络）；返回落定后的状态。 */
  startup(): Promise<HrOaAuthState>;
  /** 显式登录；失败只回 `{ error }` 且不改状态（Ruling 3）。 */
  login(username: string, password: string): Promise<HrOaAuthState | { error: OaLoginFailure }>;
  logout(): Promise<void>;
  getState(): HrOaAuthState;
  onDidChange(listener: (state: HrOaAuthState) => void): () => void;
}

export function createHrOaSessionManager(deps: {
  client: OaClient;
  credentials: typeof import('./credentialStore');
  commitSession: (mode: 'hr' | 'signed-out', owner?: string | null) => void;
  now?: () => number;
}): HrOaSessionManager {
  const { client, credentials, commitSession } = deps;
  const now = deps.now ?? Date.now;
  let state: HrOaAuthState = { status: 'signed-out' };
  const listeners = new Set<(s: HrOaAuthState) => void>();

  function blankProfile(): PersonProfile {
    return {
      name: '',
      loginName: '',
      dept: '',
      mobile: '',
      email: '',
      title: '',
      sex: '',
      personId: '',
    };
  }

  /** 落定状态：先 commit 会话（IPC 投影推送前 app session 必须已就位），再通知订阅者。 */
  function settle(next: HrOaAuthState): HrOaAuthState {
    state = next;
    if (next.status === 'signed-out') commitSession('signed-out');
    else commitSession('hr', next.accountKey);
    for (const listener of listeners) listener(next);
    return next;
  }

  async function startup(): Promise<HrOaAuthState> {
    const stored = await credentials.loadOaLogin(now());
    if (!stored) {
      // 无凭证：保持 signed-out，不 commit——ensureLoaded 的启动归一已经把会话放在
      // signed-out/local，HR 不该在这里踩掉 local。
      state = { status: 'signed-out' };
      for (const listener of listeners) listener(state);
      return state;
    }
    const outcome = await client.login(stored.username, stored.password);
    if (!outcome.ok) {
      if (outcome.kind === 'wrong_credentials' || outcome.kind === 'locked') {
        // 凭证类失败：被测的正是钥匙串里这份 → 清除并落 signed-out。
        await credentials.clearOaLogin();
        client.resetSession();
        return settle({ status: 'signed-out' });
      }
      // 网络类失败：凭证保留，offline home 仍可读。
      return settle({ status: 'offline', accountKey: stored.accountKey, profile: blankProfile() });
    }
    let profile: PersonProfile | null = null;
    try {
      profile = await client.getPersonProfile();
    } catch {
      profile = null;
    }
    if (!profile) {
      // 资料失败不阻断登录：键按已缓存的冻结键，凭证保留（不重写，避免按错 loginName 重解）。
      return settle({ status: 'signed-in', accountKey: stored.accountKey, profile: blankProfile() });
    }
    const loginName = profile.loginName || stored.loginName || stored.username;
    // 键按已缓存的冻结键：资料再全也不许换键（键漂移 = 换 dataOwner）；存量缺键才走冻结解析。
    const accountKey = stored.accountKey || credentials.resolveAccountKey(loginName, profile);
    await credentials.saveOaLogin({
      username: stored.username,
      password: stored.password,
      // save 内部按 profile.loginName || username 认映射键；与上面 resolve 用同一键
      // （资料缺 loginName 时回填已存键），避免同一账号在映射表里裂成两个键。
      profile: { ...profile, loginName },
      now: now(),
    });
    return settle({ status: 'signed-in', accountKey, profile });
  }

  async function login(
    username: string,
    password: string,
  ): Promise<HrOaAuthState | { error: OaLoginFailure }> {
    const outcome = await client.login(username, password);
    if (!outcome.ok) {
      // Ruling 3：显式失败留在登录页出内联错误；不动状态、不动存量凭证。
      return { error: outcome.kind };
    }
    let profile: PersonProfile | null = null;
    try {
      profile = await client.getPersonProfile();
    } catch {
      profile = null;
    }
    const effective = profile ?? blankProfile();
    // Review Focus #3（账号键漂移）：显式登录同样必须续用已冻结的键。先读存量凭证——
    // 同一 username 的冻结键/映射键接着用；资料页不可用时尤其不能退化成用 username
    // 另起新键（那会换掉 dataOwner、把本地数据分区孤儿化）。
    const stored = await credentials.loadOaLogin(now());
    const cached = stored && stored.username === username ? stored : null;
    const loginName = effective.loginName || cached?.loginName || username;
    await credentials.saveOaLogin({
      username,
      password,
      // 与冻结键同源的映射键（回填 loginName）：save 内部不得另起键重解账号键。
      profile: { ...effective, loginName },
      now: now(),
    });
    const saved = await credentials.loadOaLogin(now());
    const accountKey =
      cached?.accountKey ||
      (saved && saved.username === username ? saved.accountKey : null) ||
      credentials.resolveAccountKey(loginName, effective);
    return settle({ status: 'signed-in', accountKey, profile: effective });
  }

  async function logout(): Promise<void> {
    await credentials.clearOaLogin();
    // OA client 内存里记着口令做会话恢复——登出必须复位，防口令跨登出滞留。
    client.resetSession();
    settle({ status: 'signed-out' });
  }

  function getState(): HrOaAuthState {
    return state;
  }

  function onDidChange(listener: (s: HrOaAuthState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return { startup, login, logout, getState, onDidChange };
}
