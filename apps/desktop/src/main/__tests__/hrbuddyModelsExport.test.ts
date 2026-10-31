/**
 * hrbuddyModelsExport.test.ts
 * ---------------------------------------------------------------------------
 * 测试价值
 * - 生产入口与可观察结果：`exportModels`（镜像写盘）与 `hrbuddy-models:export` IPC
 *   handler（Ruling 2 的 store 推送入口）→ 读 `~/.hrbuddy/models.json` 文件内容，
 *   断言密钥缺席、整组替换（store 1:1 投影）、字段并集、同 modelId 并存、删除消失。
 * - Bug／规则依据：Review Focus #1「密钥绝不落盘到 models.json」（红线，出现即事故）；
 *   Ruling 2「导出走 main 侧 IPC」；Ruling 17「镜像应当是 store 的 1:1 投影」
 *   （`id`=稳定句柄、另加 `modelId`、整组替换）；设计稿 §6.3 字段两版并集。
 * - 现有覆盖缺口：原实现按 `provider + id` merge 且 `id`=上游模型 id——删除/改名留残行、
 *   同 modelId 多条目折叠（case 5/6 的最小失败输入）；行对象多余字段（`apiKey`）原样
 *   JSON.stringify 落盘（case 1 的最小失败输入）。
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
      id: 'handle-a',
      modelId: 'm1',
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
    expect(readModels()[0]).toMatchObject({ id: 'handle-a', modelId: 'm1', provider: 'p1' });
  });

  it('writes the same file for repeated identical snapshots (同输入 → 同文件)', () => {
    // Ruling 17：幂等 = 同输入 → 同文件；整组替换同样满足设计稿的「幂等」语义。
    const row = {
      id: 'handle-a',
      modelId: 'm1',
      name: 'm1',
      provider: 'p1',
      baseUrl: 'https://gw.example/anthropic',
    };
    exportModels([row]);
    const first = readModels();
    exportModels([row]);
    const second = readModels();

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('includes enabled and status alongside the legacy capability fields', () => {
    // 字段两版并集（设计稿 §6.3）：legacy 能力位 + enabled/status/lastTestedAt。
    exportModels([
      {
        id: 'handle-a',
        modelId: 'm1',
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
      id: 'handle-a',
      modelId: 'm1',
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
    // hrbuddy-models:export。镜像必须反映变化（整组替换覆盖旧行）。
    const harness = new IpcHarness();
    registerHrbuddyModelsExportIpc(harness, { assertTrustedSender: () => {} });
    const channel = MAKER_INVOKE.HRBUDDY_MODELS_EXPORT;

    // toggle(false) 后 store 推送的全量元数据（ModelEntry → ExportedModel 映射）。
    await harness.invoke(channel, [
      {
        id: 'handle-a',
        modelId: 'm1',
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
        id: 'handle-a',
        modelId: 'm1',
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

  it('keeps two configs sharing one modelId side by side (同 modelId 不折叠)', () => {
    // Ruling 17 修复的折叠 bug：旧实现 id=上游模型 id、按 provider+id merge，
    // 两条同 modelId 的不同配置会并成一行。id=稳定句柄后必须并存。
    const shared = 'claude-sonnet-4-6';
    exportModels([
      {
        id: 'gw-a',
        modelId: shared,
        name: shared,
        provider: shared,
        baseUrl: 'https://a.example/anthropic',
      },
      {
        id: 'gw-b',
        modelId: shared,
        name: shared,
        provider: shared,
        baseUrl: 'https://b.example/anthropic',
      },
    ]);

    const models = readModels();
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toEqual(['gw-a', 'gw-b']);
    expect(models.map((m) => m.modelId)).toEqual([shared, shared]);
  });

  it('drops removed entries from the mirror (整组替换生效)', () => {
    // Ruling 17 修复的残留 bug：store 删除后推送全量剩余条目，被删行必须消失。
    const a = {
      id: 'gw-a',
      modelId: 'm1',
      name: 'm1',
      provider: 'p1',
      baseUrl: 'https://a.example/anthropic',
    };
    const b = {
      id: 'gw-b',
      modelId: 'm2',
      name: 'm2',
      provider: 'p2',
      baseUrl: 'https://b.example/anthropic',
    };
    exportModels([a, b]);
    expect(readModels()).toHaveLength(2);

    exportModels([a]); // store 删除 b 后推送全量剩余条目
    const models = readModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: 'gw-a', modelId: 'm1' });
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
