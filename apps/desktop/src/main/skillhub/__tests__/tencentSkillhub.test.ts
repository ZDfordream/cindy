/**
 * 腾讯 SkillHub 来源（HRBuddy「技能 → 公开」）的行为测试。
 *
 * 测试价值
 * - 生产入口与可观察结果：SkillhubMarketService.listMarket / info / sync 的分派与返回形状；
 *   TencentHttpClient 发出的请求头、退避与熔断；download.ts 的跳转白名单与 md5 校验；
 *   prepareTencentInstall 的安全/付费硬门禁。全部经内存 fetch 注入，断言发往第三方的
 *   请求与返回给渲染层的结果。
 * - 规则依据：docs 方案 hrbuddy-plugins-skills v0.3-lean §4（AC-02/05/06/07/21）、
 *   §5（AC-12/13/14/19）、§7.2（AC-16/17/18）；D-G 分派与 mine=true 例外。
 * - 现有覆盖缺口：marketService.test.ts 只锁 Cindy 原路径（tencent: null），腾讯来源是新代码。
 * - 最小失败输入：见各用例名。
 * - tier：unit（内存 fetch、mkdtemp 临时目录，不触网）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { afterAll, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => {
  // vi.mock 工厂会被提升到 import 之前；临时根目录必须同样提升，且用 require 取 node 模块。
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  return { TEST_ROOT: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'xdt-tencent-skillhub-test-')) };
});

vi.mock('electron', () => ({
  app: { getPath: () => TEST_ROOT, getVersion: () => '9.9.9' },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../clientEndpointsService', () => ({ getClientEndpoint: () => '' }));
vi.mock('../../maker-host/outbound-fetch', () => ({
  outboundFetch: () => Promise.reject(new Error('real network is not allowed in unit tests')),
}));
vi.mock('../../serverApiClient', () => {
  class ServerApiError extends Error {
    constructor(public readonly code: string, public readonly statusCode: number, message: string) {
      super(message);
    }
  }
  return { ServerApiError, serverApiFetch: vi.fn() };
});
vi.mock('../registry', () => ({ registryService: { updateCatalogScopeForSkill: vi.fn() } }));

import { SkillhubMarketService, skillhubIpcError } from '../marketService';
import { TencentSnapshotStore, TencentTrustStore } from '../tencent/cache';
import { TencentSkillhubCatalog } from '../tencent/catalog';
import { downloadTencentZip, etagMd5, TencentInstallCheckError } from '../tencent/download';
import { TencentSkillhubError } from '../tencent/errors';
import { TencentHttpClient, resolveTencentApiBaseUrl, type FetchLike } from '../tencent/http';
import { sanitizeSearchQuery } from '../tencent/mapping';
import { prepareTencentInstall } from '../tencent';
import { parseTencentSeed } from '../tencent/seed';

afterAll(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

// ── fixtures ────────────────────────────────────────────────────────────────

const COS = 'https://skillhub-1388575217.cos.accelerate.myqcloud.com';

function listItem(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    slug,
    name: `name-${slug}`,
    description: `desc ${slug}`,
    description_zh: `中文描述 ${slug}`,
    version: '1.0.0',
    downloads: 100,
    category: 'office-efficiency',
    subCategories: [{ key: 'office-doc', name: '文档' }],
    iconUrl: 'https://cloudcache.tencent-cloud.com/icon.png',
    namespace: { handle: `h-${slug}`, displayName: `owner-${slug}` },
    ownerName: `owner-${slug}`,
    updated_at: 1_793_626_195_619,
    labels: { requires_api_key: 'false' },
    upstream_url: null,
    ...overrides,
  };
}

function batchItem(slug: string, handle: string, status = 'benign', extra: Record<string, unknown> = {}) {
  return {
    latestVersion: { version: '1.0.0' },
    namespace: { handle, displayName: handle },
    securityReports: { keen: { status }, sanbu: { status: 'benign' } },
    skill: { slug, displayName: slug, summary_zh: slug, labels: {}, stats: { downloads: 1 } },
    ...extra,
  };
}

const CATEGORIES = {
  count: 3,
  items: [
    { key: 'pay-skill', name: 'Pay Skill', sortOrder: 0, active: true },
    { key: 'office-efficiency', name: '办公效率', sortOrder: 10, active: true },
    { key: 'professional', name: '行业专业', sortOrder: 100, active: true },
  ],
};

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** In-memory Tencent API. Records every request so tests assert what left the process. */
function fakeTencent(routes: Record<string, Route>) {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
    if (!route) throw new Error(`unexpected request ${url.pathname}`);
    return route(url, init);
  };
  return { fetch, calls };
}

function defaultRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    'GET /api/v1/categories': () => json(CATEGORIES),
    'POST /api/v1/skills/batch': (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { skills: Array<{ slug: string; namespace: string }> };
      return json({ count: body.skills.length, items: body.skills.map((s) => batchItem(s.slug, s.namespace)), missing: [] });
    },
    ...overrides,
  };
}

function makeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function makeCatalog(routes: Record<string, Route>, opts: { configuredBaseUrl?: string } = {}) {
  const api = fakeTencent(routes);
  const clock = makeClock();
  const http = new TencentHttpClient({
    fetch: api.fetch,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    random: () => 0.5,
    userAgent: () => 'HRBuddy/9.9.9',
    configuredBaseUrl: () => opts.configuredBaseUrl ?? '',
  });
  const snapshotFile = path.join(fs.mkdtempSync(path.join(TEST_ROOT, 'snap-')), 'home.json');
  const catalog = new TencentSkillhubCatalog({
    http,
    snapshots: new TencentSnapshotStore(() => snapshotFile),
    seed: () => null,
    now: clock.now,
    delay: async () => undefined,
    fetchCos: api.fetch,
  });
  return { catalog, http, api, clock, snapshotFile };
}

function cindyFetchSpy() {
  const paths: string[] = [];
  const fetch = (async (apiPath: string) => {
    paths.push(apiPath);
    return { items: [], total: 0 };
  }) as never;
  return { fetch, paths };
}

// ── 分派（D-G）────────────────────────────────────────────────────────────

describe('SkillhubMarketService source dispatch (D-G, AC-21)', () => {
  it.each([
    ['scope=market', { scope: 'market' as const }],
    ['scope=all', { scope: 'all' as const }],
    ['no scope', {}],
  ])('%s lists from Tencent and never calls Cindy Skill Hub', async (_label, params) => {
    const { catalog, api } = makeCatalog(defaultRoutes({
      'GET /api/skills': () => json({ code: 0, data: { skills: [listItem('alpha')], total: 1 }, message: 'ok' }),
    }));
    const cindy = cindyFetchSpy();
    const service = new SkillhubMarketService({ fetch: cindy.fetch, tencent: catalog });
    const result = await service.listMarket({ ...params, sort: 'trending' });
    expect(cindy.paths).toEqual([]);
    expect(api.calls.some((call) => call.url.pathname === '/api/skills')).toBe(true);
    expect(result.items).toEqual([
      expect.objectContaining({ name: 'alpha', catalogScope: 'market', authorId: 'h-alpha', visibility: 'PUBLIC' }),
    ]);
  });

  it.each([
    ['scope=team', { scope: 'team' as const }, '/api/skills-hub/skills?'],
    ['mine=true without scope', { mine: true }, '/api/skills-hub/users/published?'],
  ])('%s keeps the Cindy path and sends nothing to Tencent', async (_label, params, expectedPrefix) => {
    const { catalog, api } = makeCatalog(defaultRoutes());
    const cindy = cindyFetchSpy();
    const service = new SkillhubMarketService({ fetch: cindy.fetch, tencent: catalog });
    await service.listMarket(params);
    expect(api.calls).toEqual([]);
    expect(cindy.paths[0]).toContain(expectedPrefix);
  });
});

// ── 列表 / 排序 / 过滤 ─────────────────────────────────────────────────────

describe('Tencent browse (AC-02, AC-07, §4.5)', () => {
  it.each([
    ['trending', 'downloads'],
    ['downloads', 'downloads'],
    ['updated_at', 'updated_at'],
    ['created_at', 'updated_at'],
  ] as const)('maps sort=%s to sortBy=%s and never sends trending/created_at', async (sort, sortBy) => {
    const { catalog, api } = makeCatalog(defaultRoutes({
      'GET /api/skills': () => json({ code: 0, data: { skills: [], total: 0 } }),
    }));
    await catalog.listMarket({ sort });
    const list = api.calls.find((call) => call.url.pathname === '/api/skills')!;
    expect(list.url.searchParams.get('sortBy')).toBe(sortBy);
    expect(list.url.searchParams.get('order')).toBe('desc');
  });

  it('hides paid and non-benign skills and refills the page at most once', async () => {
    const page1 = [
      listItem('free-ok'),
      listItem('paid', { labels: { pricing_type: 'paid' } }),
      listItem('suspicious'),
    ];
    const page2 = [listItem('refill-ok')];
    const { catalog, api } = makeCatalog(defaultRoutes({
      'GET /api/skills': (url) => json({
        code: 0,
        data: { skills: url.searchParams.get('page') === '1' ? page1 : page2, total: 200 },
      }),
      'POST /api/v1/skills/batch': (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { skills: Array<{ slug: string; namespace: string }> };
        return json({
          items: body.skills.map((s) => batchItem(s.slug, s.namespace, s.slug === 'suspicious' ? 'suspicious' : 'benign')),
        });
      },
    }));
    const result = await catalog.listMarket({ limit: 3 });
    // 两页的可见条目全部返回；补页后游标已越过第 2 页，截断会让条目永久丢失。
    expect(result.items.map((item) => item.name)).toEqual(['free-ok', 'refill-ok']);
    expect(api.calls.filter((call) => call.url.pathname === '/api/skills')).toHaveLength(2);
    // 补页后游标跳过已经取过的第 2 页。
    expect(result.nextCursor).toBe('3');
  });

  it('does not repeat a skill on "load more" when the ranking shifts between pages (AC-03)', async () => {
    // 实测（2026-11-03 冒烟）：第 2 页里有 3 条与第 1 页重复；渲染层直接追加不去重。
    const { catalog } = makeCatalog(defaultRoutes({
      'GET /api/skills': (url) => json({
        code: 0,
        data: {
          skills: url.searchParams.get('page') === '1'
            ? [listItem('a'), listItem('b')]
            : [listItem('b'), listItem('c')],
          total: 10,
        },
      }),
    }));
    const first = await catalog.listMarket({ limit: 2 });
    const second = await catalog.listMarket({ limit: 2, cursor: first.nextCursor! });
    expect(first.items.map((item) => item.name)).toEqual(['a', 'b']);
    expect(second.items.map((item) => item.name)).toEqual(['c']);
  });

  it('sends only known English category keys and returns empty for unknown ones', async () => {
    const { catalog, api } = makeCatalog(defaultRoutes({
      'GET /api/skills': () => json({ code: 0, data: { skills: [listItem('a')], total: 1 } }),
    }));
    await catalog.listMarket({ category: 'office-efficiency' });
    expect(api.calls.find((call) => call.url.pathname === '/api/skills')!.url.searchParams.get('category'))
      .toBe('office-efficiency');
    api.calls.length = 0;
    expect(await catalog.listMarket({ category: '办公效率' })).toEqual({ success: true, items: [], nextCursor: null });
    expect(await catalog.listMarket({ category: 'pay-skill' })).toEqual({ success: true, items: [], nextCursor: null });
    expect(api.calls.some((call) => call.url.pathname === '/api/skills')).toBe(false);
  });

  it('exposes categories without pay-skill, sorted by sortOrder', async () => {
    const { catalog } = makeCatalog(defaultRoutes());
    const result = await catalog.listCategories();
    expect(result.categories.map((item) => item.slug)).toEqual(['office-efficiency', 'professional']);
  });

  it('serves the disk snapshot when the network is down (AC-08)', async () => {
    let online = true;
    const { catalog, clock } = makeCatalog(defaultRoutes({
      'GET /api/skills': () => {
        if (!online) throw new TypeError('fetch failed');
        return json({ code: 0, data: { skills: [listItem('cached-one')], total: 1 } });
      },
    }));
    await catalog.listMarket({ sort: 'trending' });
    await vi.waitFor(async () => expect(await new TencentSnapshotStore(() => '').read(0)).toBeNull());
    online = false;
    clock.advance(11 * 60_000); // 内存缓存过期
    const offline = await catalog.listMarket({ sort: 'trending' });
    expect(offline.items.map((item) => item.name)).toEqual(['cached-one']);
    expect(offline.nextCursor).toBeNull();
  });
});

// ── 搜索 ──────────────────────────────────────────────────────────────────

describe('Tencent search (AC-05, AC-06)', () => {
  it('debounces keystrokes: only the last query reaches Tencent', async () => {
    const searches: string[] = [];
    const api = fakeTencent(defaultRoutes({
      'GET /api/v1/search': (url) => {
        searches.push(url.searchParams.get('q')!);
        return json({ results: [listItem('jianli', { displayName: '简历助手' })] });
      },
    }));
    const clock = makeClock();
    const http = new TencentHttpClient({
      fetch: api.fetch, now: clock.now, sleep: async () => undefined, random: () => 0.5,
      userAgent: () => 'HRBuddy/9.9.9', configuredBaseUrl: () => '',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const catalog = new TencentSkillhubCatalog({
      http, snapshots: new TencentSnapshotStore(() => path.join(TEST_ROOT, 'none.json')),
      seed: () => null, now: clock.now, delay: () => gate, fetchCos: api.fetch,
    });
    const typed = ['简', '简历', '简历模', '简历模板', '简历模板x', '简历模板xy'];
    const pending = typed.map((q) => catalog.listMarket({ q }).catch((err: unknown) => err));
    release();
    const results = await Promise.all(pending);
    expect(searches).toEqual(['简历模板xy']);
    expect(results.at(-1)).toMatchObject({ success: true });
    expect(results.slice(0, -1).every((r) => r instanceof TencentSkillhubError && r.kind === 'SUPERSEDED')).toBe(true);
  });

  it('strips script characters before sending and skips empty queries', async () => {
    expect(sanitizeSearchQuery(`<script>'";`)).toBe('script');
    expect(sanitizeSearchQuery('  <>  ')).toBe('');
    const { catalog, api } = makeCatalog(defaultRoutes());
    expect(await catalog.listMarket({ q: `<>'";` })).toEqual({ success: true, items: [], nextCursor: null });
    expect(api.calls).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ url: expect.objectContaining({ pathname: '/api/v1/search' }) }),
    ]));
  });

  it('retries once with a strict charset after a 566 WAF page, then falls back locally', async () => {
    const searches: string[] = [];
    const { catalog } = makeCatalog(defaultRoutes({
      'GET /api/skills': () => json({ code: 0, data: { skills: [listItem('resume-kit', { name: '简历工具 resume' })], total: 1 } }),
      'GET /api/v1/search': (url) => {
        searches.push(url.searchParams.get('q')!);
        return new Response('<html>blocked</html>', { status: 566, headers: { 'content-type': 'text/html' } });
      },
    }));
    await catalog.listMarket({ sort: 'trending' }); // 预热首页缓存，供本地子串过滤
    const result = await catalog.listMarket({ q: 'resume/kit' });
    expect(searches).toEqual(['resume/kit', 'resume kit']);
    expect(result.items).toEqual([]); // 本地字面匹配 'resume/kit' 无命中，返回空而不是报错
  });

  it('pages search results 24 at a time from one cached request', async () => {
    const many = Array.from({ length: 30 }, (_, i) => listItem(`s-${i}`, { displayName: `简历 ${i}` }));
    const { catalog, api } = makeCatalog(defaultRoutes({
      'GET /api/v1/search': () => json({ results: many }),
    }));
    const first = await catalog.listMarket({ q: '简历' });
    const second = await catalog.listMarket({ q: '简历', cursor: first.nextCursor! });
    expect(first.items).toHaveLength(24);
    expect(second.items).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(api.calls.filter((call) => call.url.pathname === '/api/v1/search')).toHaveLength(1);
  });
});

// ── HTTP 客户端 ────────────────────────────────────────────────────────────

describe('TencentHttpClient (AC-16, AC-17, AC-18)', () => {
  it('sends the honest UA and never an Authorization header or cookies', async () => {
    const { catalog, api } = makeCatalog(defaultRoutes({
      'GET /api/skills': () => json({ code: 0, data: { skills: [listItem('a')], total: 1 } }),
    }));
    await catalog.listMarket({});
    expect(api.calls.length).toBeGreaterThan(0);
    for (const { init } of api.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBe('HRBuddy/9.9.9');
      expect(headers.has('authorization')).toBe(false);
      expect(init?.credentials).toBe('omit');
    }
  });

  it('opens the circuit after 5 consecutive 5xx and lets one probe through after 5 minutes', async () => {
    let status = 503;
    let requests = 0;
    const api = fakeTencent({ 'GET /api/v1/categories': () => { requests += 1; return json({}, status); } });
    const clock = makeClock();
    const http = new TencentHttpClient({
      fetch: api.fetch, now: clock.now, sleep: async (ms) => clock.advance(ms), random: () => 0.5,
      userAgent: () => 'HRBuddy/9.9.9', configuredBaseUrl: () => '',
    });
    const call = () => http.requestJson('/api/v1/categories', { label: 't' }).catch((err: TencentSkillhubError) => err.kind);
    for (let i = 0; i < 5; i += 1) {
      expect(await call()).toBe('INTERNAL_ERROR');
      clock.advance(61_000); // 跳过退避
    }
    expect(await call()).toBe('CIRCUIT_OPEN');
    expect(requests).toBe(5);
    clock.advance(5 * 60_000);
    status = 200;
    await expect(http.requestJson('/api/v1/categories', { label: 't' })).resolves.toEqual({});
    expect(requests).toBe(6);
    expect(http.isCircuitOpen()).toBe(false);
  });

  it('treats a configured base URL outside the API allowlist as the remote kill switch', async () => {
    expect(resolveTencentApiBaseUrl('')).toBe('https://api.skillhub.cn');
    expect(resolveTencentApiBaseUrl('https://api.skillhub.cn/')).toBe('https://api.skillhub.cn');
    expect(resolveTencentApiBaseUrl('https://skillhub-off.cindy.com.cn')).toBeNull();
    const { catalog, api } = makeCatalog(defaultRoutes(), { configuredBaseUrl: 'https://skillhub-off.cindy.com.cn' });
    await expect(catalog.listMarket({})).rejects.toMatchObject({ kind: 'DISABLED' });
    expect(api.calls).toEqual([]);
  });

  it('surfaces a readable reason and errorCode instead of "请求失败 (0)" (D-A)', async () => {
    const { catalog } = makeCatalog({
      'GET /api/v1/categories': () => { throw new TypeError('getaddrinfo ENOTFOUND'); },
      'GET /api/skills': () => { throw new TypeError('getaddrinfo ENOTFOUND'); },
    });
    const service = new SkillhubMarketService({ fetch: cindyFetchSpy().fetch, tencent: catalog });
    const err = await service.listMarket({ scope: 'market' }).catch((e: unknown) => e);
    expect(skillhubIpcError(err)).toEqual({
      success: false,
      error: '无法连接腾讯 SkillHub，请检查网络后重试',
      errorCode: 'NETWORK_ERROR',
    });
  });
});

// ── 详情 / 多发布者 ────────────────────────────────────────────────────────

describe('Tencent detail and namespaces (AC-19)', () => {
  it('remembers the clicked publisher and sends namespace on detail', async () => {
    const { catalog, api } = makeCatalog(defaultRoutes({
      'GET /api/skills': () => json({
        code: 0,
        data: { skills: [listItem('resume-optimizer', { namespace: { handle: 'clawhub_tomstools11' } })], total: 1 },
      }),
      'GET /api/v1/skills/resume-optimizer': (url) => json(batchItem('resume-optimizer', url.searchParams.get('namespace') ?? 'random')),
    }));
    await catalog.listMarket({});
    const info = await catalog.info('resume-optimizer');
    const detail = api.calls.find((call) => call.url.pathname === '/api/v1/skills/resume-optimizer')!;
    expect(detail.url.searchParams.get('namespace')).toBe('clawhub_tomstools11');
    expect(info).toMatchObject({ success: true, info: { authorId: 'clawhub_tomstools11', catalogScope: 'market' } });
  });

  it('reports hidden (paid or non-benign) skills as deleted on info', async () => {
    const { catalog } = makeCatalog(defaultRoutes({
      'GET /api/v1/skills/risky': () => json(batchItem('risky', 'h', 'malicious')),
    }));
    expect(await catalog.info('risky')).toEqual({ success: true, deleted: true });
  });
});

// ── 下载与校验 ─────────────────────────────────────────────────────────────

async function zipOf(files: Record<string, string>): Promise<Uint8Array<ArrayBuffer>> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
}

function md5(buf: Uint8Array) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

describe('downloadTencentZip (AC-12, AC-13)', () => {
  async function run(location: string, cos: (url: URL) => Response) {
    const api = fakeTencent({ 'GET /api/v1/download': () => new Response(null, { status: 302, headers: { location } }) });
    const cosFetch: FetchLike = async (input) => cos(new URL(input));
    const http = new TencentHttpClient({
      fetch: api.fetch, now: () => 0, sleep: async () => undefined, random: () => 0.5,
      userAgent: () => 'HRBuddy/9.9.9', configuredBaseUrl: () => '',
    });
    return downloadTencentZip(
      http,
      { slug: 'demo', version: '1.0.0', handle: 'h-demo', signal: new AbortController().signal },
      cosFetch,
    );
  }

  it('accepts a COS /skills/ URL whose md5 matches the ETag', async () => {
    const zip = await zipOf({ 'SKILL.md': '# demo' });
    const result = await run(`${COS}/skills/1/demo/1.0.0.zip`, () => new Response(zip, {
      headers: { etag: `"${md5(zip)}"`, 'content-length': String(zip.byteLength) },
    }));
    expect(result.md5).toBe(md5(zip));
    expect(Buffer.from(result.bytes).equals(Buffer.from(zip))).toBe(true);
  });

  it.each([
    ['another host', 'https://evil.example.com/skills/x.zip'],
    ['plain http', `http://skillhub-1388575217.cos.accelerate.myqcloud.com/skills/x.zip`],
    ['credentials', `https://u:p@skillhub-1388575217.cos.accelerate.myqcloud.com/skills/x.zip`],
    ['wrong prefix on the allowed host', `${COS}/skill-icons/x.zip`],
  ])('rejects a redirect to %s without contacting it', async (_label, location) => {
    const cos = vi.fn(() => new Response('should not be fetched'));
    await expect(run(location, cos)).rejects.toMatchObject({ kind: 'URL_POLICY' });
    expect(cos).not.toHaveBeenCalled();
  });

  it('rejects when the body md5 differs from the ETag', async () => {
    const zip = await zipOf({ 'SKILL.md': '# demo' });
    await expect(run(`${COS}/skills/1/demo.zip`, () => new Response(zip, {
      headers: { etag: '"00000000000000000000000000000000"' },
    }))).rejects.toMatchObject({ installCode: 'CHECKSUM_MISMATCH' });
  });

  it('rejects a declared size above 200 MB before reading the body', async () => {
    const err = await run(`${COS}/skills/1/demo.zip`, () => new Response('x', {
      headers: { etag: `"${'a'.repeat(32)}"`, 'content-length': String(201 * 1024 * 1024) },
    })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TencentInstallCheckError);
    expect((err as TencentInstallCheckError).installCode).toBe('DOWNLOAD_FAILED');
  });

  it('parses only plain 32-hex ETags as md5', () => {
    expect(etagMd5('"29726B70BEBEA7E199C3F0BE1A72AB09"')).toBe('29726b70bebea7e199c3f0be1a72ab09');
    expect(etagMd5('"abc-3"')).toBeNull();
  });
});

describe('prepareTencentInstall hard gate (AC-14, §5.6)', () => {
  async function prepare(detail: unknown, zipFiles: Record<string, string> = { 'SKILL.md': '# demo' }) {
    const zip = await zipOf(zipFiles);
    const cos = vi.fn(async () => new Response(zip, { headers: { etag: `"${md5(zip)}"` } }));
    const { catalog, api } = makeCatalog({
      'GET /api/v1/skills/demo': () => json(detail),
      'GET /api/v1/download': () => new Response(null, { status: 302, headers: { location: `${COS}/skills/1/demo.zip` } }),
      'GET /api/v1/open/skills/demo/versions/1.0.0/signature': () => json({ signed: false }),
    });
    const trust = new TencentTrustStore(() => path.join(fs.mkdtempSync(path.join(TEST_ROOT, 'gate-')), 't.json'));
    const result = await prepareTencentInstall('demo', '0.9.0', new AbortController().signal, { catalog, trust, fetchCos: cos })
      .catch((err: unknown) => err);
    return { result, cos, api };
  }

  it.each([
    ['a non-benign keen report', batchItem('demo', 'h', 'suspicious'), 'SECURITY_NOT_BENIGN'],
    ['a missing sanbu report', { ...batchItem('demo', 'h'), securityReports: { keen: { status: 'benign' } } }, 'SECURITY_NOT_BENIGN'],
    ['labels.pricing_type', batchItem('demo', 'h', 'benign', { skill: { slug: 'demo', labels: { pricing_type: 'paid' } } }), 'PAID_SKILL'],
    ['a top-level pricing object', batchItem('demo', 'h', 'benign', { pricing: { billingType: 'per_call' } }), 'PAID_SKILL'],
  ])('refuses %s before downloading anything', async (_label, detail, code) => {
    const { result, cos, api } = await prepare(detail);
    expect(result).toMatchObject({ installCode: code });
    expect(cos).not.toHaveBeenCalled();
    expect(api.calls.some((call) => call.url.pathname === '/api/v1/download')).toBe(false);
  });

  it('installs the platform version with the detail namespace, not the stale list version', async () => {
    const { result, api } = await prepare(batchItem('demo', 'kunlungrowth'));
    expect(result).toMatchObject({ version: '1.0.0', handle: 'kunlungrowth' });
    const download = api.calls.find((call) => call.url.pathname === '/api/v1/download')!;
    expect(Object.fromEntries(download.url.searchParams)).toEqual({ slug: 'demo', version: '1.0.0', namespace: 'kunlungrowth' });
  });

  it('rejects a package without SKILL.md at the zip root', async () => {
    const { result } = await prepare(batchItem('demo', 'h'), { 'wrapped/SKILL.md': '# demo' });
    expect(result).toMatchObject({ installCode: 'DOWNLOAD_FAILED' });
  });
});

describe('TencentTrustStore (TOFU)', () => {
  it('records the first sha256 and rejects a different one for the same version', async () => {
    const file = path.join(fs.mkdtempSync(path.join(TEST_ROOT, 'trust-')), 'trust.json');
    const trust = new TencentTrustStore(() => file);
    const key = TencentTrustStore.key('h', 'demo', '1.0.0');
    expect(await trust.verifyOrRecord(key, 'a'.repeat(64))).toBe('recorded');
    expect(await trust.verifyOrRecord(key, 'a'.repeat(64))).toBe('match');
    expect(await trust.verifyOrRecord(key, 'b'.repeat(64))).toBe('mismatch');
  });

  it('refuses to overwrite a corrupted trust table', async () => {
    const file = path.join(fs.mkdtempSync(path.join(TEST_ROOT, 'trust-')), 'trust.json');
    fs.writeFileSync(file, '{not json');
    await expect(new TencentTrustStore(() => file).verifyOrRecord('k', 'a'.repeat(64))).rejects.toThrow(/信任表/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
  });
});

describe('bundled seed', () => {
  it('drops paid and malformed entries through the same mapping as live data', () => {
    const seed = parseTencentSeed({
      generatedAt: '2026-11-03T00:00:00Z',
      skills: [listItem('ok'), listItem('paid', { labels: { pricing_type: 'alipay' } }), { slug: 'Bad Slug' }],
      categories: CATEGORIES,
    });
    expect(seed?.items.map((item) => item.slug)).toEqual(['ok']);
    expect(seed?.categories.map((item) => item.key)).toEqual(['office-efficiency', 'professional']);
  });
});
