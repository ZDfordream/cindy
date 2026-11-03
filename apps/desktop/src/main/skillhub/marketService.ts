import { ServerApiError, type ApiFetchOptions } from '../serverApiClient';
import { skillhubApiFetch } from './hubApi';
import { mapHubSkillInfoToDesktopInfo, type HubSkillInfoForDesktop } from './infoMapping';
import { buildSkillhubSyncResponse, type SkillhubBatchDetailResponse, type SkillhubSyncRef } from './syncMapping';
import { assertSkillhubVisibilityAllowed, assertSkillhubWriteAllowed } from './identityPolicy';
import { registryService } from './registry';
import { createLogger } from '../logger';
import { skillhubCatalogKey, withSkillhubCatalogScope, type SkillhubCatalogScope } from '../../shared/skillhubCatalog';
import {
  getTencentSkillhubCatalog,
  isTencentSkillhubError,
  isTencentCatalogScope,
  isTencentListParams,
  type TencentSkillhubCatalog,
} from './tencent';

const SKILLHUB_SYNC_BATCH_SIZE = 100;
const HUB_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const log = createLogger('skillhub:marketService');

export type SkillhubMarketFetcher = <T>(apiPath: string, opts?: Omit<ApiFetchOptions, 'baseUrl'>) => Promise<T>;

interface SkillhubInstalledSkillForHub {
  slug: string;
  version: string;
}

interface SkillhubUserDepartmentsResponse {
  departments?: Array<{ deptId: string; name: string; path: string }>;
  firstLevelDepts?: Array<{ deptId: string; name: string }>;
  allDeptIds?: string[];
}

function mapFirstLevelDepartments(
  firstLevelDepts: readonly { deptId: string; name: string }[] | undefined,
): { ids: string[]; names: string[] } {
  const ids: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();

  for (const dept of firstLevelDepts ?? []) {
    if (seen.has(dept.deptId)) continue;
    seen.add(dept.deptId);
    ids.push(dept.deptId);
    names.push(dept.name);
  }

  return { ids, names };
}

export interface SkillhubMarketServiceOptions {
  fetch?: SkillhubMarketFetcher;
  assertWriteAllowed?: () => void | Promise<void>;
  assertVisibilityAllowed?: (visibility: 'private' | 'shared' | 'public') => void | Promise<void>;
  updateRegistryCatalogScope?: (
    name: string,
    scope: SkillhubCatalogScope | undefined,
    previousScope: SkillhubCatalogScope | undefined,
  ) => Promise<void>;
  /**
   * 「公开」目录（catalogScope=market、listMarket 的 all/缺省）的数据来源。默认是进程级
   * 腾讯 SkillHub 适配器；传 null 保持 Cindy Hub 原路径（单测覆盖原路径契约时使用）。
   */
  tencent?: TencentSkillhubCatalog | null;
}

export interface ListMarketParams {
  cursor?: string;
  limit?: number;
  sort?: 'trending' | 'downloads' | 'updated_at' | 'created_at';
  q?: string;
  scope?: 'all' | 'market' | 'team';
  mine?: boolean;
  available?: boolean;
  category?: string;
  installedSkills?: unknown;
}

export interface UpdatePublishedFields {
  displayName?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  contentLocale?: 'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko';
  visibility?: 'private' | 'shared' | 'public';
  /** 归属统一参数:团队 slug / od- 部门 id;null = 收回到个人 */
  teamSlug?: string | null;
}

export interface SetPublishedVisibilityParams {
  name: string;
  visibility: 'private' | 'shared' | 'public';
  /** Catalog containing the currently visible version before this mutation. */
  previousCatalogScope?: SkillhubCatalogScope;
  teamSlug?: string;
  visibleSlugs?: string[];
}

export interface SkillVisibilityUpdateResult {
  slug: string;
  visibility: 'private' | 'shared' | 'public';
  requestedVisibility?: 'public';
  reviewStatus?: 'pending';
}

/**
 * Main-process SkillHub market API adapter.
 *
 * Keeps broker URL construction, input normalization, and Hub-to-desktop DTO
 * mapping out of Electron IPC registration so it can be tested directly.
 *
 * HRBuddy：公开目录改由腾讯 SkillHub 提供（tencent/）。分派规则见
 * isTencentListParams / isTencentCatalogScope：market、all、缺省走腾讯；team、mine=true
 * 与无 scope 的 Cindy 管理视图保持原路径，行为不变。发布、可见性等写操作只存在于
 * Cindy 原路径。
 */
export class SkillhubMarketService {
  private readonly fetch: SkillhubMarketFetcher;
  private readonly assertWriteAllowed: () => void | Promise<void>;
  private readonly assertVisibilityAllowed: (visibility: 'private' | 'shared' | 'public') => void | Promise<void>;
  private readonly updateRegistryCatalogScope: (
    name: string,
    scope: SkillhubCatalogScope | undefined,
    previousScope: SkillhubCatalogScope | undefined,
  ) => Promise<void>;
  private readonly tencent: TencentSkillhubCatalog | null;

  constructor(options: SkillhubMarketServiceOptions = {}) {
    this.fetch = options.fetch ?? skillhubApiFetch;
    this.assertWriteAllowed = options.assertWriteAllowed ?? assertSkillhubWriteAllowed;
    this.assertVisibilityAllowed = options.assertVisibilityAllowed ?? assertSkillhubVisibilityAllowed;
    this.updateRegistryCatalogScope = options.updateRegistryCatalogScope
      ?? registryService.updateCatalogScopeForSkill;
    this.tencent = options.tencent === undefined ? getTencentSkillhubCatalog() : options.tencent;
  }

  async sync(params: { skills?: unknown; slugs?: string[] } | undefined) {
    const refs = normalizeSkillhubSyncRefs(params?.skills ?? params?.slugs);
    const grouped = new Map<SkillhubCatalogScope | undefined, string[]>();
    for (const ref of refs.filter(({ slug }) => isValidHubSlug(slug))) {
      const scope = ref.catalogScope;
      grouped.set(scope, [...(grouped.get(scope) ?? []), ref.slug]);
    }
    const batches = [...grouped.entries()].flatMap(([catalogScope, slugs]) =>
      chunkSkillhubSlugs(slugs).map((batch) => ({ catalogScope, slugs: batch }))
    );
    const tencent = this.tencent;
    const cindyBatches = tencent ? batches.filter(({ catalogScope }) => !isTencentCatalogScope(catalogScope)) : batches;
    const tencentSlugs = tencent
      ? batches.filter(({ catalogScope }) => isTencentCatalogScope(catalogScope)).flatMap(({ slugs }) => slugs)
      : [];
    // 原路径在没有引用时仍发一次空的 market 批量请求以取 availableCount；公开目录改走
    // 腾讯后不再向 Cindy 发这次请求（HR 模式下 Cindy 不可用，会让整个 sync 失败）。
    const requests = cindyBatches.length > 0 || tencent
      ? cindyBatches
      : [{ catalogScope: 'market' as const, slugs: [] }];
    const [detailResponses, tencentItems] = await Promise.all([
      Promise.all(requests.map(async ({ catalogScope, slugs }) => ({
        catalogScope,
        response: await this.fetchSkillhubBatchDetail(slugs, catalogScope),
      }))),
      tencent && tencentSlugs.length > 0 ? tencent.syncDetails(tencentSlugs) : Promise.resolve(new Map()),
    ]);
    const response = buildSkillhubSyncResponse(refs, detailResponses);
    if (tencentItems.size === 0 && tencentSlugs.length === 0) return response;
    // 腾讯条目已经是渲染层形状；按 slug 回填 market 引用的结果，查不到的保持 exists:false。
    return {
      ...response,
      results: response.results.map((result) => {
        if (!isTencentCatalogScope(result.catalogScope)) return result;
        const mapped = tencentItems.get(result.name);
        return mapped ? { exists: true as const, ...mapped } : result;
      }),
    };
  }

  async listMarket(params: ListMarketParams | undefined) {
    if (this.tencent && isTencentListParams(params)) {
      return this.tencent.listMarket(params);
    }
    const page = params?.cursor ? Number(params.cursor) : 1;
    const pageSize = params?.limit ?? 24;
    const installedSkills = normalizeInstalledSkillsForHub(params?.installedSkills);
    const search = new URLSearchParams();
    search.set('page', String(page));
    search.set('pageSize', String(pageSize));
    if (params?.sort) search.set('sort', params.sort);
    if (params?.sort) search.set('order', 'desc');
    if (params?.q) search.set('q', params.q);
    if (params?.category) search.set('category', params.category);

    if (params?.mine) {
      const hubResult = await this.fetch<{ items: HubSkillInfoForDesktop[]; total: number }>(
        `/api/skills-hub/users/published?${search.toString()}`,
      );
      const items = (hubResult.items ?? []).map((item) => mapHubSkillInfoToDesktopInfo(item, { forceMine: true }));
      const hasMore = page * pageSize < hubResult.total;
      return {
        success: true as const,
        items,
        nextCursor: hasMore ? String(page + 1) : null,
      };
    }

    search.set('scope', params?.scope ?? 'all');
    const qs = search.toString();
    const hubResult = await this.fetch<{ items: HubSkillInfoForDesktop[]; total: number }>(
      params?.available
        ? `/api/skills-hub/skills/list?${qs}`
        : `/api/skills-hub/skills?${qs}`,
      params?.available
        ? { method: 'POST', body: { installedSkills: installedSkills ?? [] } }
        : undefined,
    );

    const catalogScope = params?.scope === 'team' ? 'team' : 'market';
    const items = (hubResult.items ?? []).map((item) => mapHubSkillInfoToDesktopInfo(item, { catalogScope }));
    const hasMore = page * pageSize < hubResult.total;
    return {
      success: true as const,
      items,
      nextCursor: hasMore ? String(page + 1) : null,
    };
  }

  async info(name: string, catalogScope?: SkillhubCatalogScope) {
    if (this.tencent && isTencentCatalogScope(catalogScope)) return this.tencent.info(name);
    const hub = await this.fetch<HubSkillInfoForDesktop | { deleted: true }>(
      withSkillhubCatalogScope(`/api/skills-hub/skills/${encodeURIComponent(name)}`, catalogScope),
    );
    if ('deleted' in hub) {
      return { success: true as const, deleted: true as const };
    }
    const info = mapHubSkillInfoToDesktopInfo(hub, { catalogScope });
    return { success: true as const, info };
  }

  async getPublishedFiles({ name, version, catalogScope, includeHashes }: { name: string; version?: string; catalogScope?: SkillhubCatalogScope; includeHashes?: boolean }) {
    if (this.tencent && isTencentCatalogScope(catalogScope)) {
      return this.tencent.getPublishedFiles({ name, version, includeHashes });
    }
    const search = new URLSearchParams();
    if (version) search.set('version', version);
    if (includeHashes) search.set('includeHashes', '1');
    const qs = search.size ? `?${search}` : '';
    const result = await this.fetch<{
      slug: string;
      version: string;
      files: Array<{ path: string; size: number; language: string; truncated: boolean; sha256?: string }>;
    }>(withSkillhubCatalogScope(`/api/skills-hub/skills/${encodeURIComponent(name)}/files${qs}`, catalogScope));
    return { success: true as const, ...result };
  }

  async readPublishedFile({ name, path: filePath, version, catalogScope }: { name: string; path: string; version?: string; catalogScope?: SkillhubCatalogScope }) {
    if (this.tencent && isTencentCatalogScope(catalogScope)) {
      return this.tencent.readPublishedFile({ name, path: filePath, version });
    }
    const search = new URLSearchParams({ path: filePath });
    if (version) search.set('version', version);
    const result = await this.fetch<{
      path: string;
      size: number;
      language: string;
      truncated: boolean;
      content: string;
    }>(withSkillhubCatalogScope(`/api/skills-hub/skills/${encodeURIComponent(name)}/file?${search.toString()}`, catalogScope));
    return { success: true as const, file: result };
  }

  async listPublishedVersions(name: string, catalogScope?: SkillhubCatalogScope) {
    if (this.tencent && isTencentCatalogScope(catalogScope)) return this.tencent.listPublishedVersions();
    const versions = await this.fetch<unknown[]>(
      withSkillhubCatalogScope(`/api/skills-hub/skills/${encodeURIComponent(name)}/versions`, catalogScope),
    );
    return { success: true as const, versions };
  }

  async updatePublished(name: string, fields: UpdatePublishedFields) {
    await this.assertWriteAllowed();
    if (fields.visibility) await this.assertVisibilityAllowed(fields.visibility);
    const result = await this.fetch<unknown>(
      `/api/skills-hub/skills/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: fields },
    );
    return { success: true as const, result };
  }

  async deletePublished(name: string) {
    await this.assertWriteAllowed();
    const result = await this.fetch<unknown>(
      `/api/skills-hub/skills/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    );
    return { success: true as const, result };
  }

  async unpublishPublished(name: string) {
    await this.assertWriteAllowed();
    const result = await this.fetch<unknown>(
      `/api/skills-hub/skills/${encodeURIComponent(name)}/unpublish`,
      { method: 'POST' },
    );
    return { success: true as const, result };
  }

  async setPublishedVisibility({ name, visibility, previousCatalogScope, teamSlug, visibleSlugs }: SetPublishedVisibilityParams) {
    await this.assertWriteAllowed();
    await this.assertVisibilityAllowed(visibility);
    const result = await this.fetch<SkillVisibilityUpdateResult>(
      `/api/skills-hub/skills/${encodeURIComponent(name)}/set-visibility`,
      {
        method: 'POST',
        body: {
          visibility,
          ...(teamSlug ? { teamSlug } : {}),
          ...(visibleSlugs !== undefined ? { visibleSlugs } : {}),
        },
      },
    );
    // A public-review request has already moved the user's management view to
    // the native record even while the old catalog visibility remains active.
    const targetVisibility = result.requestedVisibility ?? result.visibility;
    const catalogScope = targetVisibility === 'shared' ? 'team' as const : undefined;
    await this.updateRegistryCatalogScope(name, catalogScope, previousCatalogScope).catch((err) => {
      log.warn(`[visibility] registry catalog scope update failed name=${name}:`, err);
    });
    return { success: true as const, result };
  }

  async getPublishedVisibility(name: string) {
    const result = await this.fetch<{
      sharedTeams?: Array<{ id: number; slug: string; name: string }>;
      visibleDepts?: string[];
    }>(`/api/skills-hub/skills/${encodeURIComponent(name)}/visibility`);
    return {
      success: true as const,
      sharedTeams: result.sharedTeams ?? [],
      visibleDepts: result.visibleDepts ?? [],
    };
  }

  async getMyDepts() {
    const departments = await this.fetch<SkillhubUserDepartmentsResponse>(
      '/api/skills-hub/users/departments',
    );
    const firstLevel = mapFirstLevelDepartments(departments.firstLevelDepts);
    return {
      success: true as const,
      ids: firstLevel.ids,
      names: firstLevel.names,
    };
  }

  async listCategories(scope: SkillhubCatalogScope = 'market', includeEmpty = true) {
    if (this.tencent && isTencentCatalogScope(scope)) return this.tencent.listCategories();
    const items = await this.fetch<Array<{
      slug: string;
      name: string;
      skillCount?: number;
      mySkillCount?: number;
      source?: 'platform';
      children?: Array<{
        slug: string;
        name: string;
        skillCount?: number;
        mySkillCount?: number;
      }>;
    }>>(`/api/skills-hub/categories?scope=${scope}${includeEmpty ? '' : '&includeEmpty=false'}`);
    // Filtering belongs to the server: legacy counts may be absent, and older servers'
    // team responses may contain public-market counts rather than team counts.
    const categories = flattenHubCategories(items ?? []);
    const totalCount = categories.reduce((s, c) => s + c.count, 0);
    const myTotalCount = categories.reduce((s, c) => s + c.myCount, 0);
    return { success: true as const, categories, totalCount, myTotalCount };
  }

  async listUserTeams() {
    const teams = await this.fetch<Array<{
      slug: string;
      name: string;
      type: string;
      source?: string | null;
      isPersonal?: boolean;
      // Hub /users/teams 一直返回我在该团队的角色,之前 desktop 类型没接出来。
      // 「我的管理」用它判断 viewer 身份 → 写操作前提示「权限不足」。
      myRole?: 'admin' | 'publisher' | 'viewer';
    }>>('/api/skills-hub/users/teams');
    return { success: true as const, teams };
  }

  async getScanStatus({ slug, version, catalogScope }: { slug: string; version?: string; catalogScope?: SkillhubCatalogScope }) {
    if (this.tencent && isTencentCatalogScope(catalogScope)) {
      // 腾讯目录只展示两份安全报告都为 benign 的条目，与「审核通过」等价。
      return { success: true as const, status: 'passed', gates: [] as unknown[] };
    }
    const path = `/api/skills-hub/skills/${encodeURIComponent(slug)}/scan${version ? `?version=${encodeURIComponent(version)}` : ''}`;
    const result = await this.fetch<{ status: string; rejectionReason?: string; gates?: unknown[]; scorecard?: unknown }>(
      withSkillhubCatalogScope(path, catalogScope),
      { cache: 'no-store', headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
    );
    return { success: true as const, ...result };
  }

  private fetchSkillhubBatchDetail(slugs: string[], catalogScope?: SkillhubCatalogScope): Promise<SkillhubBatchDetailResponse> {
    return this.fetch<SkillhubBatchDetailResponse>(withSkillhubCatalogScope('/api/skills-hub/skills/batch-detail', catalogScope), {
      method: 'POST',
      body: { slugs },
    });
  }
}

export const skillhubIpcError = (err: unknown) => ({
  success: false as const,
  error: err instanceof Error ? err.message : String(err),
  errorCode: err instanceof ServerApiError || isTencentSkillhubError(err) ? err.code : undefined,
});

export function normalizeSkillhubSlugs(slugs: unknown): string[] {
  return [...new Set((Array.isArray(slugs) ? slugs : []).filter(
    (slug): slug is string => typeof slug === 'string' && slug.length > 0 && slug.length <= 128,
  ))];
}

export function normalizeSkillhubSyncRefs(items: unknown): SkillhubSyncRef[] {
  const refs = Array.isArray(items) ? items : [];
  const byKey = new Map<string, SkillhubSyncRef>();
  for (const item of refs) {
    const raw = typeof item === 'string' ? { slug: item } : item;
    if (!raw || typeof raw !== 'object') continue;
    const slug = (raw as { slug?: unknown }).slug;
    if (typeof slug !== 'string' || slug.length === 0 || slug.length > 128) continue;
    const candidateScope = (raw as { catalogScope?: unknown }).catalogScope;
    const catalogScope = candidateScope === 'team' || candidateScope === 'market'
      ? candidateScope
      : undefined;
    byKey.set(skillhubCatalogKey(slug, catalogScope), { slug, catalogScope });
  }
  return [...byKey.values()];
}

function isValidHubSlug(slug: string): boolean {
  return HUB_SLUG_RE.test(slug);
}

function normalizeInstalledSkillsForHub(items: unknown): SkillhubInstalledSkillForHub[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const bySlug = new Map<string, string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
    const version = typeof raw.version === 'string' ? raw.version.trim() : '';
    if (!slug || slug.length > 128) continue;
    bySlug.set(slug, version);
  }
  return [...bySlug.entries()].map(([slug, version]) => ({ slug, version }));
}

function chunkSkillhubSlugs(slugs: string[]) {
  const chunks: string[][] = [];
  for (let i = 0; i < slugs.length; i += SKILLHUB_SYNC_BATCH_SIZE) {
    chunks.push(slugs.slice(i, i + SKILLHUB_SYNC_BATCH_SIZE));
  }
  return chunks;
}

type HubCategoryNode = {
  slug: string;
  name: string;
  skillCount?: number;
  mySkillCount?: number;
  source?: 'platform';
  children?: HubCategoryNode[];
};

function flattenHubCategories(nodes: HubCategoryNode[]) {
  const out: Array<{
    slug: string;
    name: string;
    count: number;
    myCount: number;
    source?: 'platform';
  }> = [];
  const visit = (node: HubCategoryNode) => {
    out.push({
      slug: node.slug,
      name: node.name,
      count: node.skillCount ?? 0,
      myCount: node.mySkillCount ?? 0,
      source: node.source,
    });
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return out;
}
