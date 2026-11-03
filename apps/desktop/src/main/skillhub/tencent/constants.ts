/**
 * 腾讯 SkillHub 来源的安全常量与上限。
 *
 * 这些主机名与路径前缀是信任锚点（性质同证书固定），不是可远程改的业务端点：
 * 端点清单里的 `tencentSkillhubApiBaseUrl` 只能在这里列出的 API 主机之间选择，
 * 写成别的值等于关闭来源（远程熔断开关），见 resolveTencentApiBaseUrl。
 *
 * 接口没有公开文档，全部来自抓包与站点前端 JS 逆向（方案文档 §3.1）。
 */

/** 端点清单缺省或留空时使用的内置 API 基址（用户裁定：缺省即开启）。 */
export const TENCENT_SKILLHUB_DEFAULT_API_BASE_URL = 'https://api.skillhub.cn';

/** 允许作为 API 基址的主机。 */
export const TENCENT_API_HOSTS: ReadonlySet<string> = new Set(['api.skillhub.cn']);

/** COS 对象存储：zip 包、单文件与部分图标都在这台主机上，按路径前缀区分用途。 */
export const TENCENT_COS_HOST = 'skillhub-1388575217.cos.accelerate.myqcloud.com';

/** 下载重定向的目标白名单：只允许 COS 主机上的 /skills/ 前缀。 */
export const TENCENT_DOWNLOAD_PATH_PREFIX = '/skills/';
/** 单文件预览重定向的目标白名单：COS 主机上的 /orgs/ 前缀。 */
export const TENCENT_FILE_PATH_PREFIX = '/orgs/';

/** 图标白名单：主机 → 允许的路径前缀（空串表示整台主机只用于图标）。 */
export const TENCENT_ICON_HOSTS: ReadonlyMap<string, string> = new Map([
  ['cloudcache.tencent-cloud.com', ''],
  [TENCENT_COS_HOST, '/skill-icons/'],
]);

/** 与 installService 的市场安装上限一致（方案 §5.4）。 */
export const TENCENT_MAX_ZIP_BYTES = 200 * 1024 * 1024;
/** 单文件预览读取上限；超出只返回前段并标记 truncated。 */
export const TENCENT_MAX_PREVIEW_BYTES = 512 * 1024;
/** API 重定向最多跟随的跳数（API → COS 只需 1 跳，留 1 跳余量）。 */
export const TENCENT_MAX_REDIRECT_HOPS = 2;

/** 列表、搜索与默认页大小（与渲染层 MARKET_PAGE_SIZE 一致）。 */
export const TENCENT_PAGE_SIZE = 24;
/** 腾讯列表 pageSize 上限。 */
export const TENCENT_MAX_PAGE_SIZE = 100;
/** 搜索一次取回的条数（腾讯搜索无分页，上限 100）。 */
export const TENCENT_SEARCH_LIMIT = 100;
/** 每批详情请求的 slug 数（47 个实测成功，取 40 留余量）。 */
export const TENCENT_BATCH_SIZE = 40;
/** 搜索词清洗后的长度上限（腾讯上限未验证）。 */
export const TENCENT_MAX_QUERY_LENGTH = 64;

/** 单次 HTTP 请求超时。 */
export const TENCENT_REQUEST_TIMEOUT_MS = 10_000;
/** 下载 zip 的总时长上限（含 COS 传输）。 */
export const TENCENT_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** 搜索尾部防抖：渲染层没有防抖，每个按键都会到主进程。 */
export const TENCENT_SEARCH_DEBOUNCE_MS = 400;

/** 缓存 TTL（方案 §7.2，建议值）。 */
export const TENCENT_TTL = {
  browse: 10 * 60_000,
  search: 5 * 60_000,
  categories: 24 * 60 * 60_000,
  batchDetail: 60 * 60_000,
  snapshot: 7 * 24 * 60 * 60_000,
} as const;

/** 首页磁盘快照的最短写入间隔，避免每次浏览都写盘。 */
export const TENCENT_SNAPSHOT_WRITE_INTERVAL_MS = 10 * 60_000;

/** 退避、限速与熔断参数（方案 §7.2，建议值）。 */
export const TENCENT_BACKOFF = {
  baseMs: 1_000,
  maxMs: 60_000,
  jitter: 0.2,
} as const;
export const TENCENT_RATE_LIMIT = {
  /** 令牌桶容量（突发）。 */
  burst: 3,
  /** 每个令牌的补充间隔，即全局最小请求间隔。 */
  intervalMs: 1_000,
} as const;
export const TENCENT_CIRCUIT = {
  failureThreshold: 5,
  openMs: 5 * 60_000,
} as const;

/**
 * 平台签名公钥，随客户端内置并固定（2026-11-02 取自 /api/v1/open/platform/keys）。
 * 只在线取公钥等于信任同一个服务，所以不在运行时下载。按 key_id 支持轮换。
 */
export const TENCENT_PLATFORM_KEYS: ReadonlyMap<string, string> = new Map([
  ['skillhub-platform-v1', 'Wrh8O72FAuN+qwuYh6l7+c1yKPAHjdUNNij+nb9c9Ok='],
]);

/** content_hash 复算时排除的包内文件（只在 1 个样本上确认过 _meta.json）。 */
export const TENCENT_CONTENT_HASH_EXCLUDED = new Set(['_meta.json']);

/** 与 marketService 相同的 slug 规则；不匹配的条目丢弃，安装入口也用它校验。 */
export const TENCENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
/** namespace handle 的保守格式（样本形如 indiv-skill、user_e9185b15、clawhub_x11）。 */
export const TENCENT_HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** 分类里随「默认隐藏付费」一并不展示的 key。 */
export const TENCENT_HIDDEN_CATEGORY_KEYS: ReadonlySet<string> = new Set(['pay-skill']);
