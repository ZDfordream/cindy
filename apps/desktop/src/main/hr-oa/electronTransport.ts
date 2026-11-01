/**
 * electronTransport.ts — HR OA 门户的真实 `OaTransport`（main 进程）。
 *
 * 会话：`persist:hr-oa` 独立 Electron session 作 cookie jar（设计裁定「cookie jar
 * （Electron session 持久化即可）」）——与应用其它网络通道的 cookie 隔离，但跨启动
 * 持久，支撑「未过期凭证 → 静默重登 → 直接进首页」。登出/凭证失效由接线层调
 * `clearCookies()` 清 jar（设计：退出登录清钥匙串凭证、cookie、内存会话）。
 *
 * 重定向：**手动跟随**（bounded）。原因：Electron `Session.fetch` / `net.fetch` 的
 * `Response.url` 是官方文档明示「不正确」的字段，而 oaClient 的会话失效判据
 * （`finalUrl` 含 anonym.jsp / login_error）与锁定判据依赖最终 URL；手动跟随把
 * 每一跳的 URL 攒出来，`finalUrl` 精确，`location` 头也原样保留（oaClient 合同
 * 接受「不跟跳、暴露 3xx + location」的 transport，两种判据形态都覆盖）。
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

export function createHrOaSessionTransport(): HrOaSessionTransport {
  // 惰性取 session：模块可能在 app ready 前被 import，fromPartition 推迟到首发请求。
  function jar(): Electron.Session {
    return session.fromPartition(PARTITION);
  }

  async function request(input: {
    method: 'GET' | 'POST';
    path: string;
    params?: Record<string, string>;
    form?: Record<string, string>;
  }): Promise<OaResponse> {
    const target =
      input.path + (input.params ? `?${new URLSearchParams(input.params).toString()}` : '');
    let method = input.method;
    let body = input.form ? new URLSearchParams(input.form).toString() : undefined;
    let currentUrl = target;

    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
      const init: RequestInit & { redirect: 'manual' } = {
        method,
        redirect: 'manual',
        headers: body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
        body,
      };
      const res = await jar().fetch(currentUrl, init);
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const location = headers['location'];
      if (res.status >= 300 && res.status < 400 && location) {
        // 浏览器同款语义：301/302/303 跟随后转 GET；307/308 保持方法与体。
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      return {
        status: res.status,
        headers,
        body: await res.text(),
        finalUrl: currentUrl,
      };
    }
    throw new Error(`OA request exceeded ${MAX_REDIRECT_HOPS} redirects`);
  }

  return {
    request,
    async clearCookies(): Promise<void> {
      await jar().clearStorageData({ storages: ['cookies'] });
    },
  };
}
