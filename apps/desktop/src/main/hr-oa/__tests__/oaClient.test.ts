/**
 * 测试价值
 * - 生产入口与可观察结果：createOaClient() 的 login() 失败分流（ok / wrong_credentials / locked /
 *   network_error / timeout）、SM2 成功路径 j_password 只带标记密文（从不发明文）、公钥取不到时
 *   恰好一次明文降级 + 一条不含口令的 warn；getPersonProfile() 的资料拉取与 anonym.jsp 会话失效
 *   恢复（自动重登重试一次，再失效抛会话语义错误）；所有抛错与日志文本不含口令明文。
 * - Bug／规则依据：计划 Task 1 Step 5 场景矩阵；Ruling 1 锁定判据 = location/query 或 body 命中
 *   /lock(ed)?/i（不发明其它锁定信号，login_error 弹回无锁信号即 wrong_credentials）；Ruling 2
 *   公钥取不到只降级一次明文、不重试；Ruling 3/4 会话恢复失败复用 network_error（不新增失败种类）
 *   并在消息里注明会话未恢复；Review Focus #4 口令不进日志/异常。
 * - 现有覆盖缺口：新模块，此前没有门户登录序列、失败分流与会话恢复覆盖。
 * - 最小失败输入：见表驱动场景（SM2 成功 / 凭证错 / 锁定×2 信号 / 网络错 / 超时 / 公钥取不到 /
 *   会话失效×2 / 资料拉取网络错）。
 * - tier：unit（transport 全注入 fake，无真实网络；超时用 5ms 短定时器，不做真实长等待）。
 * - 实测耗时：单文件 ~0.7s（pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/oaClient.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OaLoginError } from '../errors.js';
import { createOaClient, type OaResponse, type OaTransport } from '../oaClient.js';
import { SECURITY_MARKER } from '../sm2Password.js';

const logWarn = vi.hoisted(() => vi.fn());
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn() }),
}));

const BASE = 'http://oa.test';
const USER = 'alice';
const PASSWORD = 'pw-secret';
// SM2 曲线生成元 G（合法曲线点，vendor 加密确定可用）。
const PUBKEY =
  '04' +
  '32c4ae2c1f1981195f9904466a39c9948fe30bbff2660be1715a4589334c74c7' +
  'bc3736a2f4f6779c59bdcee36b692153d0a9877cc62a474002df32e52139f0a0';

type RequestInput = {
  method: 'GET' | 'POST';
  path: string;
  params?: Record<string, string>;
  form?: Record<string, string>;
};
type Responder = (input: RequestInput, index: number) => OaResponse | Promise<OaResponse>;

function makeTransport(respond: Responder): { transport: OaTransport; calls: RequestInput[] } {
  const calls: RequestInput[] = [];
  return {
    calls,
    transport: {
      request(input) {
        calls.push(input);
        return Promise.resolve(respond(input, calls.length - 1));
      },
    },
  };
}

function sessionJs(body = `window.getSM2PubKey = function(){ return "${PUBKEY}"; }`): OaResponse {
  return { status: 200, headers: {}, body, finalUrl: `${BASE}/resource/js/session.jsp` };
}

function redirect(location: string, body = ''): OaResponse {
  return { status: 302, headers: { location }, body, finalUrl: `${BASE}/j_acegi_security_check` };
}

function isSessionJs(input: RequestInput): boolean {
  return input.method === 'GET' && input.path.includes('session.jsp');
}
function isLoginPost(input: RequestInput): boolean {
  return input.method === 'POST' && input.path.includes('j_acegi_security_check');
}
function isProfileGet(input: RequestInput): boolean {
  return input.method === 'GET' && input.path.includes('setting.do');
}

const PROFILE_HTML = [
  '<script>',
  "var userName = '张三';",
  "var loginName = 'u1';",
  '</script>',
  '<input type="hidden" name="fdPersonId" value="p42">',
].join('\n');

function profileResponse(): OaResponse {
  return { status: 200, headers: {}, body: PROFILE_HTML, finalUrl: `${BASE}/sys/person/setting.do` };
}

beforeEach(() => {
  logWarn.mockClear();
});

describe('createOaClient().login', () => {
  it('SM2 success: submits marker+ciphertext, never the plaintext', async () => {
    const { transport, calls } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      if (isLoginPost(input)) return redirect('/portal');
      throw new Error(`unexpected ${input.method} ${input.path}`);
    });
    const client = createOaClient({ baseUrl: BASE, transport });

    await expect(client.login(USER, PASSWORD)).resolves.toEqual({ ok: true });

    const post = calls.find(isLoginPost);
    expect(post?.form?.j_username).toBe(USER);
    expect(post?.form?.j_redirectto).toBe('');
    const jPassword = post?.form?.j_password ?? '';
    expect(jPassword.startsWith(SECURITY_MARKER)).toBe(true);
    expect(jPassword).not.toBe(PASSWORD);
    expect(jPassword.includes(PASSWORD)).toBe(false);
  });

  it('login_error bounce maps to wrong_credentials', async () => {
    const { transport } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      return redirect('http://oa.test/login_error');
    });
    const client = createOaClient({ baseUrl: BASE, transport });

    await expect(client.login(USER, PASSWORD)).resolves.toEqual({ ok: false, kind: 'wrong_credentials' });
  });

  it('lock signal in location query maps to locked', async () => {
    const { transport } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      return redirect('http://oa.test/login_error?lock=1');
    });
    const client = createOaClient({ baseUrl: BASE, transport });

    await expect(client.login(USER, PASSWORD)).resolves.toEqual({ ok: false, kind: 'locked' });
  });

  it('lock signal in body maps to locked', async () => {
    const { transport } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      return redirect('/portal', 'account locked');
    });
    const client = createOaClient({ baseUrl: BASE, transport });

    await expect(client.login(USER, PASSWORD)).resolves.toEqual({ ok: false, kind: 'locked' });
  });

  it('transport rejection maps to network_error', async () => {
    const { transport } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      throw new TypeError('fetch failed');
    });
    const client = createOaClient({ baseUrl: BASE, transport });

    await expect(client.login(USER, PASSWORD)).resolves.toEqual({ ok: false, kind: 'network_error' });
  });

  it('hung transport maps to timeout', async () => {
    const { transport } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      return new Promise<never>(() => {});
    });
    const client = createOaClient({ baseUrl: BASE, transport, timeoutMs: 5 });

    await expect(client.login(USER, PASSWORD)).resolves.toEqual({ ok: false, kind: 'timeout' });
  });

  it('missing pubkey degrades to exactly one plaintext submit plus a password-free warn', async () => {
    const { transport, calls } = makeTransport((input) => {
      if (isSessionJs(input)) {
        return { status: 404, headers: {}, body: 'not found', finalUrl: input.path };
      }
      return redirect('http://oa.test/login_error');
    });
    const client = createOaClient({ baseUrl: BASE, transport });

    // Ruling 2：降级仅一次明文，不重试；结果仍按 POST 判据归类。
    await expect(client.login(USER, PASSWORD)).resolves.toEqual({ ok: false, kind: 'wrong_credentials' });

    const posts = calls.filter(isLoginPost);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.form?.j_password).toBe(PASSWORD);
    expect(logWarn).toHaveBeenCalledTimes(1);
    for (const arg of logWarn.mock.calls.flat()) {
      expect(String(arg).includes(PASSWORD)).toBe(false);
    }
  });
});

describe('createOaClient().getPersonProfile', () => {
  it('parses the profile page after login', async () => {
    const { transport } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      if (isLoginPost(input)) return redirect('/portal');
      return profileResponse();
    });
    const client = createOaClient({ baseUrl: BASE, transport });
    await client.login(USER, PASSWORD);

    await expect(client.getPersonProfile()).resolves.toMatchObject({
      name: '张三',
      loginName: 'u1',
      personId: 'p42',
    });
  });

  it('recovers an expired session by re-logging in and retrying once', async () => {
    let profileGets = 0;
    const { transport, calls } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      if (isLoginPost(input)) return redirect('/portal');
      if (isProfileGet(input)) {
        profileGets += 1;
        return profileGets === 1
          ? redirect('http://oa.test/resource/jsp/anonym.jsp')
          : profileResponse();
      }
      throw new Error(`unexpected ${input.method} ${input.path}`);
    });
    const client = createOaClient({ baseUrl: BASE, transport });
    await client.login(USER, PASSWORD);

    await expect(client.getPersonProfile()).resolves.toMatchObject({ loginName: 'u1' });
    expect(calls.filter(isLoginPost)).toHaveLength(2);
  });

  it('maps unrecoverable session loss to network_error without leaking the password', async () => {
    const { transport, calls } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      if (isLoginPost(input)) return redirect('/portal');
      return redirect('http://oa.test/resource/jsp/anonym.jsp');
    });
    const client = createOaClient({ baseUrl: BASE, transport });
    await client.login(USER, PASSWORD);

    // 会话恢复失败（重登后再次弹 anonym.jsp）复用 network_error，不新增失败种类（Ruling 3/4）。
    const err = await client.getPersonProfile().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OaLoginError);
    expect((err as OaLoginError).kind).toBe('network_error');
    expect((err as OaLoginError).message).not.toBe('');
    expect((err as OaLoginError).message.includes(PASSWORD)).toBe(false);
    expect(calls.filter(isLoginPost)).toHaveLength(2);
  });

  it('scrubs the password out of transport error text on fetch failure', async () => {
    const { transport } = makeTransport((input) => {
      if (isSessionJs(input)) return sessionJs();
      if (isLoginPost(input)) return redirect('/portal');
      // 模拟把请求内容带进错误消息的传输层，钉死 scrub（明文不得进异常文本）。
      throw new Error(`fetch blew up on password=${PASSWORD}`);
    });
    const client = createOaClient({ baseUrl: BASE, transport });
    await client.login(USER, PASSWORD);

    const err = await client.getPersonProfile().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OaLoginError);
    expect((err as OaLoginError).kind).toBe('network_error');
    expect((err as OaLoginError).message.includes(PASSWORD)).toBe(false);
  });
});
