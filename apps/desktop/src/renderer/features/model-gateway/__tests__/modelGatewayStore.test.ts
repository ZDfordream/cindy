/** @vitest-environment jsdom */

/**
 * modelGatewayStore —— 模型条目数据层的增删改查、字母排序与「清空重来」标记过滤。
 *
 * 走真实生产入口：`useModelGateway` → `@/lib/customProviders` 的 create/update/delete
 * 与 `window.electronAPI.maker.listProviders`，只在 IPC 边界打桩（与 customProviders.test.ts
 * 同法）。凭证契约（keys 提交、config / state 不含密钥）在 add 用例里钉住。
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
}

let maker: MakerMock;

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
    };
    vi.stubGlobal('window', { electronAPI: { maker } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds a model and keeps the list sorted by model id ascending', async () => {
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

    expect(addedId).toBe('b');
    expect(result.current.entries).toEqual([
      {
        id: 'a',
        name: 'a',
        baseUrl: 'https://gw.example/anthropic',
        enabled: true,
        status: 'untested',
      },
      {
        id: 'b',
        name: 'b',
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

  it('removes a model and drops it from entries', async () => {
    const { result } = renderGateway();
    await act(async () => {});
    await act(async () => {
      await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'a',
      });
      await result.current.add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-b',
        modelId: 'b',
      });
    });

    await act(async () => {
      await result.current.remove('a');
    });

    expect(result.current.entries.map((entry) => entry.id)).toEqual(['b']);
    expect(maker.deleteCustomProvider).toHaveBeenCalledWith('a');
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
    });

    await act(async () => {
      await result.current.update('model-a', {
        baseUrl: 'https://gw-b.example/anthropic',
        apiKey: 'sk-b',
        modelId: 'model-a',
      });
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]?.id).toBe('model-a');
    expect(result.current.entries[0]?.baseUrl).toBe('https://gw-b.example/anthropic');

    // 同一条存储记录被更新（不是删除重建），input 的 baseUrl / modelId 都写穿进配置。
    const createConfig = maker.createCustomProvider.mock.calls[0][0] as CustomProviderConfig;
    const updateConfig = maker.updateCustomProvider.mock.calls[0][0] as CustomProviderConfig;
    expect(updateConfig.id).toBe(createConfig.id);
    expect(updateConfig.runtimes['claude-code']?.baseUrl).toBe('https://gw-b.example/anthropic');
    expect(updateConfig.runtimes['claude-code']?.models[0]?.id).toBe('model-a');
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

    expect(result.current.entries.map((entry) => entry.id)).toEqual(['model-a']);
  });
});
