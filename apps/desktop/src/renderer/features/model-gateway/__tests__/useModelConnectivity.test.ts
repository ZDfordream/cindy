/**
 * useModelConnectivity —— 模型网关连通探测的结果归一契约（Task 2）。
 *
 * 测试价值
 * - 生产入口与可观察结果：`testModelConnectivity`（Task 3 列表「重测」与 Task 4 保存门
 *   的共同原语）；调用方只看得到 `{ ok: true, latencyMs } | { ok: false, detail }`，
 *   且 Promise 永不 reject。
 * - Bug／规则依据：任务 brief Task 2 Produces 形状；Global Constraint「协议写死
 *   anthropic-messages」——IPC 入参是对外协议，形状/协议错了探测会打到错误 wire
 *   protocol，密钥会进错通道。
 * - 现有覆盖缺口：modelGatewayStore.test.ts 只盖 store 的增删改查与持久化，没有连通
 *   探测分支；3 个用例即 Produces 的全部结果分支（成功 / 服务端失败 / IPC 抛错），
 *   与 store 测试不同生产入口、不同 stub 面，不并入。
 * - 最小失败输入：stub testProviderConnection → `{ ok: true, latencyMs: 128 }` /
 *   `{ ok: false, detail: '401 unauthorized' }` / throw。
 * - tier：unit；纯 renderer 归一逻辑，只在 IPC 边界打桩（同
 *   CustomProviderDialogAccessibility.test.tsx），无 DOM → node 环境。
 * - 实测耗时：单独运行约 0.3s（2026-10-31 本机 vitest run 本文件，收集 21ms + 用例 3ms）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testModelConnectivity } from '../useModelConnectivity';

interface MakerMock {
  testProviderConnection: ReturnType<typeof vi.fn>;
}

let maker: MakerMock;

describe('testModelConnectivity', () => {
  beforeEach(() => {
    maker = { testProviderConnection: vi.fn() };
    vi.stubGlobal('window', { electronAPI: { maker } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok with latency when the probe succeeds', async () => {
    maker.testProviderConnection.mockResolvedValue({ ok: true, latencyMs: 128 });

    const result = await testModelConnectivity({
      baseUrl: 'https://gw.example/anthropic',
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-6',
    });

    expect(result).toEqual({ ok: true, latencyMs: 128 });
    // 协议契约（对外 IPC 入参）：adhoc spec 写死 anthropic-messages / apiKey 鉴权，
    // 密钥只搭这一趟 IPC 入参；形状或协议被改坏 → 探测打到错误 wire protocol。
    expect(maker.testProviderConnection).toHaveBeenCalledWith({
      kind: 'adhoc',
      requestId: expect.stringMatching(/^model-gateway-\d+$/),
      spec: {
        agent: 'claude-code',
        baseUrl: 'https://gw.example/anthropic',
        modelId: 'claude-sonnet-4-6',
        authMethod: 'apiKey',
        wireProtocol: 'anthropic-messages',
        apiKey: 'sk-test',
      },
    });
  });

  it('returns the server detail verbatim when the probe fails', async () => {
    maker.testProviderConnection.mockResolvedValue({ ok: false, detail: '401 unauthorized' });

    const result = await testModelConnectivity({
      baseUrl: 'https://gw.example/anthropic',
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-6',
    });

    expect(result).toEqual({ ok: false, detail: '401 unauthorized' });
  });

  it('maps a thrown IPC error to a failed result instead of rejecting', async () => {
    maker.testProviderConnection.mockRejectedValue(new Error('ipc gone'));

    const result = await testModelConnectivity({
      baseUrl: 'https://gw.example/anthropic',
      apiKey: 'sk-test',
      modelId: 'claude-sonnet-4-6',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.detail.length).toBeGreaterThan(0);
  });
});
