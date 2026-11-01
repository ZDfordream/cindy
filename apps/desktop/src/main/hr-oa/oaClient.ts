/**
 * oaClient.ts — HR OA 蓝凌门户登录 / 会话 / 个人资料客户端（main 进程）。
 *
 * 登录序列（不走门户原生的「明文首发、被弹回再加密」双发）：
 *   0. 清 transport 的 cookie jar（P0 账号隔离，设计 §4.2）——真门户在 jar 有存活
 *      会话时把错口令的登录 POST 也 302 到 `/`（与成功不可区分），旧会话绝不参与
 *      本次判定；清不掉就不提交（fail-closed）。
 *   1. GET /resource/js/session.jsp 抓 `getSM2PubKey()` 的公钥 hex（正则同 HRMcp/oa_client.py）；
 *   2. encryptPassword() → `SECURITY_MARKER + 密文 hex` 作为 j_password POST /j_acegi_security_check；
 *   3. 公钥取不到才降级为**恰好一次**明文提交，并留一条不含口令的 warn（不重试明文）。
 *
 * 判据（同 HRMcp/oa_client.py）：
 *   - 登录成功 = POST 没有落到 login_error（location 头或 finalUrl），没落就是成功、到此为止；
 *     锁定映射**只在 login_error 弹回内**判（Ruling 6）：location/query 或 body 命中
 *     /\block(ed)?\b/i 才是 locked，否则 wrong_credentials；
 *   - 会话失效 = location 或 finalUrl 含 anonym.jsp（3xx 弹回与跟随重定向后的 200 两种形态
 *     都认）：自动重登并重试**一次**，再失效抛 OaLoginError（复用 network_error，消息注明
 *     会话未恢复——不新增失败种类）。
 *
 * 安全红线：口令明文只进 transport 的 j_password（且仅 SM2 降级那一次是明文），
 * 任何异常/日志文本经 scrub（日志行走 scrubForLog：口令 / 明文账号 / 带 query 的
 * 完整接口地址 / 表单体一并抹掉）后绝不含明文；login() 把 transport 抛错归入
 * outcome 时必须留下恰好一条脱敏 warn，失败不可再被静默吞掉。
 */

import { createLogger } from '../logger.js';

import { OaLoginError, type OaLoginFailure, type OaLoginOutcome } from './errors.js';
import { parsePersonProfile, type PersonProfile } from './profile.js';
import { encryptPassword } from './sm2Password.js';

export interface OaResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
}

export interface OaTransport {
  /**
   * 发一个请求。`path` 是已拼好 baseUrl 的绝对 URL；transport 自持 cookie jar
   * （Electron session），`params` 追加为查询串。
   *
   * 重定向语义（合同）：**跟随重定向**——返回链条终点的最终响应，`finalUrl` 是最终
   * URL，`status`/`headers`/`body` 是该最终响应的（Electron session fetch 同款语义）。
   * 会话过期因此常见形态是 `200` + `finalUrl` 含 anonym.jsp（无 location 头）。选择不跟
   * 重定向、直接暴露 3xx + location 的 transport 同样被接受：客户端的弹回判据对两种
   * 形态都认（与 isLoginErrorBounce 对称）。
   */
  request(input: {
    method: 'GET' | 'POST';
    path: string;
    params?: Record<string, string>;
    form?: Record<string, string>;
  }): Promise<OaResponse>;

  /**
   * 清空 transport 的 cookie jar（账号隔离，设计 §4.2）。可选：省略视为 no-op
   * （fake transport 可不实现）。
   *
   * login() 在提交凭证**前**会先清 jar：每次登录只按本次凭证判成败。jar 里的旧会话
   * 会让蓝凌把错口令的登录 POST 也 302 到 `/`（与成功不可区分）——不清 jar 就提交 =
   * 上一个账号的会话能「判成功」下一个账号的错口令（P0 账号隔离破口，真机 2026-11-01
   * 实证）。清不掉则**不提交**（fail-closed）。
   */
  clearCookies?(): Promise<void> | void;
}

export interface OaClient {
  login(username: string, password: string): Promise<OaLoginOutcome>;
  getPersonProfile(): Promise<PersonProfile>;
  /** 清掉为会话恢复记住的登录凭据（cookie 归 transport 管）。 */
  resetSession(): void;
}

const log = createLogger('hr-oa');

const LOGIN_PATH = '/j_acegi_security_check';
const SESSION_JS_PATH = '/resource/js/session.jsp';
const PROFILE_PATH = '/sys/person/setting.do';
const PROFILE_SETTING = 'sys_zone_person_info';
const ANONYM_MARKER = 'anonym.jsp';
const LOGIN_ERROR_MARKER = 'login_error';
// Ruling 6：锁定信号只认这一个判据（location/query 或 body），不发明其它信号。
// \b 前后缀把 "block"/"clock"/"unlock"/"display:block" 排除在外，保留 "?lock=1" 与
// "account locked"。且只在 login_error 弹回内才判（见 classifyLoginResponse）。
const LOCK_RE = /\block(ed)?\b/i;
// window.getSM2PubKey = function(){ return "04...hex..."; }（同 oa_client.py::_SM2_PUBKEY_RE）
const SM2_PUBKEY_RE = /getSM2PubKey\s*=\s*function\s*\([^)]*\)\s*\{\s*return\s*"([0-9a-fA-F]+)"/;
const DEFAULT_TIMEOUT_MS = 10_000;
const SESSION_RECOVERY_FAIL_MSG = 'session could not be restored after re-login';

/** 本端超时哨兵：transport 拒绝一律算网络错误，只有超时竞速赢了才算 timeout。 */
class RequestTimeout extends Error {
  constructor() {
    super('OA request timed out');
    this.name = 'RequestTimeout';
  }
}

function scrub(text: string, secret: string | undefined): string {
  return secret ? String(text).split(secret).join('***') : String(text);
}

/**
 * 日志/异常文本脱敏（凭证红线）：口令明文 → `***`、完整接口地址剥掉 query、登录表单
 * 字段残值（j_username= / j_password= 连着的字段串）整段 → `***`。口令、明文账号、带
 * query 的完整接口地址、表单体绝不进日志/埋点/崩溃上报；正文也从不整体落日志，本函数
 * 只处理错误文本里可能粘上的零散残渣。
 */
function scrubForLog(text: string, secret: string | undefined): string {
  const withoutSecret = scrub(text, secret);
  // 完整接口地址（带 query）→ 只留 scheme://host/path。
  const withoutQuery = withoutSecret.replace(
    /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s?#]*)\?[^#\s]*/g,
    '$1',
  );
  // 登录表单字段串（含 j_username= / j_password= 的连续字段）整段抹掉，不留字段名。
  return withoutQuery.replace(/(?:\b(?:j_username|j_password)=[^&\s]*&?)+/gi, '***');
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function headerValue(res: OaResponse, name: string): string {
  for (const [key, value] of Object.entries(res.headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return '';
}

function isLoginErrorBounce(res: OaResponse): boolean {
  return headerValue(res, 'location').includes(LOGIN_ERROR_MARKER) || res.finalUrl.includes(LOGIN_ERROR_MARKER);
}

function isLockSignal(res: OaResponse): boolean {
  return LOCK_RE.test(headerValue(res, 'location')) || LOCK_RE.test(res.body);
}

function isAnonymBounce(res: OaResponse): boolean {
  // 与 isLoginErrorBounce 对称：3xx + location（不跟重定向的 transport）与
  // 跟随后的 200 + finalUrl（Electron session fetch）两种形态都认。
  return headerValue(res, 'location').includes(ANONYM_MARKER) || res.finalUrl.includes(ANONYM_MARKER);
}

function classifyLoginResponse(res: OaResponse): OaLoginOutcome {
  // 成功判据优先（Ruling 6）：没落到 login_error 就是成功，到此为止——锁定映射只在
  // login_error 弹回内判，防 body/URL 里的 "lock" 子串把成功翻成 locked（会误清凭证）。
  if (!isLoginErrorBounce(res)) return { ok: true };
  if (isLockSignal(res)) return { ok: false, kind: 'locked' };
  return { ok: false, kind: 'wrong_credentials' };
}

function failureKindOf(e: unknown): OaLoginFailure {
  return e instanceof RequestTimeout ? 'timeout' : 'network_error';
}

export function createOaClient(opts: {
  baseUrl: string;
  transport: OaTransport;
  fetchPubkey?: () => Promise<string | null>;
  encrypt?: typeof encryptPassword;
  timeoutMs?: number;
}): OaClient {
  const { baseUrl, transport } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const encrypt = opts.encrypt ?? encryptPassword;
  let remembered: { username: string; password: string } | null = null;

  function absolute(path: string): string {
    return baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
  }

  /** 本端超时哨兵：两个分支都挂着 handler，超时后被放弃的 promise 不会成为 unhandled rejection。 */
  function guard<T>(call: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RequestTimeout()), timeoutMs);
      call.then(
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  function request(
    method: 'GET' | 'POST',
    path: string,
    extra?: { params?: Record<string, string>; form?: Record<string, string> },
  ): Promise<OaResponse> {
    return guard(transport.request({ method, path: absolute(path), ...extra }));
  }

  async function fetchPubkeyDefault(): Promise<string | null> {
    try {
      const res = await request('GET', SESSION_JS_PATH, { params: { _: String(Date.now()) } });
      const m = SM2_PUBKEY_RE.exec(res.body);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  async function postCredentials(username: string, jPassword: string): Promise<OaResponse> {
    return request('POST', LOGIN_PATH, {
      form: { j_username: username, j_password: jPassword, j_redirectto: '' },
    });
  }

  async function login(username: string, password: string): Promise<OaLoginOutcome> {
    remembered = { username, password };
    try {
      // P0 账号隔离（设计 §4.2）：提交凭证前清空 cookie jar——每次登录只按本次凭证
      // 判成败。真门户在 jar 有存活会话时把错口令的登录 POST 也 302 到 `/`（与成功
      // 不可区分），旧会话绝不能参与本次判定。清不掉就不提交（fail-closed → 由下方
      // catch 归 network_error / timeout）：拿脏 jar 判凭证等于口令校验形同虚设。
      await guard(Promise.resolve(transport.clearCookies?.()));
      const pubkey = await (opts.fetchPubkey ?? fetchPubkeyDefault)();
      let jPassword = password;
      if (pubkey) {
        jPassword = encrypt(password, pubkey);
      } else {
        // Ruling 2：公钥取不到只降级一次明文，不重试；warn 固定文案，不含口令。
        log.warn('[hr-oa] SM2 pubkey unavailable; falling back to one plaintext submit');
      }
      return classifyLoginResponse(await postCredentials(username, jPassword));
    } catch (e) {
      // 公开入口不抛：失败一律归入 outcome（含加密失败这类意外 → network_error，保住凭证）。
      // 但原因必须留下**恰好一条**脱敏 warn：此前把 transport 抛错静默映射 network_error
      // 零日志（真机 P0「Redirect was cancelled」因此无从排查）。文本经 scrubForLog——
      // 口令、明文账号、带 query 的完整接口地址、表单体都不进日志。
      const kind = failureKindOf(e);
      log.warn(
        `[hr-oa] login request failed (${kind}): ${scrubForLog(errorText(e), remembered?.password)}`,
      );
      return { ok: false, kind };
    }
  }

  async function fetchProfilePage(): Promise<OaResponse> {
    return request('GET', PROFILE_PATH, { params: { setting: PROFILE_SETTING } });
  }

  async function recoverSessionAndRetry(): Promise<OaResponse> {
    if (remembered) {
      const outcome = await login(remembered.username, remembered.password);
      if (outcome.ok) {
        const retry = await fetchProfilePage();
        if (!isAnonymBounce(retry)) return retry;
      }
    }
    // 会话恢复失败（重登失败或再次弹 anonym.jsp）复用 network_error（Ruling 3/4，不新增种类）。
    throw new OaLoginError('network_error', SESSION_RECOVERY_FAIL_MSG);
  }

  async function getPersonProfile(): Promise<PersonProfile> {
    let res: OaResponse;
    try {
      res = await fetchProfilePage();
      if (isAnonymBounce(res)) res = await recoverSessionAndRetry();
    } catch (e) {
      if (e instanceof OaLoginError) throw e;
      throw new OaLoginError(
        failureKindOf(e),
        'failed to fetch person profile: ' + scrubForLog(errorText(e), remembered?.password),
      );
    }
    return parsePersonProfile(res.body);
  }

  function resetSession(): void {
    remembered = null;
  }

  return { login, getPersonProfile, resetSession };
}
