/**
 * 腾讯 SkillHub 来源的入口：进程级单例目录适配器、来源分派规则、安装前置流程。
 *
 * 一个进程只有一个 TencentHttpClient，让列表、搜索、详情、下载共享同一套限速、
 * 退避与熔断——否则每个 SkillhubMarketService 实例各自计数，熔断形同虚设。
 */
import type { ListMarketParams } from '../marketService';
import type { SkillhubCatalogScope } from '../../../shared/skillhubCatalog';
import { createLogger } from '../../logger';
import { TencentTrustStore } from './cache';
import { TencentSkillhubCatalog } from './catalog';
import {
  TencentInstallCheckError,
  downloadTencentZip,
  hasRootSkillMd,
  verifySignatureShadow,
  type TencentZipDownload,
} from './download';
import { isPaidRecord, isSecurityBenign, isValidTencentSlug } from './mapping';
import type { FetchLike } from './http';

export { TencentSkillhubCatalog } from './catalog';
export { TencentSkillhubError, isTencentSkillhubError } from './errors';
export { TencentInstallCheckError } from './download';

const log = createLogger('skillhub:tencent');

let sharedCatalog: TencentSkillhubCatalog | null = null;
let sharedTrust: TencentTrustStore | null = null;

export function getTencentSkillhubCatalog(): TencentSkillhubCatalog {
  if (!sharedCatalog) sharedCatalog = new TencentSkillhubCatalog();
  return sharedCatalog;
}

function getTrustStore(): TencentTrustStore {
  if (!sharedTrust) sharedTrust = new TencentTrustStore();
  return sharedTrust;
}

/**
 * listMarket 的来源分派（D-G 已裁定 + mine 例外）：
 *   - mine=true 一律走 Cindy 原路径（列出用户在 Cindy 发布的技能，腾讯没有这个概念）；
 *   - scope=team 走 Cindy 原路径；
 *   - scope=market、scope=all、scope 缺省走腾讯。
 */
export function isTencentListParams(params: ListMarketParams | undefined): boolean {
  if (params?.mine) return false;
  return params?.scope !== 'team';
}

/**
 * 单条读接口（info / files / file / versions / scan / sync / install）的来源分派：
 * catalogScope=market 走腾讯；team 与缺省（Cindy 管理视图，发布者读自己的记录）走原路径。
 */
export function isTencentCatalogScope(scope: SkillhubCatalogScope | undefined): boolean {
  return scope === 'market';
}

export interface TencentInstallPackage {
  version: string;
  handle: string;
  zip: TencentZipDownload;
}

/**
 * 安装前置流程（方案 §5.1 第 1~6 步）：slug 校验 → 重新取详情（不用缓存）→ 安全与付费
 * 硬门禁 → 下载并做 P0 校验 → zip 根必须有 SKILL.md → TOFU 登记 → P1 shadow 验签。
 * 解压与落盘仍由 installService 现有后半段完成。
 *
 * `requestedVersion` 只用于「更新到 vN」这类显式版本；版本号一律以详情为准，渲染层
 * 传来的版本与平台最新版不一致时，以平台版本为准并记日志（列表版本可能滞后）。
 */
export async function prepareTencentInstall(
  slug: string,
  requestedVersion: string | undefined,
  signal: AbortSignal,
  deps: { catalog?: TencentSkillhubCatalog; trust?: TencentTrustStore; fetchCos?: FetchLike } = {},
): Promise<TencentInstallPackage> {
  if (!isValidTencentSlug(slug)) {
    throw new TencentInstallCheckError('NOT_FOUND', '技能名不合法');
  }
  const catalog = deps.catalog ?? getTencentSkillhubCatalog();
  const detail = await catalog.fetchDetail(slug);
  if (!detail) throw new TencentInstallCheckError('NOT_FOUND', '技能不存在或已下架');
  if (!isSecurityBenign(detail.security)) {
    throw new TencentInstallCheckError('SECURITY_NOT_BENIGN', '该技能的安全报告未通过，已拒绝安装');
  }
  if (detail.paid || isPaidRecord(detail.record)) {
    throw new TencentInstallCheckError('PAID_SKILL', '暂不支持安装付费技能');
  }
  const version = detail.latestVersion;
  if (requestedVersion && requestedVersion !== version) {
    log.info('requested version differs from platform latest; installing platform version', {
      slug, requested: requestedVersion, platform: version,
    });
  }
  const handle = detail.record.handle;
  const zip = await downloadTencentZip(catalog.http, { slug, version, handle, signal }, deps.fetchCos);
  if (!(await hasRootSkillMd(zip.bytes).catch(() => false))) {
    throw new TencentInstallCheckError('DOWNLOAD_FAILED', 'Skill 包根目录缺少 SKILL.md');
  }
  const trust = await (deps.trust ?? getTrustStore()).verifyOrRecord(TencentTrustStore.key(handle, slug, version), zip.sha256);
  if (trust === 'mismatch') {
    throw new TencentInstallCheckError('CHECKSUM_MISMATCH', '下载校验失败：同一版本的包内容与首次安装时不一致');
  }
  const verdict = await verifySignatureShadow(catalog.http, { slug, version, zip, signal }).catch(() => 'unavailable' as const);
  log.info('signature shadow verdict', { slug, version, verdict });
  return { version, handle, zip };
}
