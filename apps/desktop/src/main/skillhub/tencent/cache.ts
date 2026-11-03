/**
 * 腾讯来源的缓存：内存 TTL 缓存、首页磁盘快照、下载基线信任表（TOFU）。
 *
 * 存储位置（credentials-and-local-storage.md「路径与生命周期」）：
 *   - 快照：`userData/skillhub/tencent/home-snapshot.json`，下载量降序第一页 + 分类，
 *     只在断网或熔断时读，最长 7 天；公开目录数据，不含凭证或用户内容。
 *   - 信任表：`userData/skillhub/tencent/trust.json`，键 `handle/slug@version` → zip
 *     的 sha256。只能发现「之后被换包」，证明不了首次下载可信（方案 §5.1、R10）。
 * 两个文件都原子替换写入；读不出时按空处理，信任表读不出时拒绝覆写（保留证据）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';

import { createLogger } from '../../logger';
import type { TencentCategory, TencentSkillRecord } from './mapping';

const log = createLogger('skillhub:tencent:cache');

/** Small TTL map; entries are evicted lazily on read and when the cap is reached. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface TencentHomeSnapshot {
  savedAt: number;
  items: TencentSkillRecord[];
  categories: TencentCategory[];
}

function tencentDir(): string {
  return path.join(app.getPath('userData'), 'skillhub', 'tencent');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(value), 'utf8');
  try {
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Disk snapshot of the last successful first page, used only when offline or the circuit is open. */
export class TencentSnapshotStore {
  constructor(private readonly filePath: () => string = () => path.join(tencentDir(), 'home-snapshot.json')) {}

  async read(maxAgeMs: number, now = Date.now()): Promise<TencentHomeSnapshot | null> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.filePath(), 'utf8')) as TencentHomeSnapshot;
      if (typeof raw?.savedAt !== 'number' || !Array.isArray(raw.items) || !Array.isArray(raw.categories)) return null;
      if (now - raw.savedAt > maxAgeMs) return null;
      return raw;
    } catch {
      return null;
    }
  }

  async write(snapshot: TencentHomeSnapshot): Promise<void> {
    await writeJsonAtomic(this.filePath(), snapshot).catch((err) => {
      log.warn('write home snapshot failed', err instanceof Error ? err.message : String(err));
    });
  }
}

/**
 * Trust-on-first-use table of zip sha256 per `handle/slug@version`.
 * A later install of the same key with a different sha256 is refused.
 */
export class TencentTrustStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: () => string = () => path.join(tencentDir(), 'trust.json')) {}

  static key(handle: string, slug: string, version: string): string {
    return `${handle}/${slug}@${version}`;
  }

  /**
   * 首次登记返回 'recorded'，与已登记值一致返回 'match'，不一致返回 'mismatch'。
   * 串行执行，避免两个安装同时读改写把对方的登记覆盖掉。
   */
  verifyOrRecord(key: string, sha256: string): Promise<'recorded' | 'match' | 'mismatch'> {
    const run = this.queue.then(() => this.verifyOrRecordNow(key, sha256));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async verifyOrRecordNow(key: string, sha256: string): Promise<'recorded' | 'match' | 'mismatch'> {
    let table: Record<string, string> = {};
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.filePath(), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('trust table is not an object');
      }
      table = parsed as Record<string, string>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 损坏的信任表不覆写：覆写会抹掉既有基线，等于关掉换包检测。
        throw new Error(`信任表无法读取，已拒绝安装：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const known = table[key];
    if (known === sha256) return 'match';
    if (known !== undefined) return 'mismatch';
    table[key] = sha256;
    await writeJsonAtomic(this.filePath(), table);
    return 'recorded';
  }
}
