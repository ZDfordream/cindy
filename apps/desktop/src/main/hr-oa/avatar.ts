/**
 * avatar.ts — HR OA 个人头像取图与缓存键（main 进程）。
 *
 * 地址规律（集成设计 §4.1 / H8，FR-PROFILE-02）：
 *   `${base}/sys/person/image.jsp?personId=<person_id>&size=b&s_time=<毫秒>`
 * `s_time` 即头像版本号——缓存键 = `personId + sTime`，换头像（换 s_time）即换键。
 *
 * 取图走**登录人自己的 OA 会话**（同一 OaTransport / cookie jar），不走 HRMcp MCP。
 * 二进制边界：`OaResponse.body` 是 string，image/* 响应体由 transport 以 latin1 往返
 * （见 electronTransport）——这里 `charCodeAt & 0xff` 还原字节；HTML/文本响应体仍走
 * UTF-8 解码，与本层无关。
 *
 * 失败合同：任何失败（transport 抛错 / 超时 / 非 200 / 会话弹回 anonym.jsp / 空体）
 * 一律回 `null`、不抛——身份卡有品牌首字兜底，取图层不得炸调用方。日志只落固定文案
 * 与安全字段（status）：transport 抛错原文可能粘连口令残渣或带 person_id 的完整 query，
 * **错误原文不落日志**（反目标：person_id 明文绝不进日志；凭证红线：口令绝不进日志）。
 */

import { createLogger } from '../logger.js';

import type { OaTransport } from './oaClient.js';

/** 头像缓存载荷：`key` = `personId + sTime`（缓存键合同，FR-PROFILE-02）。 */
export interface AvatarCache {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}

const log = createLogger('hr-oa');

const AVATAR_PATH = '/sys/person/image.jsp';
const ANONYM_MARKER = 'anonym.jsp';
const DEFAULT_TIMEOUT_MS = 10_000;

/** 头像地址：末尾斜杠归一（与 oaClient 的 absolute() 同口径），query 顺序为固定协议。 */
export function avatarUrl(baseUrl: string, personId: string, sTime: string | number): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${AVATAR_PATH}?personId=${personId}&size=b&s_time=${sTime}`;
}

/** 缓存键 = personId + sTime（换 s_time 即换键；键变化即整张图换缓存槽）。 */
export function avatarCacheKey(personId: string, sTime: string): string {
  return personId + sTime;
}

class RequestTimeout extends Error {
  constructor() {
    super('OA avatar request timed out');
    this.name = 'RequestTimeout';
  }
}

function headerValue(res: { headers: Record<string, string> }, name: string): string {
  for (const [key, value] of Object.entries(res.headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return '';
}

/** 会话弹回 anonym.jsp（3xx location 与跟随后的 finalUrl 两种形态都认，同 oaClient）。 */
function isAnonymBounce(res: { headers: Record<string, string>; finalUrl: string }): boolean {
  return headerValue(res, 'location').includes(ANONYM_MARKER) || res.finalUrl.includes(ANONYM_MARKER);
}

/** latin1 二进制串 → 字节（transport 对 image/* 体的往返编码，见 electronTransport）。 */
function bytesFromBinaryString(body: string): Uint8Array {
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i += 1) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

/** 本端超时哨兵（Client timeout 10s，与 oaClient 同口径）：超时走失败合同回 null。 */
function guard<T>(call: Promise<T>, timeoutMs: number): Promise<T> {
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

/**
 * 取头像。成功回 `{ key, bytes, contentType }`；失败 / 无 personId 回 `null`（不抛）。
 * 会话 cookie 由 transport 自持（persist:hr-oa），与登录/资料同源。
 */
export async function fetchAvatar(input: {
  baseUrl: string;
  transport: OaTransport;
  personId: string;
  sTime: string;
  deps?: { timeoutMs?: number };
}): Promise<AvatarCache | null> {
  const { baseUrl, transport, personId, sTime } = input;
  if (!personId) return null;
  const timeoutMs = input.deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const target = avatarUrl(baseUrl, personId, sTime);
  try {
    const res = await guard(transport.request({ method: 'GET', path: target }), timeoutMs);
    if (res.status !== 200) {
      log.warn('[hr-oa] avatar fetch failed', { status: res.status });
      return null;
    }
    if (isAnonymBounce(res)) {
      // 会话失效弹回登录页：图没取到，不得把登录页 HTML 当头像字节缓存。
      log.warn('[hr-oa] avatar fetch failed', { reason: 'anonym' });
      return null;
    }
    if (!res.body) {
      log.warn('[hr-oa] avatar fetch failed', { reason: 'empty' });
      return null;
    }
    return {
      key: avatarCacheKey(personId, sTime),
      bytes: bytesFromBinaryString(res.body),
      contentType: headerValue(res, 'content-type') || 'application/octet-stream',
    };
  } catch {
    // fail-soft：不抛。错误原文不落日志（可能粘连口令残渣 / 带 person_id 的完整 query）。
    log.warn('[hr-oa] avatar fetch failed');
    return null;
  }
}
