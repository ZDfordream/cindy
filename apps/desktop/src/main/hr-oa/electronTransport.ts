/**
 * electronTransport.ts — HR OA 门户的真实 `OaTransport`（main 进程）。
 *
 * 会话：`persist:hr-oa` 独立 Electron session 作 cookie jar（设计裁定「cookie jar
 * （Electron session 持久化即可）」）——与应用其它网络通道的 cookie 隔离，但跨启动
 * 持久，支撑「未过期凭证 → 静默重登 → 直接进首页」。`clearCookies()` 两个调用方
 * （P0 账号隔离）：oaClient.login() 提交凭证**前**清 jar（每次登录只按本次凭证判成败，
 * 真门户在 jar 有存活会话时把错口令也 302 到 `/`）；sessionManager 落 signed-out 前
 * 清 jar（登出/凭证失效收口，设计：退出登录清钥匙串凭证、cookie、内存会话）。
 *
 * 重定向：`redirect: 'follow'` + `session.webRequest.onBeforeRedirect` 重建跳转链。
 * 不能用 `redirect: 'manual'` 手动跟随：Electron 42 的 `ses.fetch` / `net.fetch` 遇
 * 3xx 在 manual（及 error）策略下**直接 throw**（实测「Redirect was cancelled」），
 * 而登录 POST 必 302——手动跟随实现因此每登录必炸、被 oaClient 归为 network_error
 * （真机验收 P0「网络异常」）。也不能拿 `Response.url` 当终点：官方文档明示该字段
 * 「不正确」（实测为空串）；`Response.redirected` 同样不可靠（真机 42.11.12 实测
 * 跟随后仍为 false），别拿它当「发生过跳转但没抓到 hop」的兜底判据。改为让 fetch
 * 自动跟随，用 webRequest 观察每一跳 3xx，
 * 重建 `finalUrl`（末跳落点）与 `headers.location`（末跳 3xx 的 Location 原值），
 * `status`/`body` 取最终响应——oaClient 的 OaResponse 合同（isLoginErrorBounce /
 * isAnonymBounce 对 location 与 finalUrl 的两套判据）原样成立。
 *
 * 跳转归属（webRequest 是 session 级**单监听** API，`ses.fetch` 又不暴露 request id）：
 *   - 本 transport 把请求 **FIFO 串行**（promise 队列），每条请求在自己的窗口里
 *     install / remove `onBeforeRedirect`，窗口绝不重叠、监听器用完即拆，不在共享
 *     session 上留全局监听；
 *   - 窗口内只收「从本请求 URL 链式串起来」的 hop（`details.url` 命中当前期望落点
 *     才收，URL 两侧都过 WHATWG 归一），同 session 其它流量的 3xx 串不进来。
 *   失效模式（不依赖调用方默默串行）：
 *     (1) 并发调用被 FIFO 排队而非并行——若并行捕获，同 URL 并发请求会把成功/失败
 *         弹回记反（把成功登录判成凭证错会误清钥匙串），比排队更糟；
 *     (2) 一条卡死的 fetch（黑洞路由）会占住队列直到 Chromium 判死连接，后续 OA 请求
 *         排队、在上层表现为 timeout——可接受：上层 10s 超时仍按时给用户回音，且
 *         跳串归属的代价更大；上层超时放弃的请求仍会跑完自身链路（结果被丢弃）；
 *     (3) 同窗口内若有其它代码经 persist:hr-oa 发**同 URL 链**的请求，其 hop 也可能
 *         被收进本请求的链（该 session 专用于本 transport，实际不存在这种流量）。
 *
 * 口令边界：transport 不解析、不记录任何请求体/响应体；表单只经 URLSearchParams
 * 进 body，错误文本由上层 oaClient scrub。
 */

import { session } from 'electron';

import type { OaResponse, OaTransport } from './oaClient.js';

/**
 * 构建期默认门户地址（owner 2026-11-01 裁定：取 HRMcp/.env 那套内网门户），
 * 支持 `HR_OA_BASE` 环境变量覆盖（部署目标见
 * docs/superpowers/specs/2026-11-01-login-onboarding-design.md §4.1）。
 */
export const DEFAULT_HR_OA_BASE = 'http://101.200.81.75';

export function resolveHrOaBaseUrl(): string {
  const override = process.env.HR_OA_BASE?.trim();
  return override ? override.replace(/\/+$/, '') : DEFAULT_HR_OA_BASE;
}

const PARTITION = 'persist:hr-oa';
const MAX_REDIRECT_HOPS = 10;

export interface HrOaSessionTransport extends OaTransport {
  /** 清门户 cookie（登出 / 凭证失效后的收口，设计 §4.2）。 */
  clearCookies(): Promise<void>;
}

/** 一跳 3xx：Location 原值（回填 headers.location）与解析后的落点（finalUrl / 链式关联）。 */
interface RedirectHop {
  location: string;
  target: string;
}

function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function absoluteUrl(location: string, base: string): string {
  try {
    return new URL(location, base).href;
  } catch {
    return location;
  }
}

/** 3xx 响应的 Location 原值（相对/绝对都照收），取不到时退回解析后的落点。 */
function hopLocation(details: Electron.OnBeforeRedirectListenerDetails): string {
  const headers = details.responseHeaders;
  if (headers) {
    for (const [key, values] of Object.entries(headers)) {
      if (key.toLowerCase() === 'location' && values.length > 0) return values[0];
    }
  }
  return details.redirectURL;
}

export function createHrOaSessionTransport(): HrOaSessionTransport {
  // 惰性取 session：模块可能在 app ready 前被 import，fromPartition 推迟到首发请求。
  function jar(): Electron.Session {
    return session.fromPartition(PARTITION);
  }

  /**
   * FIFO 串行闸：webRequest 单监听 + 按请求装拆监听器 ⇒ 监听窗口不得重叠。
   * 单条请求失败不毒化队列（后继请求照跑）。
   */
  let queue: Promise<void> = Promise.resolve();

  async function perform(input: {
    method: 'GET' | 'POST';
    path: string;
    params?: Record<string, string>;
    form?: Record<string, string>;
  }): Promise<OaResponse> {
    const target =
      input.path + (input.params ? `?${new URLSearchParams(input.params).toString()}` : '');
    const body = input.form ? new URLSearchParams(input.form).toString() : undefined;
    const ses = jar();
    const hops: RedirectHop[] = [];
    let expected = normalizeUrl(target);

    const onBeforeRedirect = (details: Electron.OnBeforeRedirectListenerDetails): void => {
      // 链式归属：首跳命中本请求 URL、后继命中上一跳落点才收；无关流量直接丢。
      if (normalizeUrl(details.url) !== expected) return;
      const hopTarget = absoluteUrl(details.redirectURL, details.url);
      hops.push({ location: hopLocation(details), target: hopTarget });
      expected = hopTarget;
    };
    ses.webRequest.onBeforeRedirect(onBeforeRedirect);
    let res: Response;
    try {
      res = await ses.fetch(target, {
        method: input.method,
        redirect: 'follow',
        headers:
          body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
        body,
      });
    } finally {
      // 用完即拆：webRequest 只有一个槽位，绝不在共享 session 上留全局监听器。
      ses.webRequest.onBeforeRedirect(null);
    }

    // 与旧手动循环同一条保护线：10 跳 3xx 就拒绝，不静默吞长链。
    if (hops.length >= MAX_REDIRECT_HOPS) {
      throw new Error(`OA request exceeded ${MAX_REDIRECT_HOPS} redirects`);
    }

    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    // 二进制安全（头像取图）：image/* 与 application/octet-stream 的响应体走 latin1
    // 往返（arrayBuffer → latin1 string），消费方 charCodeAt & 0xff 可无损还原字节。
    // 不能用 res.text()：UTF-8 解码会把 JPEG/PNG 字节糊成 U+FFFD，头像必然花屏。
    // 文本类（text/*、JSON、XML…）仍走 res.text()——HTML 资料解析（UTF-8 中文）不回归。
    const contentType = headers['content-type'] ?? '';
    const binaryBody = /^image\//i.test(contentType) || /^application\/octet-stream/i.test(contentType);
    // OaResponse 合同：headers.location 只来自**末跳** 3xx（isLoginErrorBounce /
    // isAnonymBounce 判据），无跳转时不带 location——与「不跟跳、暴露 3xx+location」
    // 的 transport 形态对齐（那时 3xx 之外的响应同样没有 location 可看）。
    const lastHop = hops.length > 0 ? hops[hops.length - 1] : undefined;
    if (lastHop) headers.location = lastHop.location;
    else delete headers.location;
    return {
      status: res.status,
      headers,
      body: binaryBody
        ? Buffer.from(await res.arrayBuffer()).toString('latin1')
        : await res.text(),
      finalUrl: lastHop ? lastHop.target : target,
    };
  }

  function request(input: {
    method: 'GET' | 'POST';
    path: string;
    params?: Record<string, string>;
    form?: Record<string, string>;
  }): Promise<OaResponse> {
    const run = queue.then(() => perform(input));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    request,
    async clearCookies(): Promise<void> {
      await jar().clearStorageData({ storages: ['cookies'] });
    },
  };
}
