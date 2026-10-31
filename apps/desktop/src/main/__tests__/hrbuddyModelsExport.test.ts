/**
 * hrbuddyModelsExport.test.ts
 * ---------------------------------------------------------------------------
 * 测试价值
 * - 生产入口与可观察结果：`exportModels`（需求 7 的镜像写盘）与
 *   `hrbuddy-models:export` IPC handler（Ruling 2 的 store 推送入口）→
 *   读 `~/.hrbuddy/models.json` 文件内容，断言密钥缺席、幂等合并、字段并集。
 * - Bug／规则依据：Review Focus #1「密钥绝不落盘到 models.json」（红线，出现即事故）；
 *   Ruling 2「导出走 main 侧 IPC」；设计稿 §6.3 字段两版并集。
 * - 现有覆盖缺口：`hrbuddyModelsExport.ts` 零测试。当前 `exportModels` 原样
 *   JSON.stringify 入参对象——调用方 spread 进 `apiKey` 会直接落盘（case 1 的最小失败输入）。
 * - tier：unit（真实 tmpdir 文件读写，无网络、无 Electron）。
 * - 实测耗时：~15ms（pnpm --filter desktop exec vitest run src/main/__tests__/hrbuddyModelsExport.test.ts）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pathMock = vi.hoisted(() => ({ homeDir: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => pathMock.homeDir },
    homedir: () => pathMock.homeDir,
  };
});

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

import {
  exportModels,
  modelsJsonPath,
  registerHrbuddyModelsExportIpc,
  type ExportedModel,
} from '../hrbuddyModelsExport';
import { MAKER_INVOKE } from '../maker-ipc/channels';
import { IpcHarness } from '../maker-ipc/__tests__/helpers/ipcHarness';

/** 读镜像文件的 models 数组。 */
function readModels(): Array<Record<string, unknown>> {
  const parsed = JSON.parse(fs.readFileSync(modelsJsonPath(), 'utf8')) as {
    models: Array<Record<string, unknown>>;
  };
  return parsed.models;
}

describe('hrbuddyModelsExport', () => {
  beforeEach(() => {
    pathMock.homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrbuddy-models-export-'));
  });

  afterEach(() => {
    fs.rmSync(pathMock.homeDir, { recursive: true, force: true });
  });

  it('never writes the api key into models.json', () => {
    // 最小失败输入：调用方（如 spread 了 ModelGatewayInput）把密钥字段带进行对象。
    // 写盘必须按白名单组装行、绝不透传多余字段——文件内容出现任何 key 片段即事故。
    const leaky = {
      id: 'm1',
      name: 'm1',
      provider: 'p1',
      baseUrl: 'https://gw.example/anthropic',
      apiKey: 'sk-SECRET-DO-NOT-WRITE',
    } as unknown as ExportedModel;
    exportModels([leaky]);

    const raw = fs.readFileSync(modelsJsonPath(), 'utf8');
    expect(raw).not.toContain('sk-SECRET-DO-NOT-WRITE');
    expect(raw).not.toContain('apiKey');
    // 行本身照常落盘（只剥密钥，不丢元数据）。
    expect(readModels()).toHaveLength(1);
    expect(readModels()[0]).toMatchObject({ id: 'm1', provider: 'p1' });
  });

  it('merges idempotently by provider+id', () => {
    const row = {
      id: 'm1',
      name: 'm1',
      provider: 'p1',
      baseUrl: 'https://gw.example/anthropic',
    };
    exportModels([row]);
    exportModels([row]);

    const models = readModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject(row);
  });

  it('includes enabled and status alongside the legacy capability fields', () => {
    // 字段两版并集（设计稿 §6.3）：legacy 能力位 + enabled/status/lastTestedAt。
    exportModels([
      {
        id: 'm1',
        name: 'M1',
        provider: 'p1',
        baseUrl: 'https://gw.example/anthropic',
        wireProtocol: 'anthropic-messages',
        supportsToolCalls: true,
        supportsImageInput: false,
        reasoningRequired: true,
        enabled: true,
        status: { ok: true, latencyMs: 120 },
        lastTestedAt: '2026-10-31T01:00:00.000Z',
      },
    ]);

    expect(readModels()[0]).toEqual({
      id: 'm1',
      name: 'M1',
      provider: 'p1',
      baseUrl: 'https://gw.example/anthropic',
      wireProtocol: 'anthropic-messages',
      supportsToolCalls: true,
      supportsImageInput: false,
      reasoningRequired: true,
      enabled: true,
      status: { ok: true, latencyMs: 120 },
      lastTestedAt: '2026-10-31T01:00:00.000Z',
    });
  });

  it('mirrors enabled and status updates from toggle and retest', async () => {
    // Ruling 2 推送入口：store 在 toggle/retest 后把不含密钥的元数据发给
    // hrbuddy-models:export。镜像必须反映变化（同 provider+id 覆盖旧行）。
    const harness = new IpcHarness();
    registerHrbuddyModelsExportIpc(harness, { assertTrustedSender: () => {} });
    const channel = MAKER_INVOKE.HRBUDDY_MODELS_EXPORT;

    // toggle(false) 后 store 推送的全量元数据（ModelEntry → ExportedModel 映射）。
    await harness.invoke(channel, [
      {
        id: 'm1',
        name: 'm1',
        provider: 'm1',
        baseUrl: 'https://gw.example/anthropic',
        wireProtocol: 'anthropic-messages',
        enabled: false,
        status: 'untested',
      },
    ]);
    // retest（setStatus { ok, latencyMs } + lastTestedAt）后再次推送。
    await harness.invoke(channel, [
      {
        id: 'm1',
        name: 'm1',
        provider: 'm1',
        baseUrl: 'https://gw.example/anthropic',
        wireProtocol: 'anthropic-messages',
        enabled: false,
        status: { ok: true, latencyMs: 80 },
        lastTestedAt: '2026-10-31T02:00:00.000Z',
      },
    ]);

    const models = readModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      enabled: false,
      status: { ok: true, latencyMs: 80 },
      lastTestedAt: '2026-10-31T02:00:00.000Z',
    });
  });

  it('export IPC rejects a malformed payload', async () => {
    const harness = new IpcHarness();
    registerHrbuddyModelsExportIpc(harness, { assertTrustedSender: () => {} });

    await expect(harness.invoke(MAKER_INVOKE.HRBUDDY_MODELS_EXPORT, null)).rejects.toThrow(
      /\[INVALID_PARAMS\]/,
    );
    // 拒绝路径不落盘。
    expect(() => fs.readFileSync(modelsJsonPath(), 'utf8')).toThrow();
  });
});
