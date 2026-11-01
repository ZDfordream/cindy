/** @vitest-environment jsdom */

/**
 * ChatModelMenu — 聊天输入框右下角的模型菜单（设计稿 §5.3）+ 全局当前模型。
 *
 * 走真实生产入口：真实 `ModelGatewayProvider`（Task 1 store）+ 真实
 * `useCurrentModel`（currentModelStore：全局单一值 + localStorage），只在 IPC 边界
 * 打桩（`window.electronAPI.maker.*`，与 ModelGatewayList.test.tsx 同法）。
 *
 * 核心验收（Review Focus #4 / #5）：
 * - 当前模型被删除 / 关闭后**必须回落**到第一个 enabled 条目——聊天不得指向
 *   不存在 / 不可用的模型；
 * - 空列表空态必须**指向「添加模型」**。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ProviderView } from '@cindy/model-providers';

import { ModelGatewayProvider, useModelGateway } from '../ModelGatewayStore';
import { CURRENT_MODEL_STORAGE_KEY, useCurrentModel } from '../currentModelStore';
import { __testing as hrOaStoreTesting } from '@/features/hr-oa-auth/hrOaAuthStore';
import { ChatModelMenu } from '../ChatModelMenu';
import type { ModelGatewayApi } from '../types';

// 菜单断言的是用户可见文案（简报点名「添加模型」「去设置」），mock 词典给出真实
// zh-CN 文案；未列到的 key 原样返回，便于定位。
const COPY: Record<string, string> = {
  'settings.providers.modelGateway.add': '添加模型',
  'settings.providers.modelGateway.untested': '未测试',
  'settings.providers.modelGateway.failed': '连不上',
  'newChat.chatModelMenu.openSettings': '去设置',
  'newChat.chatModelMenu.empty': '还没有可用的模型',
  'newChat.chatModelMenu.placeholder': '选择模型',
  'newChat.chatModelMenu.triggerAria': '选择模型',
};
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => COPY[key] ?? key }),
}));

interface MakerMock {
  listProviders: ReturnType<typeof vi.fn>;
  createCustomProvider: ReturnType<typeof vi.fn>;
  updateCustomProvider: ReturnType<typeof vi.fn>;
  deleteCustomProvider: ReturnType<typeof vi.fn>;
  exportHrbuddyModels: ReturnType<typeof vi.fn>;
  testProviderConnection: ReturnType<typeof vi.fn>;
}

let maker: MakerMock;
let safeStorageRead: ReturnType<typeof vi.fn>;

/** 探针：暴露 store API + 当前模型 id，与菜单共享同一个 ModelGatewayProvider。 */
function renderMenu() {
  let api: ModelGatewayApi | null = null;
  function Probe() {
    api = useModelGateway();
    const { currentId } = useCurrentModel();
    return <div data-testid="current-id">{currentId ?? 'null'}</div>;
  }
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
  }
  render(
    <MemoryRouter initialEntries={['/cc-agent/new']}>
      <ModelGatewayProvider>
        <Probe />
        <LocationProbe />
        <ChatModelMenu />
      </ModelGatewayProvider>
    </MemoryRouter>,
  );
  return { getApi: () => api! };
}

function currentIdText(): string {
  return screen.getByTestId('current-id').textContent ?? '';
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

function triggerButton(): HTMLElement {
  return screen.getByRole('button', { name: '选择模型' });
}

async function openMenu() {
  await act(async () => {
    fireEvent.click(triggerButton());
  });
}

describe('ChatModelMenu', () => {
  beforeEach(() => {
    window.localStorage.clear();
    hrOaStoreTesting.resetHrOaGateMemory();
    maker = {
      listProviders: vi.fn(async () => ({ providers: [] as ProviderView[] })),
      createCustomProvider: vi.fn(async () => ({ ok: true })),
      updateCustomProvider: vi.fn(async () => ({ ok: true })),
      deleteCustomProvider: vi.fn(async () => ({ ok: true })),
      exportHrbuddyModels: vi.fn(async () => undefined),
      testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 128 })),
    };
    safeStorageRead = vi.fn(async () => 'sk-test');
    window.electronAPI = {
      maker,
      safeStorageRead,
    } as unknown as typeof window.electronAPI;
  });

  afterEach(cleanup);

  it('lists only enabled models with status and marks the current one', async () => {
    const { getApi } = renderMenu();
    await act(async () => {});
    const idA = await addModel(getApi(), 'a');
    await addModel(getApi(), 'b');
    const idC = await addModel(getApi(), 'c');
    await act(async () => {
      getApi().setStatus(idA, { ok: true, latencyMs: 128 });
      await getApi().toggle(idC, false);
    });

    await openMenu();

    // disabled 条目不出现；只列 enabled。
    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(2);
    const menu = screen.getByTestId('chat-model-menu');
    expect(within(menu).queryByText('c')).toBeNull();
    expect(within(menu).getByText('a')).toBeTruthy();
    expect(within(menu).getByText('b')).toBeTruthy();
    // 每项带状态：已连通显示延迟，未测试显示「未测试」。
    expect(within(menu).getByText('128ms')).toBeTruthy();
    expect(within(menu).getByText('未测试')).toBeTruthy();
    // 当前选中打勾（首个 enabled 自动成为当前模型，按 modelId 升序 = a）。
    expect(rows[0]!.getAttribute('aria-selected')).toBe('true');
    expect(rows[1]!.getAttribute('aria-selected')).toBe('false');
    expect(currentIdText()).toBe(idA);
  });

  it('offline（HR OA 离线只读）：菜单行连通展示回落「未测试」，不显陈旧绿', async () => {
    // Finding 2 / 设计 §4.2：offline 时模型连通状态标记为未知——行内状态与触发胶囊
    // 都用未测试展示，不把上次探测的 128ms 绿当现状（与 ModelGatewayRow 同口径）。
    hrOaStoreTesting.resetHrOaGateMemory();
    const { getApi } = renderMenu();
    await act(async () => {});
    const idA = await addModel(getApi(), 'a');
    await act(async () => {
      await getApi().setStatus(idA, { ok: true, latencyMs: 128 });
    });
    await openMenu();
    expect(within(screen.getByTestId('chat-model-menu')).getByText('128ms')).toBeTruthy();

    act(() => {
      hrOaStoreTesting.landHrOaState({
        status: 'offline',
        accountKey: 'P100',
        profile: {
          name: '',
          loginName: '',
          dept: '',
          mobile: '',
          email: '',
          title: '',
          sex: '',
          personId: 'P100',
        },
      });
    });
    await act(async () => {});

    const menu = screen.getByTestId('chat-model-menu');
    expect(within(menu).queryByText('128ms')).toBeNull();
    expect(within(menu).getByText('未测试')).toBeTruthy();
  });

  it('switching the model updates the global current model and applies to later messages', async () => {
    const { getApi } = renderMenu();
    await act(async () => {});
    await addModel(getApi(), 'a');
    const idB = await addModel(getApi(), 'b');

    await openMenu();
    const rows = screen.getAllByRole('option');
    await act(async () => {
      fireEvent.click(rows[1]!);
    });

    // 全局当前模型换成第二条（后续消息生效；已发送的不回溯）。
    expect(currentIdText()).toBe(idB);
    expect(window.localStorage.getItem(CURRENT_MODEL_STORAGE_KEY)).toBe(idB);
    // 菜单里当前项打勾跟着换。
    await openMenu();
    const after = screen.getAllByRole('option');
    expect(after[0]!.getAttribute('aria-selected')).toBe('false');
    expect(after[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('current model falls back when the selected entry is removed or disabled', async () => {
    const { getApi } = renderMenu();
    await act(async () => {});
    const idA = await addModel(getApi(), 'a');
    const idB = await addModel(getApi(), 'b');

    await openMenu();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('option')[1]!);
    });
    expect(currentIdText()).toBe(idB);

    // 删当前 → 回落到第一个 enabled。
    await act(async () => {
      await getApi().remove(idB);
    });
    await waitFor(() => expect(currentIdText()).toBe(idA));

    // 关闭当前 → 同样回落。
    const idC = await addModel(getApi(), 'c');
    await openMenu();
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole('option').find((row) => row.textContent?.includes('c'))!,
      );
    });
    expect(currentIdText()).toBe(idC);
    await act(async () => {
      await getApi().toggle(idC, false);
    });
    await waitFor(() => expect(currentIdText()).toBe(idA));
  });

  it('empty state points to 添加模型', async () => {
    renderMenu();
    await act(async () => {});

    await openMenu();

    // 无 enabled 模型：空态文案明确指向「添加模型」。
    const menu = screen.getByTestId('chat-model-menu');
    expect(menu.textContent).toContain('添加模型');
  });

  it('menu footer offers 去设置', async () => {
    const { getApi } = renderMenu();
    await act(async () => {});
    await addModel(getApi(), 'a');

    await openMenu();

    // 菜单底部一行弱链「去设置」。
    const link = within(screen.getByTestId('chat-model-menu')).getByText('去设置');
    expect(link).toBeTruthy();
    // 弱链可跳：设置 → 模型供应商。
    await act(async () => {
      fireEvent.click(link);
    });
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=providers');
  });
});
