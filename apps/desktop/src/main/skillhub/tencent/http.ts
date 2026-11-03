/**
 * 腾讯 SkillHub 的 HTTP 客户端：所有发往 api.skillhub.cn 的请求只经这里。
 *
 * 职责（方案 §2.2、§7.2）：
 *   - 自带 HTTP 栈，绝不经 serverApiFetch：后者在有登录令牌时附加
 *     `Authorization: Bearer`，会把 Cindy 令牌发给第三方。这里不带 Cookie、不带
 *     Authorization，只带诚实 UA `HRBuddy/<版本>`。
 *   - 默认走 outboundFetch（Node undici，吃系统代理，可覆盖 User-Agent）。Electron
 *     net.fetch 能否覆盖 UA 未验证，所以不用它。
 *   - 先看 Content-Type 再解析：腾讯的错误体有 JSON、text/plain、HTML（566 WAF）三种。
 *   - 全局令牌桶限速、同键在途合并、指数退避、熔断（5 次连续失败开 5 分钟，到期只放
 *     1 个探测请求）。退避与熔断期间直接抛错，由上层回落到缓存 / 快照 / 种子。
 *   - 远程开关：端点清单 `tencentSkillhubApiBaseUrl` 为空用内置基址；填了白名单外的
 *     值即关闭。清单只在启动时解析，所以开关下次启动生效，实时止损靠本地熔断。
 */
import { app } from 'electron';

import { getClientEndpoint } from '../../clientEndpointsService';
import { createLogger } from '../../logger';
import { outboundFetch } from '../../maker-host/outbound-fetch';
import {
  TENCENT_API_HOSTS,
  TENCENT_BACKOFF,
  TENCENT_CIRCUIT,
  TENCENT_MAX_REDIRECT_HOPS,
  TENCENT_RATE_LIMIT,
  TENCENT_REQUEST_TIMEOUT_MS,
  TENCENT_SKILLHUB_DEFAULT_API_BASE_URL,
} from './constants';
import { TencentSkillhubError, isTencentTransientFailure } from './errors';

const log = createLogger('skillhub:tencent:http');

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TencentHttpDeps {
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  userAgent: () => string;
  /** 端点清单里的原始值；空串表示用内置基址。 */
  configuredBaseUrl: () => string;
}

export interface TencentRequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  /** 日志里用的路由模板，不含 slug、搜索词等用户相关内容。 */
  label: string;
  /**
   * 跳过退避等待（熔断仍然生效）。只给 WAF 退化的那 1 次严格字符集重试用：
   * 566 本身会触发退避，不跳过的话这次重试必然被自己刚设的退避挡住。
   */
  bypassBackoff?: boolean;
}

/**
 * 清单值 → 实际 API 基址；null 表示来源被远程关闭。
 *
 * 注意：清单（含 config/endpoint*.json 随包快照与本地缓存）的非空值必须落在本区域
 * Cindy 域内，否则 findUntrustedCachedEndpoint 会把整份缓存／随包清单判为不可信，
 * 离线启动出口失效。所以：
 *   - 正常开启：不写这个键（缺省用内置基址）；不要写成 https://api.skillhub.cn。
 *   - 远程关闭：写成本区域 Cindy 域下的任意 https 地址（如
 *     `https://skillhub-off.cindy.com.cn`），它不在 API 白名单里，即视为关闭。
 */
export function resolveTencentApiBaseUrl(configured: string): string | null {
  const raw = configured.trim();
  if (!raw) return TENCENT_SKILLHUB_DEFAULT_API_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!TENCENT_API_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readConfiguredBaseUrl(): string {
  try {
    return getClientEndpoint('tencentSkillhubApiBaseUrl');
  } catch {
    // 清单尚未初始化（极早期调用或单测）时按缺省处理：缺省即开启。
    return '';
  }
}

export function defaultTencentHttpDeps(): TencentHttpDeps {
  return {
    fetch: outboundFetch as FetchLike,
    now: Date.now,
    sleep: defaultSleep,
    random: Math.random,
    userAgent: () => `HRBuddy/${app.getVersion()}`,
    configuredBaseUrl: readConfiguredBaseUrl,
  };
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, TENCENT_BACKOFF.maxMs);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - now, TENCENT_BACKOFF.maxMs));
  return undefined;
}

function isHtml(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().includes('text/html');
}

/** HTTP 状态 → 错误分类。566 与 HTML 体是 WAF 拦截页，不是限流。 */
function classifyHttpFailure(response: Response, now: number): TencentSkillhubError {
  const status = response.status;
  const requestId = response.headers.get('x-request-id') ?? undefined;
  if (status === 566) return new TencentSkillhubError('WAF_BLOCKED', status, requestId);
  if (status === 429) {
    return new TencentSkillhubError(
      'RATE_LIMITED',
      status,
      requestId,
      parseRetryAfter(response.headers.get('retry-after'), now),
    );
  }
  if (status >= 500) return new TencentSkillhubError('INTERNAL_ERROR', status, requestId);
  if (status === 404) return new TencentSkillhubError('NOT_FOUND', status, requestId);
  return new TencentSkillhubError('BAD_REQUEST', status, requestId);
}

/**
 * Rate-limited, circuit-broken HTTP client for the Tencent SkillHub API.
 * One instance is shared by the catalog and download paths so that backoff and
 * the circuit cover every request this process sends to the third party.
 */
export class TencentHttpClient {
  private tokens: number = TENCENT_RATE_LIMIT.burst;
  private lastRefill = 0;
  private consecutiveFailures = 0;
  private blockedUntil = 0;
  private blockedKind: TencentSkillhubError['kind'] = 'NETWORK_ERROR';
  private circuitOpenUntil = 0;
  private halfOpenProbeInFlight = false;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly deps: TencentHttpDeps;

  constructor(deps: Partial<TencentHttpDeps> = {}) {
    this.deps = { ...defaultTencentHttpDeps(), ...deps };
    this.lastRefill = this.deps.now();
  }

  /** null = 来源被远程开关关闭。 */
  baseUrl(): string | null {
    return resolveTencentApiBaseUrl(this.deps.configuredBaseUrl());
  }

  isEnabled(): boolean {
    return this.baseUrl() !== null;
  }

  /** 诚实 UA，COS 下载与预览共用。 */
  userAgent(): string {
    return this.deps.userAgent();
  }

  /** GET/POST JSON。同一 method+path+body 的并发调用共享一个请求。 */
  requestJson<T>(path: string, opts: TencentRequestOptions): Promise<T> {
    const method = opts.method ?? 'GET';
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const key = `${method} ${path} ${body ?? ''}`;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const pending = this.send(path, method, body, opts, 'json')
      .finally(() => this.inflight.delete(key)) as Promise<T>;
    this.inflight.set(key, pending);
    return pending;
  }

  /**
   * 请求一个应当返回 302 的入口（下载、单文件），只取 Location，不信任 302 正文。
   * 返回的 URL 由调用方按用途再做主机与路径前缀校验。
   */
  requestRedirect(path: string, opts: TencentRequestOptions): Promise<string> {
    return this.send(path, 'GET', undefined, opts, 'redirect') as Promise<string>;
  }

  /** 供单测与诊断读取：当前是否处于熔断打开期。 */
  isCircuitOpen(): boolean {
    return this.deps.now() < this.circuitOpenUntil;
  }

  private async send(
    path: string,
    method: 'GET' | 'POST',
    body: string | undefined,
    opts: TencentRequestOptions,
    expect: 'json' | 'redirect',
  ): Promise<unknown> {
    const baseUrl = this.baseUrl();
    if (!baseUrl) throw new TencentSkillhubError('DISABLED');
    const probe = this.admit(opts.bypassBackoff === true);
    try {
      await this.takeToken(opts.signal);
      const result = await this.fetchOnce(`${baseUrl}${path}`, method, body, opts, expect);
      this.recordSuccess();
      return result;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      this.recordFailure(err);
      throw err;
    } finally {
      if (probe) this.halfOpenProbeInFlight = false;
    }
  }

  /** 熔断与退避的准入判断；返回本次是否为半开探测请求。 */
  private admit(bypassBackoff: boolean): boolean {
    const now = this.deps.now();
    if (now < this.circuitOpenUntil) throw new TencentSkillhubError('CIRCUIT_OPEN');
    if (this.consecutiveFailures >= TENCENT_CIRCUIT.failureThreshold) {
      // 熔断到期：半开，只放一个探测请求，其余继续按熔断处理。
      if (this.halfOpenProbeInFlight) throw new TencentSkillhubError('CIRCUIT_OPEN');
      this.halfOpenProbeInFlight = true;
      return true;
    }
    if (!bypassBackoff && now < this.blockedUntil) throw new TencentSkillhubError(this.blockedKind);
    return false;
  }

  private async takeToken(signal?: AbortSignal): Promise<void> {
    for (;;) {
      const now = this.deps.now();
      const refill = Math.floor((now - this.lastRefill) / TENCENT_RATE_LIMIT.intervalMs);
      if (refill > 0) {
        this.tokens = Math.min(TENCENT_RATE_LIMIT.burst, this.tokens + refill);
        this.lastRefill += refill * TENCENT_RATE_LIMIT.intervalMs;
      }
      if (this.tokens >= TENCENT_RATE_LIMIT.burst) this.lastRefill = now;
      if (this.tokens > 0) {
        this.tokens -= 1;
        return;
      }
      await this.deps.sleep(this.lastRefill + TENCENT_RATE_LIMIT.intervalMs - now, signal);
    }
  }

  private async fetchOnce(
    url: string,
    method: 'GET' | 'POST',
    body: string | undefined,
    opts: TencentRequestOptions,
    expect: 'json' | 'redirect',
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(TENCENT_REQUEST_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.deps.fetch(url, {
        method,
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal,
        headers: {
          'User-Agent': this.deps.userAgent(),
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      log.warn(`[${opts.label}] network failure`, err instanceof Error ? err.name : 'unknown');
      throw new TencentSkillhubError('NETWORK_ERROR');
    }
    const requestId = response.headers.get('x-request-id') ?? undefined;

    if (expect === 'redirect') {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        try {
          return new URL(location, url).href;
        } catch {
          throw new TencentSkillhubError('URL_POLICY', response.status, requestId);
        }
      }
      if (response.ok) throw new TencentSkillhubError('BAD_RESPONSE', response.status, requestId);
      const failure = classifyHttpFailure(response, this.deps.now());
      this.logFailure(opts.label, failure);
      throw failure;
    }

    if (!response.ok || isHtml(response)) {
      await response.body?.cancel().catch(() => undefined);
      const failure = response.ok
        ? new TencentSkillhubError('WAF_BLOCKED', response.status, requestId)
        : classifyHttpFailure(response, this.deps.now());
      this.logFailure(opts.label, failure);
      throw failure;
    }
    try {
      return await response.json();
    } catch {
      const failure = new TencentSkillhubError('BAD_RESPONSE', response.status, requestId);
      this.logFailure(opts.label, failure);
      throw failure;
    }
  }

  private logFailure(label: string, failure: TencentSkillhubError): void {
    log.warn(`[${label}] ${failure.kind} status=${failure.statusCode} requestId=${failure.detail ?? '-'}`);
  }

  private recordSuccess(): void {
    if (this.consecutiveFailures >= TENCENT_CIRCUIT.failureThreshold) {
      log.info('circuit closed after successful probe');
    }
    this.consecutiveFailures = 0;
    this.blockedUntil = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(err: unknown): void {
    if (!isTencentTransientFailure(err)) {
      // 404/400 说明服务本身正常，不计入熔断，也不打断已有退避。
      return;
    }
    const now = this.deps.now();
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= TENCENT_CIRCUIT.failureThreshold) {
      this.circuitOpenUntil = now + TENCENT_CIRCUIT.openMs;
      log.warn(`circuit opened for ${TENCENT_CIRCUIT.openMs}ms after ${this.consecutiveFailures} failures`);
      return;
    }
    const retryAfter = err instanceof TencentSkillhubError ? err.retryAfterMs : undefined;
    const exp = Math.min(
      TENCENT_BACKOFF.maxMs,
      TENCENT_BACKOFF.baseMs * 2 ** (this.consecutiveFailures - 1),
    );
    const jitter = 1 + (this.deps.random() * 2 - 1) * TENCENT_BACKOFF.jitter;
    this.blockedUntil = now + (retryAfter ?? Math.round(exp * jitter));
    this.blockedKind = err instanceof TencentSkillhubError ? err.kind : 'NETWORK_ERROR';
  }
}

/** 允许跟随的最大跳数（导出给下载模块共用同一上限）。 */
export const MAX_REDIRECT_HOPS = TENCENT_MAX_REDIRECT_HOPS;
