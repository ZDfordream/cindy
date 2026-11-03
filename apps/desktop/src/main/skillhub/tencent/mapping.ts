/**
 * 腾讯 SkillHub 响应 → cindy 现有 HubSkillInfoForDesktop 形状（方案 §3.2）。
 *
 * 腾讯三个接口字段名不一致：列表 iconUrl/ownerName/updated_at，搜索 icon_url/
 * owner_name/updatedAt，详情嵌在 skill.*。这里各写一份取值函数，统一产出
 * TencentSkillRecord（保留过滤与校验要用的字段），再转成 HubSkillInfoForDesktop，
 * 复用 mapHubSkillInfoToDesktopInfo，避免维护两套渲染层形状。
 *
 * 所有输入都是第三方未认证数据：逐字段做类型检查，缺必需键的条目丢弃。
 */
import type { HubSkillInfoForDesktop } from '../infoMapping';
import {
  TENCENT_COS_HOST,
  TENCENT_HANDLE_RE,
  TENCENT_HIDDEN_CATEGORY_KEYS,
  TENCENT_ICON_HOSTS,
  TENCENT_MAX_QUERY_LENGTH,
  TENCENT_SLUG_RE,
} from './constants';

type Json = Record<string, unknown>;

/** 适配器内部的统一条目；比渲染层形状多保留过滤用的字段。 */
export interface TencentSkillRecord {
  slug: string;
  handle: string;
  displayName: string;
  description: string;
  version: string;
  ownerName: string;
  publisherName?: string;
  iconUrl: string | null;
  category?: string;
  subCategories: Array<{ key: string; name: string }>;
  updatedAtMs?: number;
  downloads: number;
  pricingType?: string;
  githubUrl: string | null;
}

export interface TencentSecurityVerdict {
  keen?: string;
  sanbu?: string;
}

/** 详情接口的关键字段，安装前复核与版本判断用。 */
export interface TencentSkillDetail {
  record: TencentSkillRecord;
  latestVersion: string;
  security: TencentSecurityVerdict;
  /** 详情顶层 pricing 对象或 labels.pricing_type 任一存在即视为付费。 */
  paid: boolean;
}

export interface TencentCategory {
  key: string;
  name: string;
  sortOrder: number;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function isValidTencentSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && TENCENT_SLUG_RE.test(slug);
}

export function isValidTencentHandle(handle: unknown): handle is string {
  return typeof handle === 'string' && TENCENT_HANDLE_RE.test(handle);
}

/** 只放行白名单主机与路径前缀的 https 图标；其余置空，SkillIcon 显示默认图标。 */
export function sanitizeIconUrl(raw: unknown): string | null {
  const value = str(raw);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const prefix = TENCENT_ICON_HOSTS.get(url.hostname.toLowerCase());
    if (prefix === undefined) return null;
    if (prefix && !url.pathname.startsWith(prefix)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function githubUrlOf(raw: unknown): string | null {
  const value = str(raw);
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com' ? url.href : null;
  } catch {
    return null;
  }
}

function subCategoriesOf(raw: unknown): Array<{ key: string; name: string }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isObj(item)) return [];
    const key = str(item.key);
    const name = str(item.name);
    return key && name ? [{ key, name }] : [];
  });
}

function pricingTypeOf(labels: unknown): string | undefined {
  return isObj(labels) ? str(labels.pricing_type) : undefined;
}

function handleOf(namespace: unknown): string | undefined {
  const handle = isObj(namespace) ? str(namespace.handle) : undefined;
  return isValidTencentHandle(handle) ? handle : undefined;
}

/** 列表接口 /api/skills 的单项。 */
export function recordFromListItem(raw: unknown): TencentSkillRecord | null {
  if (!isObj(raw)) return null;
  const slug = raw.slug;
  const handle = handleOf(raw.namespace);
  const version = str(raw.version);
  if (!isValidTencentSlug(slug) || !handle || !version) return null;
  const namespace = raw.namespace as Json;
  const publisher = isObj(raw.publisher) ? str(raw.publisher.name) : undefined;
  return {
    slug,
    handle,
    displayName: str(raw.name) ?? slug,
    description: str(raw.description_zh) ?? str(raw.description) ?? '',
    version,
    ownerName: str(namespace.displayName) ?? str(raw.ownerName) ?? handle,
    ...(publisher ? { publisherName: publisher } : {}),
    iconUrl: sanitizeIconUrl(raw.iconUrl),
    ...(str(raw.category) ? { category: str(raw.category) } : {}),
    subCategories: subCategoriesOf(raw.subCategories),
    updatedAtMs: num(raw.updated_at) ?? num(raw.created_at),
    downloads: num(raw.downloads) ?? 0,
    ...(pricingTypeOf(raw.labels) ? { pricingType: pricingTypeOf(raw.labels) } : {}),
    githubUrl: githubUrlOf(raw.upstream_url),
  };
}

/** 搜索接口 /api/v1/search 的单项（没有 subCategories、publisher 可能为 null）。 */
export function recordFromSearchItem(raw: unknown): TencentSkillRecord | null {
  if (!isObj(raw)) return null;
  const slug = raw.slug;
  const handle = handleOf(raw.namespace);
  const version = str(raw.version);
  if (!isValidTencentSlug(slug) || !handle || !version) return null;
  const namespace = raw.namespace as Json;
  const publisher = isObj(raw.publisher) ? str(raw.publisher.name) : undefined;
  return {
    slug,
    handle,
    displayName: str(raw.displayName) ?? str(raw.name) ?? slug,
    description: str(raw.description_zh) ?? str(raw.description) ?? str(raw.summary) ?? '',
    version,
    ownerName: str(namespace.displayName) ?? str(raw.owner_name) ?? handle,
    ...(publisher ? { publisherName: publisher } : {}),
    iconUrl: sanitizeIconUrl(raw.icon_url ?? raw.iconUrl),
    ...(str(raw.category) ? { category: str(raw.category) } : {}),
    subCategories: [],
    updatedAtMs: num(raw.updatedAt) ?? num(raw.updated_at) ?? num(raw.created_at),
    downloads: num(raw.downloads) ?? 0,
    ...(pricingTypeOf(raw.labels) ? { pricingType: pricingTypeOf(raw.labels) } : {}),
    githubUrl: githubUrlOf(raw.upstream_url),
  };
}

function securityOf(raw: unknown): TencentSecurityVerdict {
  if (!isObj(raw)) return {};
  const statusOf = (report: unknown) => (isObj(report) ? str(report.status)?.toLowerCase() : undefined);
  return { keen: statusOf(raw.keen), sanbu: statusOf(raw.sanbu) };
}

/**
 * 详情 /api/v1/skills/{slug} 或批量详情的单项。
 * 批量详情的 item 没有顶层 slug/namespace，slug 在 skill.slug；namespace 只能沿用
 * 调用方已知的 handle（来自列表或搜索）。
 */
export function detailFromResponse(raw: unknown, knownHandle?: string): TencentSkillDetail | null {
  if (!isObj(raw) || !isObj(raw.skill)) return null;
  const skill = raw.skill;
  const slug = skill.slug ?? raw.slug;
  const handle = handleOf(raw.namespace) ?? (isValidTencentHandle(knownHandle) ? knownHandle : undefined);
  const latest = isObj(raw.latestVersion) ? str(raw.latestVersion.version) : undefined;
  if (!isValidTencentSlug(slug) || !handle || !latest) return null;
  const namespace = isObj(raw.namespace) ? raw.namespace : {};
  const owner = isObj(raw.owner) ? raw.owner : {};
  const publisher = isObj(raw.publisher) ? str(raw.publisher.name) : undefined;
  const stats = isObj(skill.stats) ? skill.stats : {};
  const pricingType = pricingTypeOf(skill.labels);
  const record: TencentSkillRecord = {
    slug,
    handle,
    displayName: str(skill.displayName) ?? slug,
    description: str(skill.summary_zh) ?? str(skill.summary) ?? '',
    version: latest,
    ownerName: str(namespace.displayName) ?? str(owner.displayName) ?? handle,
    ...(publisher ? { publisherName: publisher } : {}),
    iconUrl: sanitizeIconUrl(skill.iconUrl),
    ...(str(skill.category) ? { category: str(skill.category) } : {}),
    subCategories: subCategoriesOf(skill.subCategories),
    updatedAtMs: num(skill.updatedAt) ?? num(skill.createdAt),
    downloads: num(stats.downloads) ?? 0,
    ...(pricingType ? { pricingType } : {}),
    githubUrl: githubUrlOf(skill.upstream_url),
  };
  return {
    record,
    latestVersion: latest,
    security: securityOf(raw.securityReports),
    paid: Boolean(pricingType) || raw.pricing !== undefined && raw.pricing !== null,
  };
}

/** keen 与 sanbu 都必须是 benign；缺报告、扫描中、可疑都不放行（方案 §4.5、§5.6）。 */
export function isSecurityBenign(security: TencentSecurityVerdict): boolean {
  return security.keen === 'benign' && security.sanbu === 'benign';
}

/** 列表默认隐藏付费条目。 */
export function isPaidRecord(record: TencentSkillRecord): boolean {
  return Boolean(record.pricingType);
}

export function categoriesFromResponse(raw: unknown): TencentCategory[] {
  const items = isObj(raw) && Array.isArray(raw.items) ? raw.items : [];
  return items
    .flatMap((item): TencentCategory[] => {
      if (!isObj(item) || item.active !== true) return [];
      const key = str(item.key);
      const name = str(item.name);
      if (!key || !name || TENCENT_HIDDEN_CATEGORY_KEYS.has(key)) return [];
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) return [];
      return [{ key, name, sortOrder: num(item.sortOrder) ?? 0 }];
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** 统一条目 → 现有 Hub 形状，之后交给 mapHubSkillInfoToDesktopInfo。 */
export function toHubSkillInfo(
  record: TencentSkillRecord,
  categoryNames: ReadonlyMap<string, string>,
): HubSkillInfoForDesktop {
  const categoryName = record.category ? categoryNames.get(record.category) : undefined;
  return {
    slug: record.slug,
    icon: record.iconUrl,
    displayName: record.displayName,
    summary: record.description,
    version: record.version,
    owner: { slug: record.handle, name: record.ownerName },
    ...(record.publisherName ? { publisher: { name: record.publisherName } } : {}),
    visibility: 'public',
    updatedAt: record.updatedAtMs !== undefined
      ? new Date(record.updatedAtMs).toISOString()
      : new Date(0).toISOString(),
    categories: record.category && categoryName ? [{ slug: record.category, name: categoryName }] : [],
    tags: record.subCategories.map((tag) => ({ slug: tag.key, name: tag.name })),
    githubUrl: record.githubUrl,
    stats: { downloads: record.downloads },
  };
}

/**
 * 搜索词清洗：去控制字符与 < > ' " & % ; \ 等符号，合并空白，截到 64 字符。
 * 结果为空时不发请求（空 q 会返回 3 条无关结果）。
 */
export function sanitizeSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>'"&%;\\`{}[\]|^$*+?=()#@!~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TENCENT_MAX_QUERY_LENGTH)
    .trim();
}

/** WAF 退化：只保留字母数字（含中日韩文字）、空格、- _ .，白名单字符集。 */
export function strictSearchQuery(query: string): string {
  return query
    .replace(/[^\p{L}\p{N}\s\-_.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 首页的本地子串过滤，用于 WAF 二次失败后的退化，以及与首页字面过滤口径一致。 */
export function matchesQueryLocally(record: TencentSkillRecord, query: string): boolean {
  const needle = query.toLowerCase();
  return [record.displayName, record.slug, record.description, record.ownerName, record.publisherName ?? '']
    .some((field) => field.toLowerCase().includes(needle));
}

/** 下载跳转目标：只允许 COS 主机 https、无凭据、路径前缀匹配。 */
export function isAllowedCosUrl(rawUrl: string, pathPrefix: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && url.hostname.toLowerCase() === TENCENT_COS_HOST
      && (url.port === '' || url.port === '443')
      && url.pathname.startsWith(pathPrefix)
      && !url.pathname.includes('/../');
  } catch {
    return false;
  }
}
