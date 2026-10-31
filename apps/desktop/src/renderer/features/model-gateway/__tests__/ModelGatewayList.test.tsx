/** @vitest-environment jsdom */

/**
 * ModelGatewayList — 右栏模型列表：按 modelId 升序渲染、状态点、启停开关、
 * 删除确认与行内重测。
 *
 * 走真实生产入口：`ModelGatewayList`/`ModelGatewayRow` 挂在真实
 * `ModelGatewayProvider`（Task 1 store）与共享 `ConfirmDialogProvider` 下，
 * 只在 IPC 边界打桩（`window.electronAPI.maker.*` / `safeStorageRead`，
 * 与 modelGatewayStore.test.ts 同法）。重测走真实 `testModelConnectivity`
 * → `maker.testProviderConnection`。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { ModelGatewayProvider, useModelGateway } from '../ModelGatewayStore';
import type { ModelGatewayApi } from '../types';
import { ModelGatewayList } from '../ModelGatewayList';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

interface MakerMock {
  listProviders: ReturnType<typeof vi.fn>;
  createCustomProvider: ReturnType<typeof vi.fn>;
  updateCustomProvider: ReturnType<typeof vi.fn>;
  deleteCustomProvider: ReturnType<typeof vi.fn>;
  testProviderConnection: ReturnType<typeof vi.fn>;
}

let maker: MakerMock;
let safeStorageRead: ReturnType<typeof vi.fn>;

/** 拿 store API 的探针 + 被测列表，共享同一个 ModelGatewayProvider 实例。 */
function renderList() {
  let api: ModelGatewayApi | null = null;
  function Probe() {
    api = useModelGateway();
    return null;
  }
  render(
    <ConfirmDialogProvider>
      <ModelGatewayProvider>
        <Probe />
        <ModelGatewayList onAdd={() => {}} onEdit={() => {}} />
      </ModelGatewayProvider>
    </ConfirmDialogProvider>,
  );
  return { getApi: () => api! };
}

async function addModel(api: ModelGatewayApi, modelId: string) {
  await act(async () => {
    await api.add({
      baseUrl: 'https://gw.example/anthropic',
      apiKey: `sk-${modelId}`,
      modelId,
    });
  });
}

describe('ModelGatewayList', () => {
  beforeEach(() => {
    window.localStorage.clear();
    maker = {
      listProviders: vi.fn(async () => ({ providers: [] as ProviderView[] })),
      createCustomProvider: vi.fn(async () => ({ ok: true })),
      updateCustomProvider: vi.fn(async () => ({ ok: true })),
      deleteCustomProvider: vi.fn(async () => ({ ok: true })),
      testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 128 })),
    };
    safeStorageRead = vi.fn(async () => 'sk-test');
    window.electronAPI = {
      maker,
      safeStorageRead,
    } as unknown as typeof window.electronAPI;
  });

  afterEach(cleanup);

  it('renders rows sorted by model id ascending with a status dot per row', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'b');
    await addModel(getApi(), 'a');

    const rows = screen.getAllByTestId('model-gateway-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('a')).toBeTruthy();
    expect(within(rows[1]!).getByText('b')).toBeTruthy();
    // 每行一个状态点。
    expect(screen.getAllByTestId('model-gateway-status-dot')).toHaveLength(2);
  });

  it('toggle hides the entry from the chat list without dropping the config', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');

    await act(async () => {
      fireEvent.click(screen.getByRole('switch'));
    });

    // 配置不丢：条目仍在列表里，只是 enabled 翻成 false（聊天菜单读的正是它）。
    expect(within(screen.getByTestId('model-gateway-row')).getByText('a')).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(getApi().entries[0]!.enabled).toBe(false);
    expect(maker.deleteCustomProvider).not.toHaveBeenCalled();
  });

  it('delete asks for confirmation and then removes the entry', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');

    fireEvent.click(
      within(screen.getByTestId('model-gateway-row')).getByRole('button', {
        name: 'settings.providers.modelGateway.delete',
      }),
    );
    // 确认框先出现，条目此时尚未被删。
    await screen.findByText('settings.providers.modelGateway.deleteConfirm.title');
    expect(maker.deleteCustomProvider).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.providers.modelGateway.deleteConfirm.confirm',
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('model-gateway-row')).toBeNull());
    expect(maker.deleteCustomProvider).toHaveBeenCalledWith('a');
  });

  it('retest updates the row status to the probe result', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');
    // 未测试态：还没有延迟文本。
    expect(screen.queryByText('128ms')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.providers.modelGateway.retest' }),
    );

    await waitFor(() => expect(screen.getByText('128ms')).toBeTruthy());
    expect(maker.testProviderConnection).toHaveBeenCalledTimes(1);
  });
});
