/**
 * sessionManager.ts — HR OA 登录态生命周期（main 进程）。
 *
 * 状态机：`signed-out` ↔ `signed-in` / `offline`。**失败分流是核心**：
 *   - 只有凭证类失败（wrong_credentials / locked）清钥匙串并落 `signed-out`；
 *   - 网络类失败（network_error / timeout）**保留**凭证、进 `offline`（home 仍可读，
 *     commitSession('hr', key)）——VPN 抖动绝不能把人锁在门外；
 *   - 资料拉取失败不阻断登录，账号键退化用已缓存的冻结键（键按缓存，不回空）。
 *
 * signed-out 的 `reason`（Finding 1 / 4，FR-SESSION-02 的失效 toast 判据）：
 *   - `expired`：**曾有**凭证但已失效——凭证类失败 / TTL 过期。渲染层
 *     弹「登录已过期，请重新登录」，**冷启动也弹**（不再依赖 in-process 落差）。
 *   - `logout`：主动登出（logout() 是唯一自愿来源），兄弟窗口据此一并抑制失效 toast。
 *   - 缺省：无凭证首启 / 显式登录前——不是失效，不弹。
 *
 * 离线契约（设计 §4.2，Finding 2）：`network_error` / `timeout` 保留凭证 + 资料缓存
 * 落的本地资料离线可读；网络恢复（`networkRecovered()`，渲染层 `window 'online'` 触发）
 * 静默重登刷新会话，成功回 `signed-in`。发送不可用与模型连通「未知」在渲染层按
 * `offline` 状态收口，不在此处。
 *
 * Ruling 3：**显式** login() 失败只回 `{ error: kind }`——登录页留在原地出内联错误，
 * 不产生 offline、不改状态、不动存量凭证（被测的是手输口令；误清会连坐钥匙串里另一份
 * 可能仍有效的凭证）。`offline` 只由 startup() / networkRecovered() 的静默重登产生。
 *
 * logout() 必须 `client.resetSession()`：OA client 在内存里记着口令做会话恢复，
 * 不复位会把口令跨登出留在进程里。凭证持久化走 credentialStore（口令不进日志）。
 *
 * 账号隔离（设计 §4.2「退出登录清 cookie」，P0 真机 2026-11-01）：凡落 `signed-out`
 * （登出 / 凭证类失效 / TTL 过期 / 无凭证首启）都必须清门户 cookie jar（deps.clearCookies
 * 回调），否则旧会话残留在 persist:hr-oa 分区——下一个账号的错口令会被蓝凌按旧会话
 * 302 到 `/`、「判成功」落进前一个账号。顺序合同：清完 cookie 才落状态——落定后
 * 渲染层可立即发起新登录，fire-and-forget 迟到落地的清 cookie 会误删新会话。
 * 与 `client.resetSession()` 的边界：resetSession 清内存里记住的登录凭据（会话恢复用），
 * clearCookies 清门户会话 cookie（服务端登录态）——两件事都做，不互相替代。
 */

import { createLogger } from '../logger.js';

import type { OaLoginFailure } from './errors.js';
import type { OaClient } from './oaClient.js';
import type { PersonProfile } from './profile.js';
import type { OaStoredLogin } from './credentialStore.js';

/**
 * signed-out 的来源分类（FR-SESSION-02）：`expired` = 曾有凭证的失效（凭证类失败 /
 * TTL 过期）→ 冷启动也弹「登录已过期」；`logout` = 主动登出 → 抑制 toast；
 * 缺省 = 无凭证首启，不是失效。
 */
export type HrOaSignedOutReason = 'logout' | 'expired';

export type HrOaAuthState =
  | { status: 'signed-out'; reason?: HrOaSignedOutReason }
  | { status: 'offline'; accountKey: string; profile: PersonProfile }
  | { status: 'signed-in'; accountKey: string; profile: PersonProfile };

/**
 * 密文「暂时读不出」的重试次数（不含首次）。真机启动期 safeStorage 后端未就绪是
 * 一次性抖动（同一次启动内稍后即可读写），轻量重试即可恢复；仍读不出则按离线
 * 契约落定，绝不落 signed-out（凭证还在）。
 */
const LOAD_RETRY_ATTEMPTS = 2;

export interface HrOaSessionManager {
  /** 冷启动静默重登（有凭证才打网络）；返回落定后的状态。 */
  startup(): Promise<HrOaAuthState>;
  /** 显式登录；失败只回 `{ error }` 且不改状态（Ruling 3）。 */
  login(username: string, password: string): Promise<HrOaAuthState | { error: OaLoginFailure }>;
  logout(): Promise<void>;
  /**
   * 网络恢复后的静默重登（设计 §4.2）：只在 `offline` 落定后生效，其余状态原样返回；
   * 并发触发（多窗口同响 `online`）单飞合并。成功回 `signed-in`，网络类失败留在
   * `offline`，凭证类失败落 `signed-out` + `reason:'expired'`。
   */
  networkRecovered(): Promise<HrOaAuthState>;
  getState(): HrOaAuthState;
  onDidChange(listener: (state: HrOaAuthState) => void): () => void;
}

export function createHrOaSessionManager(deps: {
  client: OaClient;
  credentials: typeof import('./credentialStore');
  commitSession: (mode: 'hr' | 'signed-out', owner?: string | null) => void;
  now?: () => number;
  /**
   * 清门户 cookie jar（设计 §4.2）。可选以保持既有调用签名可用；生产接线
   * （bootstrap-electron）必须传 `HrOaSessionTransport.clearCookies`——缺省时
   * signed-out 收口不动作，旧门户会话会跨账号残留（P0 账号隔离）。
   */
  clearCookies?: () => Promise<void> | void;
}): HrOaSessionManager {
  const { client, credentials, commitSession } = deps;
  const now = deps.now ?? Date.now;
  const clearCookies = deps.clearCookies;
  const log = createLogger('hr-oa');
  let state: HrOaAuthState = { status: 'signed-out' };
  const listeners = new Set<(s: HrOaAuthState) => void>();
  /** networkRecovered 的单飞闸：多窗口同响 `online` 只跑一轮静默重登。 */
  let reconnectInFlight: Promise<HrOaAuthState> | null = null;

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

  /** 无 commit 的通知（无凭证首启：保持 signed-out，不踩 ensureLoaded 的启动归一）。 */
  function notifyOnly(next: HrOaAuthState): HrOaAuthState {
    state = next;
    for (const listener of listeners) listener(next);
    return next;
  }

  /** 脱敏（凭证红线）：错误文本里的口令残渣 / 带 query 的完整地址 / 表单字段一律抹掉。 */
  function scrubErrorText(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e);
    return text
      .replace(/\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s?#]*)\?[^#\s]*/g, '$1')
      .replace(/(?:\b(?:j_username|j_password)=[^&\s]*&?)+/gi, '***');
  }

  /**
   * 清门户 cookie（非致命）：收口失败不得拦住登出/凭证清除（本地状态必须落定），
   * 但原因必须落一条脱敏 warn。
   */
  async function clearPortalCookies(): Promise<void> {
    try {
      await clearCookies?.();
    } catch (e) {
      log.warn(`[hr-oa] clear portal cookies failed (non-fatal): ${scrubErrorText(e)}`);
    }
  }

  /**
   * signed-out 收口（设计 §4.2，账号隔离）：**先清门户 cookie、再落状态**。
   * 顺序合同：状态落定后渲染层可立即发起下一次登录，迟到落地的清 cookie 会误删
   * 新登录种下的会话；所以清 cookie 是落定前的同步门，不是落定后的旁路通知。
   */
  async function dropToSignedOut(
    reason: HrOaSignedOutReason | undefined,
    notify: boolean,
  ): Promise<HrOaAuthState> {
    await clearPortalCookies();
    const next: HrOaAuthState = reason ? { status: 'signed-out', reason } : { status: 'signed-out' };
    return notify ? notifyOnly(next) : settle(next);
  }

  /**
   * 离线资料来源（设计 §4.2 资料缓存）：登录成功落的本地缓存与本次凭证的冻结键
   * 对得上才用；对不上（缓存串号 / 缺失）宁可 blank，不展示别人 / 空资料以外的东西。
   */
  async function offlineProfile(stored: OaStoredLogin): Promise<PersonProfile> {
    const cache = await credentials.loadOaProfileCache();
    return cache && cache.accountKey === stored.accountKey ? cache.profile : blankProfile();
  }

  /** 拉资料（失败不阻断登录，回 null 由调用方按缓存键退化）。 */
  async function fetchProfile(): Promise<PersonProfile | null> {
    try {
      return await client.getPersonProfile();
    } catch {
      return null;
    }
  }

  /**
   * 静默重登（startup 与网络恢复共用一条链）：凭证类失败清钥匙串落 `expired`；
   * 网络类失败保留凭证进 offline（资料用本地缓存）；成功签入并刷新凭证与资料缓存。
   */
  async function silentRelogin(stored: OaStoredLogin): Promise<HrOaAuthState> {
    const outcome = await client.login(stored.username, stored.password);
    if (!outcome.ok) {
      if (outcome.kind === 'wrong_credentials' || outcome.kind === 'locked') {
        // 凭证类失败：被测的正是钥匙串里这份 → 清除并落 signed-out（失效 toast 来源）。
        // 门户 cookie 一并收口（dropToSignedOut）：凭证没了，旧门户会话不得继续存活。
        await credentials.clearOaLogin();
        client.resetSession();
        return dropToSignedOut('expired', false);
      }
      // 网络类失败：凭证保留，offline home 仍可读（资料走本地缓存）。
      return settle({
        status: 'offline',
        accountKey: stored.accountKey,
        profile: await offlineProfile(stored),
      });
    }
    const profile = await fetchProfile();
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
    await credentials.saveOaProfileCache({ accountKey, loginName, profile });
    return settle({ status: 'signed-in', accountKey, profile });
  }

  /**
   * 密文在盘但暂时读不出（safeStorage 后端未就绪 / 解密瞬时异常，真机启动期常态）：
   * **绝不**落 signed-out 回 S1、更不清凭证——凭证还在，只是这一刻读不到。按离线
   * 契约用资料缓存认领账号键进 offline home；钥匙串恢复后（networkRecovered / 12h
   * 刷新）静默重登转 signed-in。缓存缺失认领不了数据分区时才退回 signed-out（仍
   * 不清凭证、不弹失效）。
   */
  async function settleCredentialUnavailable(): Promise<HrOaAuthState> {
    const cache = await credentials.loadOaProfileCache();
    if (!cache?.accountKey) {
      log.warn('[hr-oa] credential unreadable and no profile cache owner; staying signed-out');
      return notifyOnly({ status: 'signed-out' });
    }
    return settle({ status: 'offline', accountKey: cache.accountKey, profile: cache.profile });
  }

  /**
   * 分流版 load + 瞬时读抖动重试：`unavailable`（密文在盘、暂时读不出）不立即
   * 当终局——真机启动期 safeStorage 后端未就绪是一次性抖动（同一次启动内稍后即可
   * 读写），重试几次仍读不出才转 offline 落定。
   */
  async function loadStoredLoginWithRetry(): Promise<
    Awaited<ReturnType<typeof credentials.loadOaLoginDetailed>>
  > {
    let loaded = await credentials.loadOaLoginDetailed(now());
    for (let attempt = 0; attempt < LOAD_RETRY_ATTEMPTS && loaded.status === 'unavailable'; attempt += 1) {
      loaded = await credentials.loadOaLoginDetailed(now());
    }
    return loaded;
  }

  async function startup(): Promise<HrOaAuthState> {
    const loaded = await loadStoredLoginWithRetry();
    if (loaded.status === 'unavailable') {
      return settleCredentialUnavailable();
    }
    if (loaded.status === 'none') {
      // 无凭证：保持 signed-out、不 commit——ensureLoaded 的启动归一已经把会话放在
      // signed-out/local，HR 不该在这里踩掉 local。无 reason = 首启，不是失效。
      // 仍收口门户 cookie（notify 路径）：凭证不在了，旧门户会话不得跨到登录门后。
      return dropToSignedOut(undefined, true);
    }
    if (loaded.status === 'expired') {
      // TTL 过期：曾有凭证的失效（FR-SESSION-02）→ reason:'expired'，
      // 渲染层冷启动也弹「登录已过期」；load 侧已顺手清掉密文。门户 cookie 同口径收口。
      return dropToSignedOut('expired', false);
    }
    return silentRelogin(loaded.record);
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
    const profile = await fetchProfile();
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
    // 资料缓存（设计 §4.2）：登录成功覆盖更新；只落展示字段 + 冻结键，绝不含口令。
    // 资料拉取失败时不动旧缓存（下次成功登录覆盖），离线兜底保留更好的那份。
    if (profile) {
      await credentials.saveOaProfileCache({ accountKey, loginName, profile: effective });
    }
    return settle({ status: 'signed-in', accountKey, profile: effective });
  }

  async function logout(): Promise<void> {
    await credentials.clearOaLogin();
    // OA client 内存里记着口令做会话恢复——登出必须复位，防口令跨登出滞留。
    // （resetSession 清内存凭据；门户 cookie 由 dropToSignedOut 清，两件事都做。）
    client.resetSession();
    // reason:'logout' 随状态推送：兄弟窗口（无 voluntary 标记）据此抑制失效 toast。
    await dropToSignedOut('logout', false);
  }

  async function networkRecovered(): Promise<HrOaAuthState> {
    if (state.status !== 'offline') return state;
    if (reconnectInFlight) return reconnectInFlight;
    reconnectInFlight = (async () => {
      try {
        const loaded = await loadStoredLoginWithRetry();
        if (loaded.status === 'unavailable') {
          // 密文在盘但暂时读不出：凭证还在，留在 offline 等下一次恢复信号，不得
          // 按失效清人（误清 = 真机「清凭证」签名）。
          return state;
        }
        if (loaded.status !== 'ok') {
          // 离线期间凭证到期 / 消失（含外部清钥匙串）：曾有会话却回不去 → 按失效处理
          // （FR-SESSION-02 的「凭证过期」分支），不把人无解释地丢回 S1。
          return dropToSignedOut('expired', false);
        }
        return await silentRelogin(loaded.record);
      } finally {
        reconnectInFlight = null;
      }
    })();
    return reconnectInFlight;
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

  return { startup, login, logout, networkRecovered, getState, onDidChange };
}
