/**
 * 测试价值
 * - 生产入口与可观察结果：commitActiveAppSession / commitVolatileAppSession 的 `'hr'` 分支——
 *   `commitActiveAppSession('hr', 'person-42')` 返回 `{ mode: 'hr', dataOwnerId: 'person-42' }`
 *   且 `getActiveAppSession().mode !== 'signed-out'`（authManager.ts:3507 的 canEnterApp 判据
 *   随之为 true，现判据不用改）；空/空白 verified owner 抛错（同 cloud 的 verified owner 要求）；
 *   `'local'` 仍强制 LOCAL_DATA_OWNER_ID（回归护栏）。
 * - Bug／规则依据：登录门禁计划 Task 2 Step 1/2——AppSessionMode 增 `'hr'`，HR 的 dataOwner
 *   必须是已验证的冻结账号键，禁止空 owner 认领数据分区；local 保留 id 不得被 hr 分支波及。
 * - 现有覆盖缺口：appSessionBoundary.test.ts 只覆盖 local/cloud/boundary 与 realm 发布，
 *   没有 `'hr'` 的 owner 归一化分支。
 * - 最小失败输入：`commitActiveAppSession('hr', 'person-42')`（此前分支只认 local/cloud，
 *   hr 的 dataOwnerId 会落空）；`commit('hr', '')` 期望抛错而现状不抛；local 回归断言。
 * - tier：unit（内存 override-settings-file + electron stub，无真实 userData 写入）。
 * - 实测耗时：单文件 ~1.1s 墙钟（pnpm --dir apps/desktop exec vitest run src/main/hr-oa/__tests__/appSessionHrMode.test.ts）。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `C:/tmp/cindy-${name}` },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({
    read: () => ({ activeMode: 'signed-out' }),
    writePatch: vi.fn(),
  }),
}));

import {
  commitActiveAppSession,
  commitVolatileAppSession,
  getActiveAppSession,
  LOCAL_DATA_OWNER_ID,
} from '../../appSessionState.js';

describe('hr app session mode', () => {
  it.each([
    ['active', commitActiveAppSession],
    ['volatile', commitVolatileAppSession],
  ] as const)('commits a %s hr session under the verified account key', (_name, commit) => {
    const committed = commit('hr', 'person-42');
    expect(committed).toMatchObject({ mode: 'hr', dataOwnerId: 'person-42' });
    // canEnterApp = mode !== 'signed-out'（authManager.ts:3507）：hr 必须自动可进主界面。
    expect(getActiveAppSession().mode).not.toBe('signed-out');
    expect(getActiveAppSession().dataOwnerId).toBe('person-42');
  });

  it.each([
    ['active', commitActiveAppSession],
    ['volatile', commitVolatileAppSession],
  ] as const)('rejects a %s hr commit without a verified data owner', (_name, commit) => {
    expect(() => commit('hr', '')).toThrow(/verified data owner/);
    expect(() => commit('hr', '   ')).toThrow(/verified data owner/);
  });

  it('keeps forcing the reserved owner id for local mode', () => {
    const committed = commitActiveAppSession('local');
    expect(committed).toMatchObject({ mode: 'local', dataOwnerId: LOCAL_DATA_OWNER_ID });
    expect(getActiveAppSession().dataOwnerId).toBe(LOCAL_DATA_OWNER_ID);
  });
});
