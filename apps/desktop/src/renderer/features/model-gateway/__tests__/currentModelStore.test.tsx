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

/** 探针：暴露发送路径读到的路由与加载态（useCurrentModelRoute）+ 当前模型 id + setCurrent。 */
function renderRouteProbe() {
  let api: ModelGatewayApi | null = null;
  let setCurrent: ((id: string) => void) | null = null;
  let routeState: ReturnType<typeof useCurrentModelRoute> | null = null;
  function Probe() {
    api = useModelGateway();
    const current = useCurrentModel();
    setCurrent = current.setCurrent;
    routeState = useCurrentModelRoute();
    return (
      <div>
        <div data-testid="current-id">{current.currentId ?? 'null'}</div>
        <div data-testid="route-provider">{routeState.route?.providerId ?? 'null'}</div>
        <div data-testid="route-model">{routeState.route?.modelId ?? 'null'}</div>
        <div data-testid="route-loading">{routeState.loading ? 'true' : 'false'}</div>
      </div>
    );
  }
  const view = render(
    <ModelGatewayProvider>
      <Probe />
    </ModelGatewayProvider>,
  );
  return {
    getApi: () => api!,
    setCurrent: (id: string) => setCurrent!(id),
    getRoute: () => routeState!.route,
    getLoading: () => routeState!.loading,
    unmount: () => view.unmount(),
  };
}

/** 最小新表单供应商视图（与 modelGatewayStore.test.ts 的 userProviderView 同形）。 */
function gatewayProviderView(providerId: string, modelId: string): ProviderView {
  return {
    id: providerId,
    name: modelId,
    source: 'user',
    agents: ['claude-code'],
    auth: { method: 'apiKey' },
    connected: true,
    routing: {
      'claude-code': {
        upstream: 'https://gw.example/anthropic',
        wireProtocol: 'anthropic-messages',
      },
    },
    models: {
      'claude-code': [
        { id: modelId, name: modelId, catalogPresetId: 'hrbuddy-gateway' },
      ],
    },
  } as unknown as ProviderView;
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

    // 首个可用模型自动成为当前模型（插入序首条 = 先加的 a），发送路径先读到 a。
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

  it('keeps the persisted current model across the loading window and remounts', async () => {
    // 手动结算的 listProviders：拉宽「条目表尚未 hydrate」的加载窗口，不真实等待。
    const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const fixtures = (): { providers: ProviderView[] } => ({
      providers: [gatewayProviderView('seed-a', 'a'), gatewayProviderView('seed-b', 'b')],
    });

    const firstLoad = deferred<{ providers: ProviderView[] }>();
    maker.listProviders = vi.fn(() => firstLoad.promise);
    const first = renderRouteProbe();
    await act(async () => {
      firstLoad.resolve(fixtures());
    });

    // 用户选中**非首位**条目（modelId 升序时 a 在前，选的是 b）。
    await act(async () => {
      first.setCurrent('seed-b');
    });
    expect(screen.getByTestId('current-id').textContent).toBe('seed-b');
    expect(window.localStorage.getItem(CURRENT_MODEL_STORAGE_KEY)).toBe('seed-b');
    first.unmount();

    // remount（ChatInput 自挂 Provider / 重启后首挂是同一形态）：又一轮加载窗口。
    // 「还没读到」不得当成「没有可用模型」——旧实现会在这里把 currentId 刷成 null
    // 并抹掉 localStorage（review Important 1）。
    const secondLoad = deferred<{ providers: ProviderView[] }>();
    maker.listProviders = vi.fn(() => secondLoad.promise);
    renderRouteProbe();
    expect(screen.getByTestId('current-id').textContent).toBe('seed-b');
    expect(window.localStorage.getItem(CURRENT_MODEL_STORAGE_KEY)).toBe('seed-b');

    await act(async () => {
      secondLoad.resolve(fixtures());
    });
    // 落定后仍是用户选的那条（不是按 modelId 排序的第一个 enabled）。
    expect(screen.getByTestId('current-id').textContent).toBe('seed-b');
    expect(window.localStorage.getItem(CURRENT_MODEL_STORAGE_KEY)).toBe('seed-b');
  });

  // 回归钉（冷启动水合竞态，2026-11-01）：条目表未 hydrate、currentId 解析不出时，
  // route 的 null 是「还没读到」不是「无模型」——必须显式 loading，发送路径才能在
  // 窗口内等待，而不是把内置默认模型顶替用户配置的网关模型（chatInputModelLoading
  // 的 test_send_during_cold_start_hydration… 即本合同的消费者）。
  it('reports route loading instead of a misleading no-model null during the hydration window', async () => {
    const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const firstLoad = deferred<{ providers: ProviderView[] }>();
    maker.listProviders = vi.fn(() => firstLoad.promise);
    const probe = renderRouteProbe();

    // 用户此前已选中 seed-b（stored currentId 在场、条目表还在路上）。
    await act(async () => {
      probe.setCurrent('seed-b');
    });
    expect(probe.getRoute()).toBeNull();
    expect(probe.getLoading()).toBe(true);
    expect(screen.getByTestId('route-loading').textContent).toBe('true');

    // 水合落定 → 路由解析出 (providerId, modelId)，加载态结束。
    await act(async () => {
      firstLoad.resolve({ providers: [gatewayProviderView('seed-a', 'a'), gatewayProviderView('seed-b', 'b')] });
    });
    expect(probe.getRoute()).toEqual({ providerId: 'seed-b', modelId: 'b' });
    expect(probe.getLoading()).toBe(false);
    expect(screen.getByTestId('route-loading').textContent).toBe('false');
  });
});
