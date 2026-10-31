/** @vitest-environment jsdom */

/**
 * currentModelStore —— 全局当前模型与**发送路径路由**（Ruling 18）。
 *
 * 走真实生产入口：真实 `ModelGatewayProvider`（Task 1 store）+ 真实
 * `useCurrentModel` / `useCurrentModelRoute`（ChatInput 发送路径读的正是后者），
 * 只在 IPC 边界打桩（与 ChatModelMenu.test.tsx 同法）。
 *
 * Ruling 18 钉子：`setCurrent(id)` 之后，发送路径读到的值就是这个 `id`
 * （= 稳定句柄，直接作为发送的 providerId；modelId 为该条目的上游模型）。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { ModelGatewayProvider, useModelGateway } from '../ModelGatewayStore';
import {
  CURRENT_MODEL_STORAGE_KEY,
  useCurrentModel,
  useCurrentModelRoute,
  type CurrentModelRoute,
} from '../currentModelStore';
import type { ModelGatewayApi } from '../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

interface MakerMock {
  listProviders: ReturnType<typeof vi.fn>;
  createCustomProvider: ReturnType<typeof vi.fn>;
  updateCustomProvider: ReturnType<typeof vi.fn>;
  deleteCustomProvider: ReturnType<typeof vi.fn>;
  exportHrbuddyModels: ReturnType<typeof vi.fn>;
  testProviderConnection: ReturnType<typeof vi.fn>;
}

let maker: MakerMock;

/** 探针：暴露发送路径读到的路由（useCurrentModelRoute）+ setCurrent。 */
function renderRouteProbe() {
  let api: ModelGatewayApi | null = null;
  let setCurrent: ((id: string) => void) | null = null;
  let route: CurrentModelRoute | null = null;
  function Probe() {
    api = useModelGateway();
    const current = useCurrentModel();
    setCurrent = current.setCurrent;
    route = useCurrentModelRoute();
    return (
      <div>
        <div data-testid="route-provider">{route?.providerId ?? 'null'}</div>
        <div data-testid="route-model">{route?.modelId ?? 'null'}</div>
      </div>
    );
  }
  render(
    <ModelGatewayProvider>
      <Probe />
    </ModelGatewayProvider>,
  );
  return {
    getApi: () => api!,
    setCurrent: (id: string) => setCurrent!(id),
    getRoute: () => route,
  };
}

async function addModel(api: ModelGatewayApi, modelId: string): Promise<string> {
  let id = '';
  await act(async () => {
    id = await api.add({
      baseUrl: 'https://gw.example/anthropic',
      apiKey: `sk-${modelId}`,
      modelId,
    });
  });
  return id;
}

describe('currentModelStore send route', () => {
  beforeEach(() => {
    window.localStorage.clear();
    maker = {
      listProviders: vi.fn(async () => ({ providers: [] as ProviderView[] })),
      createCustomProvider: vi.fn(async () => ({ ok: true })),
      updateCustomProvider: vi.fn(async () => ({ ok: true })),
      deleteCustomProvider: vi.fn(async () => ({ ok: true })),
      exportHrbuddyModels: vi.fn(async () => undefined),
      testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 128 })),
    };
    window.electronAPI = {
      maker,
      safeStorageRead: vi.fn(async () => 'sk-test'),
    } as unknown as typeof window.electronAPI;
  });

  afterEach(cleanup);

  it('after setCurrent(id) the send path reads that id as its route', async () => {
    const probe = renderRouteProbe();
    await act(async () => {});
    await addModel(probe.getApi(), 'a');
    const idB = await addModel(probe.getApi(), 'b');

    // 首个可用模型自动成为当前模型（modelId 升序 = a），发送路径先读到 a。
    expect(screen.getByTestId('route-provider').textContent).toBe(probe.getApi().entries[0]!.id);
    expect(screen.getByTestId('route-model').textContent).toBe('a');

    // 切到 b：发送路径读到的值就是这个 id（Ruling 18 的钉子）。
    await act(async () => {
      probe.setCurrent(idB);
    });
    expect(screen.getByTestId('route-provider').textContent).toBe(idB);
    expect(screen.getByTestId('route-model').textContent).toBe('b');
    expect(probe.getRoute()).toEqual({ providerId: idB, modelId: 'b' });
    // 持久化的也是稳定 id（跨重启记住上次选的）。
    expect(window.localStorage.getItem(CURRENT_MODEL_STORAGE_KEY)).toBe(idB);
  });

  it('send route falls back together with the current model when the entry goes away', async () => {
    const probe = renderRouteProbe();
    await act(async () => {});
    const idA = await addModel(probe.getApi(), 'a');
    const idB = await addModel(probe.getApi(), 'b');
    await act(async () => {
      probe.setCurrent(idB);
    });
    expect(screen.getByTestId('route-provider').textContent).toBe(idB);

    // 删当前 → 发送路径读到的路由跟着回落（聊天不得指向不存在的模型）。
    await act(async () => {
      await probe.getApi().remove(idB);
    });
    expect(screen.getByTestId('route-provider').textContent).toBe(idA);
    expect(screen.getByTestId('route-model').textContent).toBe('a');
    expect(probe.getRoute()).toEqual({ providerId: idA, modelId: 'a' });
  });
});
