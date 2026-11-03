/**
 * 随包种子：打包时内置的下载量降序前 100 条（已按安全与付费规则过滤）与分类。
 *
 * 用于首次启动无网络、熔断打开、远程开关关闭时让「公开」不空白（方案 §7.2）。种子
 * 条目可浏览，安装仍需联网并经过安装前复核。每次发版用
 * `node scripts/generate-tencent-skillhub-seed.mjs` 重新生成 seed.json。
 *
 * JSON 经 Vite 静态 import 打进主进程 bundle（main 禁止运行时动态 import），
 * 首次调用时才解析并校验，坏数据按无种子处理。
 */
import seedJson from './seed.json';
import {
  categoriesFromResponse,
  recordFromListItem,
  type TencentCategory,
  type TencentSkillRecord,
} from './mapping';

export interface TencentSeed {
  generatedAt: string;
  items: TencentSkillRecord[];
  categories: TencentCategory[];
}

let parsed: TencentSeed | null | undefined;

/** 解析随包 JSON；字段走与线上响应相同的映射与校验。 */
export function parseTencentSeed(raw: unknown): TencentSeed | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { generatedAt?: unknown; skills?: unknown; categories?: unknown };
  if (!Array.isArray(value.skills)) return null;
  const items = value.skills.flatMap((item) => {
    const record = recordFromListItem(item);
    return record && !record.pricingType ? [record] : [];
  });
  return {
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    items,
    categories: categoriesFromResponse(value.categories),
  };
}

export function loadTencentSeed(): TencentSeed | null {
  if (parsed === undefined) parsed = parseTencentSeed(seedJson);
  return parsed;
}
