/**
 * 腾讯 SkillHub 目录适配器：把 SkillhubMarketService 的读接口翻译成腾讯 HTTP 调用，
 * 再把响应翻译回现有 IPC 形状（方案 §2.1、§3、§4）。
 *
 * 分派规则（D-G 已裁定）：scope=market、scope=all、scope 缺省都走这里；只有
 * scope=team 和 mine=true 仍走 Cindy 原路径（mine=true 由用户另行裁定保持原路径）。
 *
 * 浏览：/api/skills 分页；默认过滤隐藏付费与安全报告非 benign 的条目，过滤后不足一页
 *   时在同一次调用内补 1 页（最坏 2 次列表 + 2 次批量详情）。
 * 搜索：腾讯无分页，对同一清洗后的词取 100 条缓存，主进程按 24 条伪分页。渲染层没有
 *   防抖，这里做 400 ms 尾部防抖与单飞，被新输入取代的调用直接丢弃。
 * 降级：断网或熔断时依次用未过期内存缓存 → 磁盘快照（≤7 天）→ 随包种子 → 抛错。
 */
import { createLogger } from '../../logger';
import { mapHubSkillInfoToDesktopInfo } from '../infoMapping';
import type { ListMarketParams } from '../marketService';
import {
  TENCENT_BATCH_SIZE,
  TENCENT_FILE_PATH_PREFIX,
  TENCENT_MAX_PAGE_SIZE,
  TENCENT_MAX_PREVIEW_BYTES,
  TENCENT_PAGE_SIZE,
  TENCENT_SEARCH_DEBOUNCE_MS,
  TENCENT_SEARCH_LIMIT,
  TENCENT_SNAPSHOT_WRITE_INTERVAL_MS,
  TENCENT_TTL,
} from './constants';
import { TencentSkillhubError } from './errors';
import { TencentHttpClient, type FetchLike } from './http';
import {
  categoriesFromResponse,
  detailFromResponse,
  isAllowedCosUrl,
  isPaidRecord,
  isSecurityBenign,
  isValidTencentSlug,
  matchesQueryLocally,
  recordFromListItem,
  recordFromSearchItem,
  sanitizeSearchQuery,
  strictSearchQuery,
  toHubSkillInfo,
  type TencentCategory,
  type TencentSkillDetail,
  type TencentSkillRecord,
} from './mapping';
import { TencentSnapshotStore, TtlCache, type TencentHomeSnapshot } from './cache';
import { loadTencentSeed, type TencentSeed } from './seed';
import { outboundFetch } from '../../maker-host/outbound-fetch';

const log = createLogger('skillhub:tencent:catalog');

type DesktopInfo = ReturnType<typeof mapHubSkillInfoToDesktopInfo>;

export interface TencentListResult {
  success: true;
  items: DesktopInfo[];
  nextCursor: string | null;
}

export interface TencentCatalogDeps {
  http: TencentHttpClient;
  snapshots: TencentSnapshotStore;
  seed: () => TencentSeed | null;
  now: () => number;
  /** 防抖等待；单测注入立即返回的实现。 */
  delay: (ms: number) => Promise<void>;
  /** 单文件预览从 COS 取正文用；与 API 客户端分开，因为 COS 不在 API 白名单里。 */
  fetchCos: FetchLike;
}

/** 浏览排序：trending 映射到下载量（D-D）；created_at 腾讯返回 400，退化为最近更新。 */
export function tencentSortBy(sort: ListMarketParams['sort']): 'downloads' | 'updated_at' {
  return sort === 'updated_at' || sort === 'created_at' ? 'updated_at' : 'downloads';
}

function parsePage(cursor: string | undefined): number {
  const page = cursor ? Number(cursor) : 1;
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

function pageSizeOf(limit: number | undefined): number {
  if (!Number.isSafeInteger(limit) || (limit ?? 0) < 1) return TENCENT_PAGE_SIZE;
  return Math.min(limit!, TENCENT_MAX_PAGE_SIZE);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Tencent catalog adapter. One instance per process holds the caches, the
 * slug → namespace memory and the search debounce state.
 */
export class TencentSkillhubCatalog {
  private readonly browseCache = new TtlCache<{ items: TencentSkillRecord[]; total: number }>(TENCENT_TTL.browse);
  private readonly searchCache = new TtlCache<TencentSkillRecord[]>(TENCENT_TTL.search, 50);
  private readonly securityCache = new TtlCache<boolean>(TENCENT_TTL.batchDetail, 5_000);
  private categoriesCache: { value: TencentCategory[]; expiresAt: number } | null = null;
  /** slug → 最近一次列表或搜索里排名最靠前的发布者 handle（方案 §5.5）。 */
  private readonly handles = new Map<string, string>();
  private searchGeneration = 0;
  private readonly searchInflight = new Map<string, Promise<TencentSkillRecord[]>>();
  private lastSnapshotWrite = 0;
  private servedSequence: { key: string; slugs: Set<string> } | null = null;
  private readonly deps: TencentCatalogDeps;

  constructor(deps: Partial<TencentCatalogDeps> = {}) {
    const http = deps.http ?? new TencentHttpClient();
    this.deps = {
      http,
      snapshots: new TencentSnapshotStore(),
      seed: loadTencentSeed,
      now: Date.now,
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      fetchCos: outboundFetch as FetchLike,
      ...deps,
    };
  }

  get http(): TencentHttpClient {
    return this.deps.http;
  }

  /** 已知的发布者 handle；没有记录时返回 undefined，调用方先取一次详情。 */
  knownHandle(slug: string): string | undefined {
    return this.handles.get(slug);
  }

  // ── 列表 / 搜索 ──────────────────────────────────────────────────────────

  async listMarket(params: ListMarketParams | undefined): Promise<TencentListResult> {
    const page = parsePage(params?.cursor);
    const pageSize = pageSizeOf(params?.limit);
    const category = params?.category?.trim() || undefined;
    if (category) {
      const categories = await this.loadCategories().catch(() => [] as TencentCategory[]);
      // 不在已知分类里的值不发给腾讯，也不能丢掉筛选后返回未过滤结果。
      if (!categories.some((item) => item.key === category)) {
        return { success: true, items: [], nextCursor: null };
      }
    }
    const rawQuery = params?.q ?? '';
    if (rawQuery.trim()) {
      return this.search(rawQuery, page, pageSize, category);
    }
    return this.browse(page, pageSize, tencentSortBy(params?.sort), category);
  }

  private async browse(
    page: number,
    pageSize: number,
    sortBy: 'downloads' | 'updated_at',
    category: string | undefined,
  ): Promise<TencentListResult> {
    const categoryNames = await this.categoryNames();
    try {
      const first = await this.fetchVisibleBrowsePage(page, pageSize, sortBy, category);
      let items = first.items;
      let lastPage = page;
      let total = first.total;
      // 过滤让页变短时补 1 页（上限 1 页，防请求放大）。补页后游标前移两页，所以两页的
      // 可见条目全部返回（可能略多于 pageSize），不能截断：截掉的条目之后再也取不到。
      if (items.length < pageSize && page * pageSize < total) {
        const second = await this.fetchVisibleBrowsePage(page + 1, pageSize, sortBy, category).catch((err) => {
          log.warn('browse refill failed', err instanceof Error ? err.message : String(err));
          return null;
        });
        if (second) {
          lastPage = page + 1;
          total = second.total;
          items = dedupeBySlug([...items, ...second.items]);
        }
      }
      // 翻页期间腾讯的排名会变（total 每天都在涨），同一条目可能出现在相邻两页。渲染层
      // 「加载更多」直接追加不去重，所以这里记住同一浏览序列已经给过的 slug。
      items = this.dropServed(JSON.stringify([pageSize, sortBy, category ?? '']), page, items);
      if (page === 1 && sortBy === 'downloads' && !category) {
        void this.maybeWriteSnapshot(items);
      }
      return {
        success: true,
        items: items.map((record) => this.toDesktop(record, categoryNames)),
        nextCursor: lastPage * pageSize < total ? String(lastPage + 1) : null,
      };
    } catch (err) {
      const fallback = page === 1 && !category ? await this.offlineFirstPage(sortBy) : null;
      if (fallback) {
        log.warn(`browse failed, serving ${fallback.source}`, err instanceof Error ? err.message : String(err));
        return {
          success: true,
          items: fallback.items.slice(0, pageSize).map((record) => this.toDesktop(record, categoryNames)),
          nextCursor: null,
        };
      }
      throw err;
    }
  }

  /**
   * 浏览序列内的跨页去重：第 1 页重置记录，之后的页丢掉已给过的 slug。
   * 只按序列键记最近一份，内存有界。
   */
  private dropServed(sequenceKey: string, page: number, items: TencentSkillRecord[]): TencentSkillRecord[] {
    if (page === 1 || this.servedSequence?.key !== sequenceKey) {
      this.servedSequence = { key: sequenceKey, slugs: new Set() };
    }
    const served = this.servedSequence.slugs;
    const fresh = items.filter((record) => !served.has(record.slug));
    for (const record of fresh) served.add(record.slug);
    return fresh;
  }

  private async fetchVisibleBrowsePage(
    page: number,
    pageSize: number,
    sortBy: 'downloads' | 'updated_at',
    category: string | undefined,
  ): Promise<{ items: TencentSkillRecord[]; total: number }> {
    const key = JSON.stringify([page, pageSize, sortBy, category ?? '']);
    const cached = this.browseCache.get(key);
    if (cached) return cached;
    const search = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sortBy,
      order: 'desc',
    });
    if (category) search.set('category', category);
    const body = await this.deps.http.requestJson<unknown>(`/api/skills?${search}`, { label: 'GET /api/skills' });
    const data = (body as { code?: unknown; data?: { skills?: unknown; total?: unknown } })?.data;
    if ((body as { code?: unknown })?.code !== 0 || !data || !Array.isArray(data.skills)) {
      throw new TencentSkillhubError('BAD_RESPONSE', 200);
    }
    const total = typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : 0;
    const records = dedupeBySlug(data.skills.flatMap((raw) => recordFromListItem(raw) ?? []));
    const visible = await this.filterVisible(records);
    const result = { items: visible, total };
    this.browseCache.set(key, result);
    return result;
  }

  private async search(
    rawQuery: string,
    page: number,
    pageSize: number,
    category: string | undefined,
  ): Promise<TencentListResult> {
    const query = sanitizeSearchQuery(rawQuery);
    if (!query) return { success: true, items: [], nextCursor: null };
    const categoryNames = await this.categoryNames();
    let results = this.searchCache.get(query);
    if (!results) {
      results = await this.debouncedSearch(query);
    }
    // 腾讯搜索不支持分类过滤，按条目的一级分类在本地过滤。
    const filtered = category ? results.filter((record) => record.category === category) : results;
    const offset = (page - 1) * pageSize;
    const slice = filtered.slice(offset, offset + pageSize);
    return {
      success: true,
      items: slice.map((record) => this.toDesktop(record, categoryNames)),
      nextCursor: offset + pageSize < filtered.length ? String(page + 1) : null,
    };
  }

  /** 尾部防抖 + 单飞：等待窗口内来了新查询，本次直接作废，不向腾讯发请求。 */
  private async debouncedSearch(query: string): Promise<TencentSkillRecord[]> {
    const inflight = this.searchInflight.get(query);
    if (inflight) return inflight;
    const generation = ++this.searchGeneration;
    await this.deps.delay(TENCENT_SEARCH_DEBOUNCE_MS);
    if (generation !== this.searchGeneration) {
      const settled = this.searchCache.get(query);
      if (settled) return settled;
      throw new TencentSkillhubError('SUPERSEDED');
    }
    const again = this.searchInflight.get(query);
    if (again) return again;
    const pending = this.fetchSearch(query).finally(() => this.searchInflight.delete(query));
    this.searchInflight.set(query, pending);
    return pending;
  }

  private async fetchSearch(query: string): Promise<TencentSkillRecord[]> {
    const run = async (q: string, bypassBackoff: boolean) => {
      const search = new URLSearchParams({ q, limit: String(TENCENT_SEARCH_LIMIT) });
      const body = await this.deps.http.requestJson<{ results?: unknown }>(`/api/v1/search?${search}`, {
        label: 'GET /api/v1/search',
        bypassBackoff,
      });
      if (!body || !Array.isArray(body.results)) throw new TencentSkillhubError('BAD_RESPONSE', 200);
      return dedupeBySlug(body.results.flatMap((raw) => recordFromSearchItem(raw) ?? []));
    };
    let records: TencentSkillRecord[];
    try {
      records = await run(query, false);
    } catch (err) {
      if (!(err instanceof TencentSkillhubError) || err.kind !== 'WAF_BLOCKED') throw err;
      // WAF 退化 ①：只保留白名单字符重试 1 次。
      const strict = strictSearchQuery(query);
      try {
        if (!strict || strict === query) throw err;
        records = await run(strict, true);
      } catch {
        // ② 仍失败：对缓存的首页浏览结果做本地子串过滤；③ 不再重试，交给退避。
        const local = await this.localSearchFallback(query);
        log.warn('search blocked by WAF, served local filter', { count: local.length });
        return local;
      }
    }
    const visible = await this.filterVisible(records);
    this.searchCache.set(query, visible);
    return visible;
  }

  private async localSearchFallback(query: string): Promise<TencentSkillRecord[]> {
    const firstPage = this.browseCache.get(JSON.stringify([1, TENCENT_PAGE_SIZE, 'downloads', '']))?.items
      ?? (await this.offlineFirstPage('downloads'))?.items
      ?? [];
    return firstPage.filter((record) => matchesQueryLocally(record, query));
  }

  /**
   * 默认过滤：付费条目直接隐藏；安全报告要靠批量详情，任一报告非 benign 或取不到
   * 报告都隐藏（fail closed）。批量详情失败时整页按不可信处理会让列表变空，所以
   * 失败时抛出，让上层走降级而不是返回空页。
   */
  private async filterVisible(records: TencentSkillRecord[]): Promise<TencentSkillRecord[]> {
    const free = records.filter((record) => !isPaidRecord(record));
    const unknown = free.filter((record) => this.securityCache.get(this.securityKey(record)) === undefined);
    for (const batch of chunk(unknown, TENCENT_BATCH_SIZE)) {
      const details = await this.fetchBatch(batch);
      for (const record of batch) {
        const detail = details.get(this.securityKey(record));
        this.securityCache.set(
          this.securityKey(record),
          detail !== undefined && isSecurityBenign(detail.security) && !detail.paid,
        );
      }
    }
    const visible = free.filter((record) => this.securityCache.get(this.securityKey(record)) === true);
    for (const record of visible) {
      if (!this.handles.has(record.slug)) this.handles.set(record.slug, record.handle);
    }
    return visible;
  }

  private securityKey(record: { handle: string; slug: string }): string {
    return `${record.handle}/${record.slug}`;
  }

  /** 批量详情，按 slug+namespace 请求，结果按 handle/slug 归档。 */
  private async fetchBatch(records: Array<{ slug: string; handle: string }>): Promise<Map<string, TencentSkillDetail>> {
    const out = new Map<string, TencentSkillDetail>();
    if (records.length === 0) return out;
    const body = await this.deps.http.requestJson<{ items?: unknown }>('/api/v1/skills/batch', {
      method: 'POST',
      body: { skills: records.map(({ slug, handle }) => ({ slug, namespace: handle })) },
      label: 'POST /api/v1/skills/batch',
    });
    if (!body || !Array.isArray(body.items)) throw new TencentSkillhubError('BAD_RESPONSE', 200);
    const handleBySlug = new Map(records.map((record) => [record.slug, record.handle]));
    for (const raw of body.items) {
      const slug = (raw as { skill?: { slug?: unknown } })?.skill?.slug;
      const detail = detailFromResponse(raw, typeof slug === 'string' ? handleBySlug.get(slug) : undefined);
      if (detail) out.set(this.securityKey(detail.record), detail);
    }
    return out;
  }

  // ── 详情 / 文件 / 同步 ───────────────────────────────────────────────────

  /**
   * 取详情。安装前复核必须 `fresh: true`（方案 §5.6）：不用列表阶段的缓存结果。
   * 没传 handle 时用最近一次列表或搜索记下的发布者；都没有就不带 namespace，由腾讯
   * 任选一个发布者，并把返回的 handle 记下来供后续下载使用。
   */
  async fetchDetail(slug: string, handle?: string): Promise<TencentSkillDetail | null> {
    if (!isValidTencentSlug(slug)) return null;
    const ns = handle ?? this.handles.get(slug);
    const qs = ns ? `?${new URLSearchParams({ namespace: ns })}` : '';
    try {
      const body = await this.deps.http.requestJson<unknown>(
        `/api/v1/skills/${encodeURIComponent(slug)}${qs}`,
        { label: 'GET /api/v1/skills/:slug' },
      );
      const detail = detailFromResponse(body, ns);
      if (!detail) throw new TencentSkillhubError('BAD_RESPONSE', 200);
      if (!this.handles.has(slug)) this.handles.set(slug, detail.record.handle);
      return detail;
    } catch (err) {
      if (err instanceof TencentSkillhubError && err.kind === 'NOT_FOUND') return null;
      throw err;
    }
  }

  async info(name: string) {
    const detail = await this.fetchDetail(name);
    if (!detail || !isSecurityBenign(detail.security) || detail.paid) {
      // 隐藏的条目对渲染层表现为已下架，与列表过滤口径一致。
      return { success: true as const, deleted: true as const };
    }
    const categoryNames = await this.categoryNames();
    return { success: true as const, info: this.toDesktop(detail.record, categoryNames) };
  }

  async getPublishedFiles({ name, version, includeHashes }: { name: string; version?: string; includeHashes?: boolean }) {
    const ns = await this.resolveHandle(name);
    const search = new URLSearchParams();
    if (version) search.set('version', version);
    search.set('namespace', ns);
    const body = await this.deps.http.requestJson<{ files?: unknown; version?: unknown }>(
      `/api/v1/skills/${encodeURIComponent(name)}/files?${search}`,
      { label: 'GET /api/v1/skills/:slug/files' },
    );
    if (!body || !Array.isArray(body.files)) throw new TencentSkillhubError('BAD_RESPONSE', 200);
    const files = body.files.flatMap((raw) => {
      const file = raw as { path?: unknown; size?: unknown; sha256?: unknown };
      if (typeof file.path !== 'string' || !file.path || typeof file.size !== 'number') return [];
      return [{
        path: file.path,
        size: file.size,
        language: languageOf(file.path),
        truncated: false,
        ...(includeHashes && typeof file.sha256 === 'string' ? { sha256: file.sha256 } : {}),
      }];
    });
    return {
      success: true as const,
      slug: name,
      version: typeof body.version === 'string' ? body.version : version ?? '',
      files,
    };
  }

  async readPublishedFile({ name, path: filePath, version }: { name: string; path: string; version?: string }) {
    const ns = await this.resolveHandle(name);
    const search = new URLSearchParams({ path: filePath, namespace: ns });
    if (version) search.set('version', version);
    const location = await this.deps.http.requestRedirect(
      `/api/v1/skills/${encodeURIComponent(name)}/file?${search}`,
      { label: 'GET /api/v1/skills/:slug/file' },
    );
    if (!isAllowedCosUrl(location, TENCENT_FILE_PATH_PREFIX)) throw new TencentSkillhubError('URL_POLICY');
    let response: Response;
    try {
      response = await this.deps.fetchCos(location, {
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(10_000),
        headers: { 'User-Agent': this.deps.http.userAgent() },
      });
    } catch {
      throw new TencentSkillhubError('NETWORK_ERROR');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new TencentSkillhubError(response.status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', response.status);
    }
    const { text, size, truncated } = await readTextCapped(response, TENCENT_MAX_PREVIEW_BYTES);
    return {
      success: true as const,
      file: { path: filePath, size, language: languageOf(filePath), truncated, content: text },
    };
  }

  /** 腾讯没有「版本审核」概念；返回空数组，渲染层按无审核记录处理。 */
  listPublishedVersions() {
    return { success: true as const, versions: [] as unknown[] };
  }

  /**
   * 本地已装技能的更新检测（方案 M2：sync 改走批量详情）。
   * 不知道发布者 handle 的 slug 先逐个取一次详情（腾讯任选发布者，与安装时一致）。
   */
  async syncDetails(slugs: string[]): Promise<Map<string, DesktopInfo>> {
    const out = new Map<string, DesktopInfo>();
    const valid = [...new Set(slugs.filter(isValidTencentSlug))];
    if (valid.length === 0) return out;
    const categoryNames = await this.categoryNames();
    const known = valid.filter((slug) => this.handles.has(slug));
    const unknown = valid.filter((slug) => !this.handles.has(slug));
    for (const batch of chunk(known, TENCENT_BATCH_SIZE)) {
      const details = await this.fetchBatch(batch.map((slug) => ({ slug, handle: this.handles.get(slug)! })));
      for (const detail of details.values()) {
        if (isSecurityBenign(detail.security) && !detail.paid) {
          out.set(detail.record.slug, this.toDesktop(detail.record, categoryNames));
        }
      }
    }
    for (const slug of unknown) {
      const detail = await this.fetchDetail(slug).catch(() => null);
      if (detail && isSecurityBenign(detail.security) && !detail.paid) {
        out.set(slug, this.toDesktop(detail.record, categoryNames));
      }
    }
    return out;
  }

  private async resolveHandle(slug: string): Promise<string> {
    if (!isValidTencentSlug(slug)) throw new TencentSkillhubError('NOT_FOUND', 404);
    const known = this.handles.get(slug);
    if (known) return known;
    const detail = await this.fetchDetail(slug);
    if (!detail) throw new TencentSkillhubError('NOT_FOUND', 404);
    return detail.record.handle;
  }

  // ── 分类 ────────────────────────────────────────────────────────────────

  async listCategories() {
    const categories = await this.loadCategories();
    return {
      success: true as const,
      categories: categories.map((item) => ({ slug: item.key, name: item.name, count: 0, myCount: 0 })),
      totalCount: 0,
      myTotalCount: 0,
    };
  }

  private async loadCategories(): Promise<TencentCategory[]> {
    const now = this.deps.now();
    if (this.categoriesCache && this.categoriesCache.expiresAt > now) return this.categoriesCache.value;
    try {
      const body = await this.deps.http.requestJson<unknown>('/api/v1/categories', { label: 'GET /api/v1/categories' });
      const value = categoriesFromResponse(body);
      if (value.length === 0) throw new TencentSkillhubError('BAD_RESPONSE', 200);
      this.categoriesCache = { value, expiresAt: now + TENCENT_TTL.categories };
      return value;
    } catch (err) {
      const fallback = this.categoriesCache?.value
        ?? (await this.deps.snapshots.read(TENCENT_TTL.snapshot, now))?.categories
        ?? this.deps.seed()?.categories;
      if (fallback && fallback.length > 0) return fallback;
      throw err;
    }
  }

  private async categoryNames(): Promise<Map<string, string>> {
    const categories = await this.loadCategories().catch(() => [] as TencentCategory[]);
    return new Map(categories.map((item) => [item.key, item.name]));
  }

  // ── 降级 ────────────────────────────────────────────────────────────────

  private async offlineFirstPage(
    sortBy: 'downloads' | 'updated_at',
  ): Promise<{ items: TencentSkillRecord[]; source: 'snapshot' | 'seed' } | null> {
    // 快照与种子都是下载量降序；「最近更新」排序下也用它们，好过整页空白。
    void sortBy;
    const snapshot = await this.deps.snapshots.read(TENCENT_TTL.snapshot, this.deps.now());
    if (snapshot && snapshot.items.length > 0) return { items: snapshot.items, source: 'snapshot' };
    const seed = this.deps.seed();
    if (seed && seed.items.length > 0) return { items: seed.items, source: 'seed' };
    return null;
  }

  private async maybeWriteSnapshot(items: TencentSkillRecord[]): Promise<void> {
    const now = this.deps.now();
    if (items.length === 0 || now - this.lastSnapshotWrite < TENCENT_SNAPSHOT_WRITE_INTERVAL_MS) return;
    this.lastSnapshotWrite = now;
    const categories = this.categoriesCache?.value ?? [];
    const snapshot: TencentHomeSnapshot = { savedAt: now, items, categories };
    await this.deps.snapshots.write(snapshot);
  }

  private toDesktop(record: TencentSkillRecord, categoryNames: ReadonlyMap<string, string>): DesktopInfo {
    return mapHubSkillInfoToDesktopInfo(toHubSkillInfo(record, categoryNames), { catalogScope: 'market' });
  }
}

function dedupeBySlug(records: TencentSkillRecord[]): TencentSkillRecord[] {
  // 同一页内同 slug 多个发布者时保留排名靠前的一条（方案 §5.5）。
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.slug)) return false;
    seen.add(record.slug);
    return true;
  });
}

function languageOf(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    md: 'markdown', py: 'python', js: 'javascript', mjs: 'javascript', ts: 'typescript',
    json: 'json', yaml: 'yaml', yml: 'yaml', sh: 'shell', txt: 'text', html: 'html', css: 'css',
  };
  return map[ext] ?? 'text';
}

async function readTextCapped(response: Response, maxBytes: number): Promise<{ text: string; size: number; truncated: boolean }> {
  const declared = Number(response.headers.get('content-length'));
  const reader = response.body?.getReader();
  if (!reader) return { text: '', size: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - received;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      received += remaining;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    received += value.byteLength;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
  return {
    text,
    size: Number.isSafeInteger(declared) && declared > 0 ? declared : received,
    truncated,
  };
}
