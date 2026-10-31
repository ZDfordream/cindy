/** @vitest-environment jsdom */

/**
 * modelGatewayStore —— 模型条目数据层的增删改查、插入序、稳定句柄、删除 5s 撤销、
 * localStorage 元数据持久化与「清空重来」标记过滤。
 *
 * 走真实生产入口：`useModelGateway` → `@/lib/customProviders` 的 create/update/delete
 * 与 `window.electronAPI.maker.listProviders`，只在 IPC / localStorage 边界打桩
 * （与 customProviders.test.ts 同法）。凭证契约（keys 提交、config / state 不含密钥）
 * 在 add 用例里钉住。
 */
import { act, renderHook } from '@testing-library/react';
import type { CustomProviderConfig, ProviderView } from '@cindy/model-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MODEL_GATEWAY_CATALOG_PRESET_ID,
  ModelGatewayProvider,
  useModelGateway,
} from '../ModelGatewayStore';

interface MakerMock {
  listProviders: ReturnType<typeof vi.fn>;
  createCustomProvider: ReturnType<typeof vi.fn>;
  updateCustomProvider: ReturnType<typeof vi.fn>;
  deleteCustomProvider: ReturnType<typeof vi.fn>;
  exportHrbuddyModels: ReturnType<typeof vi.fn>;
}

/** 最小 localStorage 替身；同用例内多次 render 共享同一份（模拟重启后仍在）。 */
function memoryStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

let maker: MakerMock;
let storage: ReturnType<typeof memoryStorage>;
let safeStorageRead: ReturnType<typeof vi.fn>;

/** 一条自定义供应商视图；`catalogPresetId` 缺省即旧表单（无新表单标记）配置。 */
function userProviderView(input: {
  providerId: string;
  modelId: string;
  name?: string;
  baseUrl?: string;
  catalogPresetId?: string;
}): ProviderView {
  return {
    id: input.providerId,
    name: input.name ?? input.modelId,
    source: 'user',
    agents: ['claude-code'],
    auth: { method: 'apiKey' },
    connected: true,
    routing: {
      'claude-code': {
        upstream: input.baseUrl ?? 'https://gw.example/anthropic',
        wireProtocol: 'anthropic-messages',
      },
    },
    models: {
      'claude-code': [
        {
          id: input.modelId,
          name: input.modelId,
          ...(input.catalogPresetId ? { catalogPresetId: input.catalogPresetId } : {}),
        },
      ],
    },
  } as unknown as ProviderView;
}

function renderGateway() {
  return renderHook(() => useModelGateway(), { wrapper: ModelGatewayProvider });
}

describe('model gateway store', () => {
  beforeEach(() => {
    maker = {
      listProviders: vi.fn(async () => ({
        dataOwnerId: null,
        ownerGeneration: 1,
        providers: [] as ProviderView[],
        providerOrder: [] as string[],
      })),
      createCustomProvider: vi.fn(async () => ({ ok: true })),
      updateCustomProvider: vi.fn(async () => ({ ok: true })),
      deleteCustomProvider: vi.fn(async () => ({ ok: true })),
      exportHrbuddyModels: vi.fn(async () => undefined),
    };
    storage = memoryStorage();
    // update 的「密钥有没有变」与 keychain 现值核对（readCustomProviderKey）；默认无密钥。
    safeStorageRead = vi.fn(async () => null);
    vi.stubGlobal('window', {
      electronAPI: { maker, safeStorageRead },
      localStorage: storage,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a model and appends it at the end (insertion order)', async () => {
    const { result } = renderGateway();
    await act(async () => {});

    let addedId = '';
    await act(async () => {
      addedId = await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-b',
        modelId: 'b',
      });
    });
    await act(async () => {
      await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'a',
      });
    });

    // add 返回稳定句柄；entries 保持插入序（新条目追加末尾），不再按 modelId 排序。
    expect(addedId).toBe('b');
    expect(result.current.entries.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(result.current.entries.map((entry) => entry.modelId)).toEqual(['b', 'a']);
    expect(result.current.entries).toEqual([
      {
        id: 'b',
        modelId: 'b',
        name: 'b',
        baseUrl: 'https://gw.example/anthropic',
        enabled: true,
        status: 'untested',
      },
      {
        id: 'a',
        modelId: 'a',
        name: 'a',
        baseUrl: 'https://gw.example/anthropic',
        enabled: true,
        status: 'untested',
      },
    ]);

    // 协议写死 anthropic-messages + 新表单标记随配置落库；密钥只经 keys 提交，
    // 既不进 config，也不进 React state。
    const createConfig = maker.createCustomProvider.mock.calls[0][0] as CustomProviderConfig;
    expect(createConfig.runtimes['claude-code']?.wireProtocol).toBe('anthropic-messages');
    expect(createConfig.runtimes['claude-code']?.catalogPresetId).toBe('hrbuddy-gateway');
    expect(maker.createCustomProvider.mock.calls[0][1]).toEqual({ 'claude-code': 'sk-b' });
    expect(JSON.stringify(createConfig)).not.toContain('sk-b');
    expect(JSON.stringify(result.current.entries)).not.toContain('sk-b');
  });

  it('add persists as untested', async () => {
    // PRD：保存不探测——新建条目恒「未测试」，不继承任何历史状态。
    const { result } = renderGateway();
    await act(async () => {});

    await act(async () => {
      await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'a',
      });
    });

    expect(result.current.entries[0]!.status).toBe('untested');
    expect(result.current.entries[0]!.lastTestedAt).toBeUndefined();
    expect(JSON.parse(storage.getItem('hrbuddy.modelGatewayMeta') ?? 'null')).toEqual({
      a: { enabled: true, status: 'untested' },
    });
  });

  it('test_delete_undo_restores_entry_until_window_expires', async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderGateway();
      await act(async () => {});
      await act(async () => {
        await result.current.add({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-a', modelId: 'a' });
        await result.current.add({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-b', modelId: 'b' });
        await result.current.add({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-c', modelId: 'c' });
      });

      let handle: { undo: () => void } | null = null;
      await act(async () => {
        handle = await result.current.remove('b');
      });
      // remove 立即出 entries，真正的 deleteCustomProvider（含密钥）延迟 5s。
      expect(result.current.entries.map((entry) => entry.id)).toEqual(['a', 'c']);
      expect(maker.deleteCustomProvider).not.toHaveBeenCalled();
      // 软摘除新表单标记：强杀窗口内进程时残留配置不进列表（store 只收带标记条目）。
      const stripConfig = maker.updateCustomProvider.mock.calls.at(-1)![0] as CustomProviderConfig;
      expect(stripConfig.runtimes['claude-code']?.catalogPresetId).toBeUndefined();

      await act(async () => {
        handle!.undo();
      });
      // undo 回原索引，id / enabled 不变；标记补回；meta 与镜像跟着恢复一致。
      expect(result.current.entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
      expect(result.current.entries[1]).toMatchObject({ id: 'b', enabled: true });
      const restoreConfig = maker.updateCustomProvider.mock.calls.at(-1)![0] as CustomProviderConfig;
      expect(restoreConfig.runtimes['claude-code']?.catalogPresetId).toBe(MODEL_GATEWAY_CATALOG_PRESET_ID);
      expect(JSON.parse(storage.getItem('hrbuddy.modelGatewayMeta') ?? 'null')).toHaveProperty('b');
      expect(
        (maker.exportHrbuddyModels.mock.calls.at(-1)![0] as Array<{ id: string }>).map((row) => row.id),
      ).toEqual(['a', 'b', 'c']);

      // undo 后不落删除。
      await act(async () => {
        vi.advanceTimersByTime(5000);
      });
      expect(maker.deleteCustomProvider).not.toHaveBeenCalled();

      // 不 undo：窗口结束（恰好 5000ms）才删，且只删一次。
      await act(async () => {
        await result.current.remove('b');
      });
      await act(async () => {
        vi.advanceTimersByTime(4999);
      });
      expect(maker.deleteCustomProvider).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(maker.deleteCustomProvider).toHaveBeenCalledTimes(1);
      expect(maker.deleteCustomProvider).toHaveBeenCalledWith('b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending deletes on unmount (best-effort)', async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderGateway();
      await act(async () => {});
      await act(async () => {
        await result.current.add({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-a', modelId: 'a' });
      });
      await act(async () => {
        await result.current.remove('a');
      });
      expect(maker.deleteCustomProvider).not.toHaveBeenCalled();

      // 卸载即 flush 未决删除（尽力而为，不等 5s 窗口）。
      unmount();
      expect(maker.deleteCustomProvider).toHaveBeenCalledTimes(1);
      expect(maker.deleteCustomProvider).toHaveBeenCalledWith('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('update replaces baseUrl/modelId and keeps the same entry id', async () => {
    const { result } = renderGateway();
    await act(async () => {});
    await act(async () => {
      await result.current.add({
        baseUrl: 'https://gw-a.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'model-a',
      });
      await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-b',
        modelId: 'model-b',
      });
    });
    await act(async () => {
      await result.current.toggle('model-a', false);
    });

    // modelId 真的换（model-a → model-z）：句柄保持 model-a 不动。
    await act(async () => {
      await result.current.update('model-a', {
        baseUrl: 'https://gw-b.example/anthropic',
        apiKey: 'sk-z',
        modelId: 'model-z',
      });
    });

    const updated = result.current.entries.find((entry) => entry.modelId === 'model-z');
    expect(updated?.id).toBe('model-a');
    expect(updated?.baseUrl).toBe('https://gw-b.example/anthropic');
    expect(updated?.name).toBe('model-z');
    // 插入序不动（编辑不换位）：先加的 model-a 改名后仍在原位。
    expect(result.current.entries.map((entry) => entry.modelId)).toEqual(['model-z', 'model-b']);
    expect(result.current.entries.map((entry) => entry.id)).toEqual(['model-a', 'model-b']);
    // 编辑不重置启停（meta 按稳定 id 挂着）。
    expect(updated?.enabled).toBe(false);

    // 同一条存储记录被更新（不是删除重建），input 的 baseUrl / modelId / 密钥都写穿进配置。
    const createConfig = maker.createCustomProvider.mock.calls[0][0] as CustomProviderConfig;
    const updateConfig = maker.updateCustomProvider.mock.calls[0][0] as CustomProviderConfig;
    expect(updateConfig.id).toBe(createConfig.id);
    expect(updateConfig.runtimes['claude-code']?.baseUrl).toBe('https://gw-b.example/anthropic');
    expect(updateConfig.runtimes['claude-code']?.models[0]?.id).toBe('model-z');
    expect(maker.updateCustomProvider.mock.calls[0][1]).toEqual({ 'claude-code': 'sk-z' });
  });

  it('update resets status to untested when fields change', async () => {
    // baseUrl/modelId/apiKey 任一变化 → 旧探测结果作废（PRD：存后未测试）。
    const { result } = renderGateway();
    await act(async () => {});
    await act(async () => {
      await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'a',
      });
    });
    await act(async () => {
      await result.current.setStatus('a', { ok: true, latencyMs: 80 });
    });
    expect(result.current.entries[0]!.status).toEqual({ ok: true, latencyMs: 80 });

    // 只换密钥（keychain 现值仍是 sk-a）：也算变化。
    safeStorageRead.mockResolvedValue('sk-a');
    await act(async () => {
      await result.current.update('a', {
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-new',
        modelId: 'a',
      });
    });
    expect(result.current.entries[0]!.status).toBe('untested');
    expect(result.current.entries[0]!.lastTestedAt).toBeUndefined();

    // 换 modelId 同样重置。
    await act(async () => {
      await result.current.setStatus('a', { ok: true, latencyMs: 90 });
    });
    await act(async () => {
      await result.current.update('a', {
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-new',
        modelId: 'a-renamed',
      });
    });
    expect(result.current.entries[0]!.status).toBe('untested');
  });

  it('update keeps status when nothing changed', async () => {
    const { result } = renderGateway();
    await act(async () => {});
    await act(async () => {
      await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'a',
      });
    });
    await act(async () => {
      await result.current.setStatus('a', { ok: true, latencyMs: 80 });
    });

    // 三项与现值完全一致（密钥与 keychain 现值核对相等）：状态与时间戳都保留。
    safeStorageRead.mockResolvedValue('sk-a');
    await act(async () => {
      await result.current.update('a', {
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'a',
      });
    });
    expect(result.current.entries[0]!.status).toEqual({ ok: true, latencyMs: 80 });
    expect(result.current.entries[0]!.lastTestedAt).toEqual(expect.any(String));
  });

  it('toggle only flips enabled; entry stays in entries', async () => {
    const { result } = renderGateway();
    await act(async () => {});
    await act(async () => {
      await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'a',
      });
    });

    await act(async () => {
      await result.current.toggle('a', false);
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]?.enabled).toBe(false);
    expect(result.current.entries[0]?.id).toBe('a');

    await act(async () => {
      await result.current.toggle('a', true);
    });
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]?.enabled).toBe(true);
  });

  it('hides entries lacking the new-form marker (clean start)', async () => {
    maker.listProviders.mockResolvedValue({
      dataOwnerId: null,
      ownerGeneration: 1,
      providers: [
        // 2026-10-29 旧表单配的「小米 MiMo 网关」——留在 localDb，但新列表看不见。
        userProviderView({
          providerId: 'xiaomi-mimo-gateway',
          modelId: 'xiaomi/mimo-v2.6-pro',
          name: '小米 MiMo 网关',
          baseUrl: 'http://model.mify.ai.srv/anthropic',
        }),
        userProviderView({
          providerId: 'gw-a',
          modelId: 'model-a',
          catalogPresetId: MODEL_GATEWAY_CATALOG_PRESET_ID,
        }),
      ],
      providerOrder: [],
    });

    const { result } = renderGateway();
    await act(async () => {});

    // 句柄 = 自定义供应商 id（gw-a），modelId 单独一列。
    expect(result.current.entries.map((entry) => entry.id)).toEqual(['gw-a']);
    expect(result.current.entries.map((entry) => entry.modelId)).toEqual(['model-a']);
  });

  it('persists enabled/status/lastTestedAt across remount (localStorage)', async () => {
    maker.listProviders.mockResolvedValue({
      dataOwnerId: null,
      ownerGeneration: 1,
      providers: [
        userProviderView({
          providerId: 'gw-a',
          modelId: 'model-a',
          catalogPresetId: MODEL_GATEWAY_CATALOG_PRESET_ID,
        }),
      ],
      providerOrder: [],
    });

    const first = renderGateway();
    await act(async () => {});
    await act(async () => {
      await first.result.current.toggle('gw-a', false);
    });
    await act(async () => {
      first.result.current.setStatus('gw-a', { ok: true, latencyMs: 80 });
    });

    // Ruling 5 的存储契约：key `hrbuddy.modelGatewayMeta`，按条目 id 索引的 JSON blob。
    expect(JSON.parse(storage.getItem('hrbuddy.modelGatewayMeta') ?? 'null')).toEqual({
      'gw-a': {
        enabled: false,
        status: { ok: true, latencyMs: 80 },
        lastTestedAt: expect.any(String),
      },
    });
    first.unmount();

    // 「重启」（重新挂载）：开关与最近一次测试结果都不回空白。
    const second = renderGateway();
    await act(async () => {});
    expect(second.result.current.entries).toHaveLength(1);
    expect(second.result.current.entries[0]).toMatchObject({
      id: 'gw-a',
      modelId: 'model-a',
      enabled: false,
      status: { ok: true, latencyMs: 80 },
      lastTestedAt: expect.any(String),
    });
  });

  it('never hands create a reserved provider id as the entry handle', async () => {
    const { result } = renderGateway();
    await act(async () => {});

    // modelId 撞内置来源保留名（xai 等）时，稳定句柄加后缀避开，create 校验才不会拒。
    let addedId = '';
    await act(async () => {
      addedId = await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-x',
        modelId: 'xai',
      });
    });

    expect(addedId).toBe('xai-2');
    expect((maker.createCustomProvider.mock.calls[0][0] as CustomProviderConfig).id).toBe('xai-2');
    expect(result.current.entries.map((entry) => entry.id)).toEqual(['xai-2']);
    expect(result.current.entries.map((entry) => entry.modelId)).toEqual(['xai']);
  });

  it('pushes secret-free mirror metadata after toggle and retest (Ruling 2)', async () => {
    // 测试价值（§3.2）：生产入口 = useModelGateway().toggle/setStatus →
    // window.electronAPI.maker.exportHrbuddyModels（Ruling 2 的镜像推送）；可观察结果 =
    // 推送载荷含变更后的 enabled/status/lastTestedAt 且全文无密钥片段。
    // 规则依据：Ruling 2 + Review Focus #1。覆盖缺口：此前无任何用例钉 store 的推送调用点
    // （漏推则镜像静默过期，红线也可能被将来 spread 破坏）。最小失败输入 = toggle/setStatus
    // 后检查 mock.calls。tier：unit（IPC 边界打桩）。
    maker.listProviders.mockResolvedValue({
      dataOwnerId: null,
      ownerGeneration: 1,
      providers: [
        userProviderView({
          providerId: 'gw-a',
          modelId: 'model-a',
          catalogPresetId: MODEL_GATEWAY_CATALOG_PRESET_ID,
        }),
      ],
      providerOrder: [],
    });

    const { result } = renderGateway();
    await act(async () => {});

    await act(async () => {
      await result.current.toggle('gw-a', false);
    });
    await act(async () => {
      result.current.setStatus('gw-a', { ok: true, latencyMs: 80 });
    });

    // 载荷含开关与最近一次测试结果（镜像「能反映」的输入侧）；id=稳定句柄、
    // modelId=上游模型 id（Ruling 17 的 1:1 投影身份）。
    expect(maker.exportHrbuddyModels.mock.calls.at(-1)?.[0]).toEqual([
      {
        id: 'gw-a',
        modelId: 'model-a',
        name: 'model-a',
        provider: 'model-a',
        baseUrl: 'https://gw.example/anthropic',
        wireProtocol: 'anthropic-messages',
        enabled: false,
        status: { ok: true, latencyMs: 80 },
        lastTestedAt: expect.any(String),
      },
    ]);
    // 密钥绝不进 export 调用（红线的调用侧断言；文件侧断言见 hrbuddyModelsExport.test.ts）。
    expect(JSON.stringify(maker.exportHrbuddyModels.mock.calls)).not.toContain('sk-');
  });

  it('pushes distinct mirror rows for two configs sharing one modelId (Ruling 17)', async () => {
    // 折叠 bug 的源头在 store 映射：旧实现 id=entry.modelId，同 modelId 的两条配置
    // 推成同一身份 → 镜像并成一行。Ruling 17 起 id=稳定句柄，两条必须并存。
    const { result } = renderGateway();
    await act(async () => {});

    await act(async () => {
      await result.current.add({
        baseUrl: 'https://a.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'shared-model',
      });
    });
    await act(async () => {
      await result.current.add({
        baseUrl: 'https://b.example/anthropic',
        apiKey: 'sk-b',
        modelId: 'shared-model',
      });
    });

    const pushed = maker.exportHrbuddyModels.mock.calls.at(-1)?.[0] as Array<Record<string, unknown>>;
    expect(pushed).toHaveLength(2);
    // 两行身份不同（稳定句柄），上游 modelId 相同且都保留。
    expect(pushed.map((row) => row.id)).toEqual(['shared-model', 'shared-model-2']);
    expect(pushed.map((row) => row.modelId)).toEqual(['shared-model', 'shared-model']);
    expect(pushed.map((row) => row.baseUrl)).toEqual([
      'https://a.example/anthropic',
      'https://b.example/anthropic',
    ]);
  });
});
