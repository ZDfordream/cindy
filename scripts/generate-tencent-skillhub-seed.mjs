#!/usr/bin/env node
/**
 * 生成 HRBuddy「技能 → 公开」的随包种子，并可作为腾讯 SkillHub 契约探活使用。
 *
 *   node scripts/generate-tencent-skillhub-seed.mjs          # 生成 seed.json
 *   node scripts/generate-tencent-skillhub-seed.mjs --probe  # 只做契约探活，不写文件
 *
 * 种子：下载量降序前 100 条，经批量详情过滤（keen、sanbu 都是 benign，且不带
 * labels.pricing_type），外加一级分类。写到
 * apps/desktop/src/main/skillhub/tencent/seed.json，每次发版重新生成（方案 §7.2）。
 *
 * 探活：对列表、搜索、分类、详情、批量详情、下载入口各发 1 次请求，检查状态码与
 * 必需键，不下载 zip。用于发布前或 CI 每日 1 次；不要在用户机器上定时跑。
 *
 * 所有请求带诚实 UA，不带 Cookie 与 Authorization；请求之间间隔 1 秒。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED_PATH = path.join(REPO_ROOT, 'apps/desktop/src/main/skillhub/tencent/seed.json');
const BASE = 'https://api.skillhub.cn';
const UA = 'HRBuddy/seed-generator';
const SEED_SIZE = 100;
const BATCH = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(pathname, init = {}) {
  await sleep(1_000);
  const response = await fetch(`${BASE}${pathname}`, {
    redirect: 'manual',
    ...init,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  return response;
}

async function json(pathname, init) {
  const response = await request(pathname, init);
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.includes('application/json')) {
    throw new Error(`${pathname.split('?')[0]} → HTTP ${response.status} ${type}`);
  }
  return response.json();
}

function assertKeys(label, value, keys) {
  const missing = keys.filter((key) => value?.[key] === undefined);
  if (missing.length) throw new Error(`${label} 缺少必需键：${missing.join(', ')}`);
}

async function listTop() {
  const body = await json(`/api/skills?page=1&pageSize=${SEED_SIZE}&sortBy=downloads&order=desc`);
  if (body.code !== 0 || !Array.isArray(body.data?.skills)) throw new Error('列表响应结构变了');
  return body.data.skills;
}

async function batchDetails(skills) {
  const verdicts = new Map();
  for (let i = 0; i < skills.length; i += BATCH) {
    const slice = skills.slice(i, i + BATCH);
    const body = await json('/api/v1/skills/batch', {
      method: 'POST',
      body: JSON.stringify({ skills: slice.map((s) => ({ slug: s.slug, namespace: s.namespace?.handle })) }),
    });
    if (!Array.isArray(body.items)) throw new Error('批量详情响应结构变了');
    for (const item of body.items) {
      const handle = item.namespace?.handle;
      const slug = item.skill?.slug;
      const reports = item.securityReports ?? {};
      const benign = reports.keen?.status === 'benign' && reports.sanbu?.status === 'benign';
      const paid = Boolean(item.skill?.labels?.pricing_type) || (item.pricing !== undefined && item.pricing !== null);
      if (handle && slug) verdicts.set(`${handle}/${slug}`, benign && !paid);
    }
  }
  return verdicts;
}

/** 只保留 seed.ts 需要的字段，控制随包体积。 */
function slim(skill) {
  const keep = [
    'slug', 'name', 'description', 'description_zh', 'version', 'downloads', 'category',
    'subCategories', 'iconUrl', 'ownerName', 'updated_at', 'created_at', 'labels', 'upstream_url',
  ];
  const out = Object.fromEntries(keep.filter((key) => skill[key] !== undefined).map((key) => [key, skill[key]]));
  out.namespace = { handle: skill.namespace?.handle, displayName: skill.namespace?.displayName };
  if (skill.publisher?.name) out.publisher = { name: skill.publisher.name };
  return out;
}

async function generate() {
  const skills = await listTop();
  const verdicts = await batchDetails(skills);
  const visible = skills.filter((skill) =>
    !skill.labels?.pricing_type && verdicts.get(`${skill.namespace?.handle}/${skill.slug}`) === true);
  const categories = await json('/api/v1/categories');
  if (!Array.isArray(categories.items)) throw new Error('分类响应结构变了');
  const seed = {
    _note: '由 scripts/generate-tencent-skillhub-seed.mjs 生成，手改会在下次发版时被覆盖。',
    generatedAt: new Date().toISOString(),
    skills: visible.map(slim),
    categories: { items: categories.items },
  };
  fs.writeFileSync(SEED_PATH, `${JSON.stringify(seed, null, 1)}\n`);
  console.log(`seed.json: ${seed.skills.length}/${skills.length} 条通过过滤，${categories.items.length} 个分类`);
}

async function probe() {
  const results = [];
  const step = async (label, fn) => {
    try {
      await fn();
      results.push(`ok   ${label}`);
    } catch (err) {
      results.push(`FAIL ${label}: ${err.message}`);
    }
  };
  let sample;
  await step('list', async () => {
    const body = await json('/api/skills?page=1&pageSize=5&sortBy=downloads&order=desc');
    assertKeys('list', body.data, ['skills', 'total']);
    sample = body.data.skills[0];
    assertKeys('list item', sample, ['slug', 'version', 'namespace', 'downloads']);
  });
  await step('search', async () => {
    const body = await json(`/api/v1/search?q=${encodeURIComponent('简历')}&limit=5`);
    assertKeys('search', body, ['results']);
  });
  await step('categories', async () => {
    const body = await json('/api/v1/categories');
    assertKeys('categories', body, ['items']);
  });
  if (sample) {
    const ns = encodeURIComponent(sample.namespace.handle);
    await step('detail', async () => {
      const body = await json(`/api/v1/skills/${sample.slug}?namespace=${ns}`);
      assertKeys('detail', body, ['latestVersion', 'securityReports', 'skill']);
    });
    await step('batch', async () => {
      const body = await json('/api/v1/skills/batch', {
        method: 'POST',
        body: JSON.stringify({ skills: [{ slug: sample.slug, namespace: sample.namespace.handle }] }),
      });
      assertKeys('batch', body, ['items']);
    });
    await step('download entry (302, zip not fetched)', async () => {
      const response = await request(
        `/api/v1/download?slug=${sample.slug}&version=${encodeURIComponent(sample.version)}&namespace=${ns}`,
      );
      await response.body?.cancel();
      const location = response.headers.get('location') ?? '';
      if (response.status !== 302 || !location.startsWith('https://skillhub-1388575217.cos.accelerate.myqcloud.com/skills/')) {
        throw new Error(`HTTP ${response.status} location=${location.slice(0, 80)}`);
      }
    });
  }
  console.log(results.join('\n'));
  if (results.some((line) => line.startsWith('FAIL'))) process.exitCode = 1;
}

if (process.argv.includes('--probe')) await probe();
else await generate();
