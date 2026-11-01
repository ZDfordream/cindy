/**
 * 测试价值
 * - 生产入口与可观察结果：createHrOaSessionTransport().request() 对登录 POST 的 302
 *   必须 resolve（不得 throw），并按 OaResponse 合同重建响应——finalUrl = 末跳落点、
 *   headers.location = 末跳 3xx 的 Location 原值、status/body = 最终响应；经
 *   createOaClient 组合后 login_error 弹回分类 wrong_credentials、落 `/` 分类 success。
 *   另钉四条护栏：MAX_REDIRECT_HOPS 保护、跳转归属（无关 hop 不串台）、webRequest
 *   监听器用完即拆（不在共享 session 留全局监听）、并发请求 FIFO 串行（监听窗口不重叠）。
 * - Bug／规则依据：真机验收 P0「登录永远失败：网络异常，请检查网络后重试」——Electron
 *   42 的 `ses.fetch` / `net.fetch` 在 redirect:'manual'（及 'error'）遇 3xx 直接 throw
 *   （实测「Redirect was cancelled」），而登录 POST 必 302，transport 炸掉后被 oaClient
 *   归为 network_error 且无任何日志。修复合同：redirect:'follow' + session.webRequest
 *   .onBeforeRedirect 重建跳转链（`Response.url` 文档明示不正确，不可用作 finalUrl）。
 *   fake session.fetch 按 2026-11-01 对本仓 Electron 42.11.12 真机录制的语义模拟
 *   （manual/error 遇 3xx throw；follow 自动跟随并逐跳触发 onBeforeRedirect）。
 * - 现有覆盖缺口：oaClient.test.ts 全部走 fake transport 只钉分类判据，从不经过
 *   electronTransport；「transport 对 3xx throw」因此在任何单测里都不可见（P0 漏检原因）。
 * - 最小失败输入：POST /j_acegi_security_check → 302 Location:/login.jsp?login_error=1
 *   → GET 落点 200。旧 transport 请求带 redirect:'manual'，fake 按录制语义 throw，
 *   request() 不可能 resolve，分类组合只能得到 network_error。
 * - tier：unit（fake electron session，无真实网络；真实门户验证走 PR 里的 /tmp
 *   throwaway Electron 探针，不进单测——默认单测不得访问业务外网）。
 * - 实测耗时：单文件 ~1.1s（pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/electronTransport.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Route = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** 最终响应前塞一个无关 3xx hop（模拟共享 session 上的串台流量）。 */
  unrelatedHop?: { url: string; location: string };
  /** 挂起最终响应，由测试手动放行（并发串行用例用，纯微任务、无真实等待）。 */
  hold?: Promise<void>;
};

type HopDetails = {
  id: number;
  url: string;
  method: string;
  resourceType: string;
  timestamp: number;
  redirectURL: string;
  statusCode: number;
  statusLine: string;
  fromCache: boolean;
  responseHeaders: Record<string, string[]>;
};

const harness = vi.hoisted(() => {
  const routes = new Map<string, Route>();
  const fetchLog: string[] = [];
  let listener: ((details: HopDetails) => void) | null = null;

  function abs(location: string, base: string): string {
    return new URL(location, base).href;
  }

  function makeResponse(spec: Route): Response {
    const entries = Object.entries(spec.headers ?? {});
    return {
      status: spec.status,
      // Electron fetch 的 Response.url 文档明示「不正确」（实测为空串）——钉死为空串，
      // 逼 transport 不得依赖它拿 finalUrl。
      url: '',
      headers: {
        forEach(cb: (value: string, key: string) => void): void {
          for (const [key, value] of entries) cb(value, key.toLowerCase());
        },
      } as unknown as Headers,
      text: async () => spec.body ?? '',
    } as unknown as Response;
  }

  function fireHop(partial: Omit<HopDetails, 'id' | 'method' | 'resourceType' | 'timestamp' | 'statusLine' | 'fromCache'>): void {
    listener?.({
      id: 1,
      method: 'GET',
      resourceType: 'other',
      timestamp: Date.now() / 1000,
      statusLine: `HTTP/1.1 ${partial.statusCode} Found`,
      fromCache: false,
      ...partial,
    });
  }

  return {
    routes,
    fetchLog,
    reset(): void {
      routes.clear();
      fetchLog.length = 0;
      listener = null;
    },
    activeListener(): ((details: HopDetails) => void) | null {
      return listener;
    },
    session: {
      // Electron webRequest 是 session 级单监听 API：后装的顶掉先装的，传 null 即卸。
      webRequest: {
        onBeforeRedirect(next: ((details: HopDetails) => void) | null): void {
          listener = next;
        },
      },
      async clearStorageData(): Promise<void> {},
      async fetch(url: string, init?: RequestInit): Promise<Response> {
        fetchLog.push(url);
        const redirectMode = init?.redirect ?? 'follow';
        let current = url;
        for (let hop = 0; hop < 25; hop += 1) {
          const spec = routes.get(current);
          if (!spec) throw new TypeError(`fake net: no route for ${current}`);
          const location = spec.headers?.location;
          if (spec.status >= 300 && spec.status < 400 && location) {
            if (redirectMode === 'manual') {
              // 真机录制（Electron 42.11.12 ses.fetch + redirect:'manual'）：3xx 直接 throw。
              throw new Error('Redirect was cancelled');
            }
            if (redirectMode === 'error') {
              throw new Error("Attempted to redirect, but redirect policy was 'error'");
            }
            const target = abs(location, current);
            fireHop({
              url: current,
              redirectURL: target,
              statusCode: spec.status,
              responseHeaders: { location: [location] },
            });
            current = target;
            continue;
          }
          if (spec.unrelatedHop) {
            // 同 session 无关流量的 3xx：不得被本请求的链式归属收走。
            fireHop({
              url: spec.unrelatedHop.url,
              redirectURL: abs(spec.unrelatedHop.location, spec.unrelatedHop.url),
              statusCode: 302,
              responseHeaders: { location: [spec.unrelatedHop.location] },
            });
          }
          if (spec.hold) await spec.hold;
          return makeResponse(spec);
        }
        throw new Error('fake net: too many redirects');
      },
    },
  };
});

vi.mock('electron', () => ({
  session: {
    fromPartition: () => harness.session,
  },
}));

import { createHrOaSessionTransport } from '../electronTransport.js';
import { createOaClient } from '../oaClient.js';

const BASE = 'http://oa.test';
const USER = 'alice';
const PASSWORD = 'pw-secret';
// SM2 曲线生成元 G（合法曲线点，组合用例注入 encrypt 后不走真实加密，点值仅占位）。
const PUBKEY =
  '04' +
  '32c4ae2c1f1981195f9904466a39c9948fe30bbff2660be1715a4589334c74c7' +
  'bc3736a2f4f6779c59bdcee36b692153d0a9877cc62a474002df32e52139f0a0';

function loginPost(): { method: 'POST'; path: string; form: Record<string, string> } {
  return {
    method: 'POST',
    path: `${BASE}/j_acegi_security_check`,
    form: { j_username: USER, j_password: PASSWORD, j_redirectto: '' },
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function drainMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

beforeEach(() => {
  harness.reset();
});

describe('electronTransport redirect reconstruction', () => {
  it('302 → /login.jsp?login_error=1 不抛错，重建末跳 location/finalUrl 与最终响应', async () => {
    harness.routes.set(`${BASE}/j_acegi_security_check`, {
      status: 302,
      headers: { location: '/login.jsp?login_error=1' },
    });
    harness.routes.set(`${BASE}/login.jsp?login_error=1`, { status: 200, body: 'login page' });

    const transport = createHrOaSessionTransport();
    const res = await transport.request(loginPost());

    expect(res.status).toBe(200);
    expect(res.body).toBe('login page');
    expect(res.finalUrl).toBe(`${BASE}/login.jsp?login_error=1`);
    expect(res.headers.location).toBe('/login.jsp?login_error=1');
  });

  it('302 → / 不抛错，重建成功形态（location 原值 + 末跳落点）', async () => {
    harness.routes.set(`${BASE}/j_acegi_security_check`, {
      status: 302,
      headers: { location: '/' },
    });
    harness.routes.set(`${BASE}/`, { status: 200, body: 'home' });

    const transport = createHrOaSessionTransport();
    const res = await transport.request(loginPost());

    expect(res.status).toBe(200);
    expect(res.body).toBe('home');
    expect(res.finalUrl).toBe(`${BASE}/`);
    expect(res.headers.location).toBe('/');
  });

  it('多跳链：finalUrl/location 取**末跳** 3xx，status/body 取最终响应', async () => {
    harness.routes.set(`${BASE}/j_acegi_security_check`, {
      status: 302,
      headers: { location: '/hop-a' },
    });
    harness.routes.set(`${BASE}/hop-a`, { status: 302, headers: { location: '/hop-b?x=1' } });
    harness.routes.set(`${BASE}/hop-b?x=1`, { status: 200, body: 'done' });

    const transport = createHrOaSessionTransport();
    const res = await transport.request(loginPost());

    expect(res.status).toBe(200);
    expect(res.body).toBe('done');
    expect(res.finalUrl).toBe(`${BASE}/hop-b?x=1`);
    expect(res.headers.location).toBe('/hop-b?x=1');
  });

  it('跳数达到 MAX_REDIRECT_HOPS 仍拒绝（不静默吞掉长跳转链）', async () => {
    for (let i = 0; i < 10; i += 1) {
      harness.routes.set(`${BASE}/r${i}`, { status: 302, headers: { location: `/r${i + 1}` } });
    }
    harness.routes.set(`${BASE}/r10`, { status: 200, body: 'end' });

    const transport = createHrOaSessionTransport();
    await expect(transport.request({ method: 'GET', path: `${BASE}/r0` })).rejects.toThrow(
      /exceeded 10 redirects/,
    );
  });

  it('共享 session 上的无关 3xx hop 不串进本请求的链', async () => {
    harness.routes.set(`${BASE}/j_acegi_security_check`, {
      status: 302,
      headers: { location: '/login.jsp?login_error=1' },
    });
    harness.routes.set(`${BASE}/login.jsp?login_error=1`, {
      status: 200,
      body: 'login page',
      unrelatedHop: { url: `${BASE}/unrelated`, location: '/elsewhere' },
    });

    const transport = createHrOaSessionTransport();
    const res = await transport.request(loginPost());

    expect(res.finalUrl).toBe(`${BASE}/login.jsp?login_error=1`);
    expect(res.headers.location).toBe('/login.jsp?login_error=1');
  });
});

describe('electronTransport concurrency guard', () => {
  it('并发请求 FIFO 串行、监听窗口不重叠、webRequest 监听器用完即拆', async () => {
    const hold = createDeferred();
    harness.routes.set(`${BASE}/slow`, { status: 200, body: 'slow', hold: hold.promise });
    harness.routes.set(`${BASE}/fast`, { status: 200, body: 'fast' });

    const transport = createHrOaSessionTransport();
    const slow = transport.request({ method: 'GET', path: `${BASE}/slow` });
    const fast = transport.request({ method: 'GET', path: `${BASE}/fast` });

    // 串行闸：slow 未落定前 fast 不得发网——否则两条请求的 webRequest 监听窗口互相顶掉。
    await drainMicrotasks();
    expect(harness.fetchLog).toEqual([`${BASE}/slow`]);
    expect(harness.activeListener()).not.toBeNull();

    hold.resolve();
    const [slowRes, fastRes] = await Promise.all([slow, fast]);
    expect(slowRes.body).toBe('slow');
    expect(fastRes.body).toBe('fast');
    expect(harness.fetchLog).toEqual([`${BASE}/slow`, `${BASE}/fast`]);
    // 用完即拆：不在共享 session 上留全局监听器（webRequest 单槽位）。
    expect(harness.activeListener()).toBeNull();
  });
});

describe('electronTransport × oaClient classification', () => {
  function clientWithRealTransport(): ReturnType<typeof createOaClient> {
    return createOaClient({
      baseUrl: BASE,
      transport: createHrOaSessionTransport(),
      // 公钥/加密另有 sm2Password.test.ts 与 oaClient.test.ts 覆盖；此处注入以聚焦
      // 「transport 重建出的响应 → 分类」这条 P0 断链。
      fetchPubkey: async () => PUBKEY,
      encrypt: (plain: string) => `enc:${plain}`,
    });
  }

  it('302 → /login.jsp?login_error=1 分类 wrong_credentials（而不是 network_error）', async () => {
    harness.routes.set(`${BASE}/j_acegi_security_check`, {
      status: 302,
      headers: { location: '/login.jsp?login_error=1' },
    });
    harness.routes.set(`${BASE}/login.jsp?login_error=1`, { status: 200, body: 'login page' });

    await expect(clientWithRealTransport().login(USER, PASSWORD)).resolves.toEqual({
      ok: false,
      kind: 'wrong_credentials',
    });
  });

  it('302 → / 分类 success', async () => {
    harness.routes.set(`${BASE}/j_acegi_security_check`, {
      status: 302,
      headers: { location: '/' },
    });
    harness.routes.set(`${BASE}/`, { status: 200, body: 'home' });

    await expect(clientWithRealTransport().login(USER, PASSWORD)).resolves.toEqual({ ok: true });
  });
});
