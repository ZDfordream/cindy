/**
 * oaClient.ts — HR OA 蓝凌门户登录 / 会话 / 个人资料客户端（main 进程）。
 *
 * 登录序列（不走门户原生的「明文首发、被弹回再加密」双发）：
 *   1. GET /resource/js/session.jsp 抓 `getSM2PubKey()` 的公钥 hex（正则同 HRMcp/oa_client.py）；
 *   2. encryptPassword() → `SECURITY_MARKER + 密文 hex` 作为 j_password POST /j_acegi_security_check；
 *   3. 公钥取不到才降级为**恰好一次**明文提交，并留一条不含口令的 warn（不重试明文）。
 *
 * 判据（同 HRMcp/oa_client.py）：
 *   - 登录成功 = POST 没有落到 login_error（location 头或 finalUrl）；锁定信号
 *     （location/query 或 body 命中 /lock(ed)?/i）优先映射 locked；
 *   - 会话失效 = 3xx 且 location 含 anonym.jsp：自动重登并重试**一次**，再失效抛
 *     OaLoginError（复用 network_error，消息注明会话未恢复——不新增失败种类）。
 *
 * 安全红线：口令明文只进 transport 的 j_password（且仅 SM2 降级那一次是明文），
 * 任何异常/日志文本经 scrub 后绝不含明文。
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
   */
  request(input: {
    method: 'GET' | 'POST';
    path: string;
    params?: Record<string, string>;
    form?: Record<string, string>;
  }): Promise<OaResponse>;
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
// Ruling 1：锁定信号只认这一个判据（location/query 或 body），不发明其它信号。
const LOCK_RE = /lock(ed)?/i;
// window.getSM2PubKey = function(){ return "04...hex..."; }（同 oa_client.py::_SM2_PUBKEY_RE）
const SM2_PUBKEY_RE = /getSM2PubKey\s*=\s*function\s*\([^)]*\)\s*\{\s*return\s*"([0-9a-fA-F]+)"/;
const ANONYM_STATUSES = new Set([301, 302, 303, 307, 308]);
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
  return ANONYM_STATUSES.has(res.status) && headerValue(res, 'location').includes(ANONYM_MARKER);
}

function classifyLoginResponse(res: OaResponse): OaLoginOutcome {
  if (isLockSignal(res)) return { ok: false, kind: 'locked' };
  if (isLoginErrorBounce(res)) return { ok: false, kind: 'wrong_credentials' };
  return { ok: true };
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

  function request(
    method: 'GET' | 'POST',
    path: string,
    extra?: { params?: Record<string, string>; form?: Record<string, string> },
  ): Promise<OaResponse> {
    const call = transport.request({ method, path: absolute(path), ...extra });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RequestTimeout()), timeoutMs);
      // 两个分支都挂着 handler，超时后被放弃的 promise 不会成为 unhandled rejection。
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
      return { ok: false, kind: failureKindOf(e) };
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
        'failed to fetch person profile: ' + scrub(errorText(e), remembered?.password),
      );
    }
    return parsePersonProfile(res.body);
  }

  function resetSession(): void {
    remembered = null;
  }

  return { login, getPersonProfile, resetSession };
}
