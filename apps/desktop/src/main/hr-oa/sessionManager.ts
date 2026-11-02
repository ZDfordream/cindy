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
 * 密文「暂时读不出」的重试退避（毫秒，每次重试前等待；次数 = 数组长度）。
 * 真机启动期 safeStorage 后端未就绪的窗口是**秒级**（`appReady:false` 时探测失败、
 * ready 后才恢复），零间隔连读盖不住——退避让重试真正跨过未就绪窗口；预算封顶约
 * 1s，不拖长冷启动门禁。窗口更长的恢复由 `retryCredentialLoad`（聚焦触发）兜住。
 */
const LOAD_RETRY_DELAYS_MS = [250, 750];

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
  /**
   * 环境恢复后的凭证读重试（main 侧窗口聚焦信号触发；12h 刷新调度器是 Task 8 的
   * 交付物、此处尚不存在）：只在 startup 曾落「密文在盘但读不出」的 offline（或
   * 该边角的 signed-out 退化）时动作——读回正本即静默重登转 `signed-in`；无待恢复
   * 零动作（聚焦高频，不得重打网络）。与 `networkRecovered` 同一条单飞链。
   */
  retryCredentialLoad(): Promise<HrOaAuthState>;
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
  /**
   * 重试退避的等待原语（缺省真实 setTimeout）。测试注入假实现记录时长，避免
   * 单测里出现真实等待（性能预算）。
   */
  wait?: (ms: number) => Promise<void> | void;
  /**
   * 账号认领边界回调（Review Finding 2 / Controller Ruling D）：**离开**当前账号身份
   * 时触发——落 `signed-out`（登出 / 凭证类失效 / TTL 过期）或 accountKey 换人。资料层
   * 在此 `bumpEpoch()` 作废在途取数（否则登出窗口里迟到的 fetchProfile 会把上一账号的
   * 资料写进缓存、当成功回包）。同人 offline↔signed-in 抖动**不**触发（不是身份边界）；
   * 从 signed-out 进入登录也不触发（没有可离开的旧身份）。可选以保既有调用签名。
   */
  onAccountBoundary?: () => void;
}): HrOaSessionManager {
  const { client, credentials, commitSession } = deps;
  const now = deps.now ?? Date.now;
  const clearCookies = deps.clearCookies;
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = createLogger('hr-oa');
  let state: HrOaAuthState = { status: 'signed-out' };
  const listeners = new Set<(s: HrOaAuthState) => void>();
  /** networkRecovered / retryCredentialLoad 的单飞闸：并发触发只跑一轮静默重登。 */
  let reconnectInFlight: Promise<HrOaAuthState> | null = null;
  /**
   * startup 曾落「密文在盘但读不出」：待钥匙串恢复后由 retryCredentialLoad 收口。
   * **生命周期合同**：只描述 startup 的读出楔子；凡用户显式会话转移（`login()` 成功 /
   * `logout()`）即视为已被取代、就地清零——stale 标记会让下一次聚焦触发 silentRelogin，
   * 把手动登录后的健康 `signed-in` 打回 `offline`（Break A），或把主动登出后的
   * `reason:'logout'` 翻成 `reason:'expired'`（Break B，FR-HOME-03 破口）。
   */
  let credentialLoadPending = false;

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

  /**
   * 账号认领边界（Review Finding 2）：离开**已知**账号身份（→ signed-out 或换
   * accountKey）才触发 `onAccountBoundary`；`state` 是落定前的旧值。资料层据此
   * bumpEpoch，登出/换号后迟到的取数结果作废、不写缓存。
   */
  function notifyAccountBoundary(next: HrOaAuthState): void {
    const prevKey = state.status === 'signed-out' ? null : state.accountKey;
    const nextKey = next.status === 'signed-out' ? null : next.accountKey;
    if (prevKey && nextKey !== prevKey) deps.onAccountBoundary?.();
  }

  /** 落定状态：先 commit 会话（IPC 投影推送前 app session 必须已就位），再通知订阅者。 */
  function settle(next: HrOaAuthState): HrOaAuthState {
    notifyAccountBoundary(next);
    state = next;
    if (next.status === 'signed-out') commitSession('signed-out');
    else commitSession('hr', next.accountKey);
    for (const listener of listeners) listener(next);
    return next;
  }

  /** 无 commit 的通知（无凭证首启：保持 signed-out，不踩 ensureLoaded 的启动归一）。 */
  function notifyOnly(next: HrOaAuthState): HrOaAuthState {
    notifyAccountBoundary(next);
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
   *
   * FR-LOGOUT-03/05 清理清单：自愿登出（`logout`）与失效强退（`expired`）同样清
   * **个人信息缓存与头像缓存**——两者都落在 userData 根（不在 owner 分区内），不清
   * 会跨账号残留上一人的资料/头像。首启无凭证（reason 缺省）不属清理动作，不动。
   * 映射表不在这一步（clearOaLogin 的键不漂移承诺）；模型配置不在这条链上。
   */
  async function dropToSignedOut(
    reason: HrOaSignedOutReason | undefined,
    notify: boolean,
  ): Promise<HrOaAuthState> {
    await clearPortalCookies();
    if (reason === 'logout' || reason === 'expired') {
      // 非致命（同 clearPortalCookies）：收口失败不得拦住状态落定。
      await credentials.clearOaProfileCache();
      await credentials.clearOaAvatarCache();
    }
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
   * 契约用资料缓存认领账号键进 offline home。恢复触发（当前只有这两条，12h 凭证
   * 刷新调度器是 Task 8 的交付物、**此处尚不存在**，不得假定它兜底）：
   * `networkRecovered`（渲染层 `window 'online'`）与 `retryCredentialLoad`（main 侧
   * 窗口聚焦）——钥匙串恢复后静默重登转 `signed-in`。缓存缺失认领不了数据分区时才
   * 退回 signed-out（仍不清凭证、不弹失效）。
   */
  async function settleCredentialUnavailable(): Promise<HrOaAuthState> {
    credentialLoadPending = true;
    const cache = await credentials.loadOaProfileCache();
    if (!cache?.accountKey) {
      log.warn('[hr-oa] credential unreadable and no profile cache owner; staying signed-out');
      return notifyOnly({ status: 'signed-out' });
    }
    return settle({ status: 'offline', accountKey: cache.accountKey, profile: cache.profile });
  }

  /**
   * 分流版 load + 带退避的瞬时读抖动重试：`unavailable`（密文在盘、暂时读不出）不
   * 立即当终局——真机启动期 safeStorage 后端未就绪是**秒级**窗口，重试之间按
   * `LOAD_RETRY_DELAYS_MS` 等待（零间隔连读盖不住），仍读不出才按离线契约落定。
   */
  async function loadStoredLoginWithRetry(): Promise<
    Awaited<ReturnType<typeof credentials.loadOaLoginDetailed>>
  > {
    let loaded = await credentials.loadOaLoginDetailed(now());
    for (const delayMs of LOAD_RETRY_DELAYS_MS) {
      if (loaded.status !== 'unavailable') break;
      await wait(delayMs);
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
    // 显式登录成功 = 用户已手工解决登录态，startup 的读出楔子到此收口（生命周期
    // 合同）：stale pending 会让下一次聚焦 silentRelogin，把健康会话打回 offline。
    credentialLoadPending = false;
    return settle({ status: 'signed-in', accountKey, profile: effective });
  }

  async function logout(): Promise<void> {
    // 主动登出同时收口读出楔子（生命周期合同）：否则下一次聚焦会把 load 的 'none'
    // 落成 reason:'expired'，违背 FR-HOME-03「主动登出不得弹登录已过期」。
    credentialLoadPending = false;
    await credentials.clearOaLogin();
    // OA client 内存里记着口令做会话恢复——登出必须复位，防口令跨登出滞留。
    // （resetSession 清内存凭据；门户 cookie 由 dropToSignedOut 清，两件事都做。）
    client.resetSession();
    // reason:'logout' 随状态推送：兄弟窗口（无 voluntary 标记）据此抑制失效 toast。
    await dropToSignedOut('logout', false);
  }

  /** offline / 待恢复态的静默重登共用链（单飞：并发触发只跑一轮）。 */
  function runOfflineReconnect(): Promise<HrOaAuthState> {
    if (reconnectInFlight) return reconnectInFlight;
    reconnectInFlight = (async () => {
      try {
        const loaded = await loadStoredLoginWithRetry();
        if (loaded.status === 'unavailable') {
          // 密文在盘但暂时读不出：凭证还在，留在 offline 等下一次恢复信号（聚焦），
          // 不得按失效清人（误清 = 真机「清凭证」签名）。pending 保持，等下次触发。
          return state;
        }
        // 读得出正本（或确证无凭证 / 过期）：读不出的待恢复状态到此收口。
        credentialLoadPending = false;
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

  async function networkRecovered(): Promise<HrOaAuthState> {
    if (state.status !== 'offline') return state;
    return runOfflineReconnect();
  }

  async function retryCredentialLoad(): Promise<HrOaAuthState> {
    // 聚焦高频：只有 startup 落过「读不出」才动作，其余零成本返回（不打网络）。
    if (!credentialLoadPending) return state;
    return runOfflineReconnect();
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

  return { startup, login, logout, networkRecovered, retryCredentialLoad, getState, onDidChange };
}
