/**
 * 腾讯来源的下载与校验（方案 §5.1、§5.2）。
 *
 * 不复用共享 download()：它在入口强制要求 64 位 sha256，而腾讯下载前只给 ETag（zip
 * 的 md5）。修改共享下载器让 sha256 可选会影响其他调用方（verified-downloads.md
 * 的「不能为统一形式取消摘要要求」），所以这里单独实现，只服务这一个来源。
 *
 * P0（必做，失败即拒绝）：
 *   - API 入口返回 302，Location 只能落在 COS 主机的 /skills/ 前缀，https、无凭据；
 *     COS 本身再重定向一律拒绝（redirect: 'error'）。
 *   - Content-Length 不超过 200 MB；流式读取边写临时文件边算 md5 与 sha256，超限即中止。
 *   - md5 必须等于 COS ETag；zip sha256 登记到 TOFU 信任表，同 key 变了即拒绝。
 * P1（shadow，只记录不阻断）：Ed25519 验签 + content_hash 复算，见 verifySignatureShadow。
 */
import crypto from 'node:crypto';

import JSZip from 'jszip';

import { createLogger } from '../../logger';
import { outboundFetch } from '../../maker-host/outbound-fetch';
import {
  TENCENT_CONTENT_HASH_EXCLUDED,
  TENCENT_DOWNLOAD_PATH_PREFIX,
  TENCENT_DOWNLOAD_TIMEOUT_MS,
  TENCENT_MAX_ZIP_BYTES,
  TENCENT_PLATFORM_KEYS,
} from './constants';
import { TencentSkillhubError } from './errors';
import type { FetchLike, TencentHttpClient } from './http';
import { isAllowedCosUrl } from './mapping';

const log = createLogger('skillhub:tencent:download');

export interface TencentZipDownload {
  /** 完整 zip 字节；200 MB 上限内，交给 installService 现有解压流程。 */
  bytes: Uint8Array;
  md5: string;
  sha256: string;
}

/** 解析 ETag：COS 返回带引号的 32 位小写十六进制；分片上传的 `-N` 形式不是 md5。 */
export function etagMd5(etag: string | null): string | null {
  if (!etag) return null;
  const value = etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(value) ? value : null;
}

/**
 * Resolve the download entry (302) and stream the zip from COS with P0 checks.
 * Throws TencentSkillhubError for policy/network failures and returns verified bytes.
 */
export async function downloadTencentZip(
  http: TencentHttpClient,
  params: { slug: string; version: string; handle: string; signal: AbortSignal },
  fetchImpl: FetchLike = outboundFetch as FetchLike,
): Promise<TencentZipDownload> {
  const search = new URLSearchParams({ slug: params.slug, version: params.version, namespace: params.handle });
  const location = await http.requestRedirect(`/api/v1/download?${search}`, {
    label: 'GET /api/v1/download',
    signal: params.signal,
  });
  if (!isAllowedCosUrl(location, TENCENT_DOWNLOAD_PATH_PREFIX)) {
    log.warn('download redirect rejected by allowlist');
    throw new TencentSkillhubError('URL_POLICY');
  }

  const timeout = AbortSignal.timeout(TENCENT_DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(location, {
      method: 'GET',
      // COS 不应再跳；任何再跳都可能离开白名单，直接失败。
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.any([params.signal, timeout]),
      headers: { 'User-Agent': http.userAgent(), 'Accept-Encoding': 'identity' },
    });
  } catch (err) {
    if (params.signal.aborted) throw err;
    throw new TencentSkillhubError('NETWORK_ERROR');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TencentSkillhubError(response.status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', response.status);
  }
  const declared = response.headers.get('content-length');
  const declaredBytes = declared === null ? null : Number(declared);
  if (declaredBytes !== null && (!Number.isSafeInteger(declaredBytes) || declaredBytes > TENCENT_MAX_ZIP_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new TencentInstallCheckError('DOWNLOAD_FAILED', 'Skill 包超过 200 MB 上限');
  }
  const expectedMd5 = etagMd5(response.headers.get('etag'));
  if (!expectedMd5) {
    await response.body?.cancel().catch(() => undefined);
    throw new TencentInstallCheckError('CHECKSUM_MISMATCH', '下载校验失败：缺少可用的 ETag(md5)');
  }

  const md5 = crypto.createHash('md5');
  const sha256 = crypto.createHash('sha256');
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new TencentSkillhubError('NETWORK_ERROR');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > TENCENT_MAX_ZIP_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TencentInstallCheckError('DOWNLOAD_FAILED', 'Skill 包超过 200 MB 上限');
      }
      md5.update(value);
      sha256.update(value);
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof TencentInstallCheckError || params.signal.aborted) throw err;
    throw new TencentSkillhubError('NETWORK_ERROR');
  }
  if (declaredBytes !== null && received !== declaredBytes) {
    throw new TencentInstallCheckError('CHECKSUM_MISMATCH', '下载校验失败：大小与 Content-Length 不一致');
  }
  const actualMd5 = md5.digest('hex');
  if (actualMd5 !== expectedMd5) {
    throw new TencentInstallCheckError('CHECKSUM_MISMATCH', '下载校验失败：md5 与 ETag 不一致');
  }
  return { bytes: Buffer.concat(chunks), md5: actualMd5, sha256: sha256.digest('hex') };
}

/** 安装阶段的校验失败，携带 InstallErrorCode 供 installService 原样返回。 */
export class TencentInstallCheckError extends Error {
  constructor(
    public readonly installCode: 'DOWNLOAD_FAILED' | 'CHECKSUM_MISMATCH' | 'SECURITY_NOT_BENIGN' | 'PAID_SKILL' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'TencentInstallCheckError';
  }
}

interface SignatureResponse {
  payload?: unknown;
  signature?: unknown;
  key_id?: unknown;
  signed?: unknown;
}

/** Ed25519 raw 公钥 → Node KeyObject（DER SPKI 前缀 + 32 字节）。 */
function ed25519PublicKey(rawB64: string): crypto.KeyObject {
  const raw = Buffer.from(rawB64, 'base64');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

/** content_hash：排除集合外的文件按路径排序，拼接 `<path>:<sha256>\n` 再整体 sha256。 */
export async function computeContentHash(zipBytes: Uint8Array): Promise<{ hash: string; fileCount: number }> {
  const zip = await JSZip.loadAsync(zipBytes);
  const files = Object.values(zip.files)
    .filter((entry) => !entry.dir && !entry.name.startsWith('__MACOSX/'))
    .filter((entry) => !TENCENT_CONTENT_HASH_EXCLUDED.has(entry.name))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let lines = '';
  for (const entry of files) {
    const buf = await entry.async('nodebuffer');
    lines += `${entry.name}:${crypto.createHash('sha256').update(buf).digest('hex')}\n`;
  }
  return { hash: crypto.createHash('sha256').update(lines, 'utf8').digest('hex'), fileCount: files.length };
}

export type SignatureVerdict =
  | 'verified'
  | 'unsigned'
  | 'unknown-key'
  | 'bad-signature'
  | 'payload-mismatch'
  | 'content-hash-mismatch'
  | 'unavailable';

/**
 * P1 签名校验，shadow 模式：结果只写日志，不阻断安装（方案 §5.2 建议策略）。
 * 只在 1 个样本上验证过；content_hash 的排除集合可能不全，一开始就阻断会误杀。
 */
export async function verifySignatureShadow(
  http: TencentHttpClient,
  params: { slug: string; version: string; zip: TencentZipDownload; signal: AbortSignal },
): Promise<SignatureVerdict> {
  let body: SignatureResponse;
  try {
    body = await http.requestJson<SignatureResponse>(
      `/api/v1/open/skills/${encodeURIComponent(params.slug)}/versions/${encodeURIComponent(params.version)}/signature`,
      { label: 'GET /api/v1/open/skills/:slug/versions/:version/signature', signal: params.signal },
    );
  } catch (err) {
    return err instanceof TencentSkillhubError && err.kind === 'NOT_FOUND' ? 'unsigned' : 'unavailable';
  }
  if (body.signed !== true || typeof body.payload !== 'string' || typeof body.signature !== 'string') {
    return 'unsigned';
  }
  const keyB64 = typeof body.key_id === 'string' ? TENCENT_PLATFORM_KEYS.get(body.key_id) : undefined;
  if (!keyB64) return 'unknown-key';
  // 被签名的消息就是 payload 字符串本身的 UTF-8 字节，不要重新序列化。
  const ok = crypto.verify(null, Buffer.from(body.payload, 'utf8'), ed25519PublicKey(keyB64), Buffer.from(body.signature, 'base64'));
  if (!ok) return 'bad-signature';
  let payload: { skill_slug?: unknown; skill_version?: unknown; package_md5?: unknown; content_hash?: unknown; file_count?: unknown };
  try {
    payload = JSON.parse(body.payload);
  } catch {
    return 'payload-mismatch';
  }
  if (payload.skill_slug !== params.slug || payload.skill_version !== params.version || payload.package_md5 !== params.zip.md5) {
    return 'payload-mismatch';
  }
  const content = await computeContentHash(params.zip.bytes).catch(() => null);
  if (!content || content.hash !== payload.content_hash || content.fileCount !== payload.file_count) {
    return 'content-hash-mismatch';
  }
  return 'verified';
}

/** 首个 SKILL.md 必须在 zip 根（4/4 样本如此；有包裹目录时按 EXTRACT_FAILED 处理）。 */
export async function hasRootSkillMd(zipBytes: Uint8Array): Promise<boolean> {
  const zip = await JSZip.loadAsync(zipBytes);
  return zip.file('SKILL.md') !== null;
}
