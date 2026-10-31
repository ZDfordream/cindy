// @vitest-environment jsdom

/**
 * ProvidersSection(双栏重构)关键不变量:
 *   1. 首个可见供应商默认选中;未连接的内置渠道不再常驻占行。
 *   2. 本机 CLI 检测命中且渠道未连接时,左栏出现建议行,点击直达自定义连接表单。
 *   3. 左栏可见项顺序持久化（首记录、方向键排序、权威快照去乐观、换 owner 重记）。
 *
 * 【Task 7 处置】旧多供应商详情块（含 UnifiedModelList 的模型开关与「获取模型列表」
 * 刷新入口）已整体藏进 SHOW_LEGACY_PROVIDER_UI（owner「藏起来以后再说」）。原双栏
 * 管理用例里断言该块的（语音/模型清单/刷新/可见性开关等）按工程约定 §3.2 裁剪，
 * 逐条依据见各处就地注释；完整断言见 git history，恢复开关即可找回。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';

const {
  refreshBuiltinModelsSpy,
  requestAutoRefreshSpy,
  setProviderOrderSpy,
  refetchProvidersSpy,
  confirmSpy,
  authState,
  providerSnapshotState,
  wizardSpy,
} = vi.hoisted(() => ({
  refreshBuiltinModelsSpy: vi.fn(async () => ({ ok: true, providerId: 'xd' as const })),
  requestAutoRefreshSpy: vi.fn(async () => ({ ok: true as const })),
  setProviderOrderSpy: vi.fn(async () => ({ ok: true as const })),
  refetchProvidersSpy: vi.fn(),
  confirmSpy: vi.fn(async () => false),
  authState: { dataOwnerId: 'owner-1' as string | null },
  providerSnapshotState: {
    dataOwnerId: 'owner-1' as string | null,
    ownerGeneration: 1,
    order: ['anthropic', 'xd', 'custom'],
    customConnected: true,
    mediaReady: false,
    customOverride: null as ProviderView | null,
    loading: false,
    error: null as { reason: 'storage-quota' } | null,
  },
  wizardSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === 'settings.providers.models.manage.selected' ? `${key}:${options?.count}` : key,
    i18n: { language: 'zh-CN' },
  }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => {
    const providers = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: {},
        models: {
          'claude-code': [
            {
              id: 'claude-sonnet-5',
              name: 'Sonnet 5',
              contextWindow: 200_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
        connected: false,
      } satisfies ProviderView,
      {
        id: 'xd',
        name: 'XD Gateway',
        source: 'builtin',
        agents: ['claude-code', 'codex'],
        auth: { method: 'managed' },
        routing: {},
        models: { 'claude-code': [], codex: [] },
        connected: false,
      } satisfies ProviderView,
      {
        id: 'custom',
        name: 'Custom',
        source: 'user',
        agents: ['codex'],
        auth: { method: 'apiKey' },
        routing: {},
        models: {
          codex: [
            {
              id: 'custom-model',
              name: 'Custom model',
              contextWindow: 128_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
        connected: providerSnapshotState.customConnected,
        imageModels: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
        availableMediaModelIds: providerSnapshotState.mediaReady ? ['gpt-image-2'] : [],
      } satisfies ProviderView,
    ];
    const byId = new Map<string, ProviderView>(providers.map((provider) => [provider.id, provider]));
    if (providerSnapshotState.customOverride) {
      byId.delete('custom');
      byId.set(providerSnapshotState.customOverride.id, providerSnapshotState.customOverride);
    }
    return {
      providers:
        providerSnapshotState.dataOwnerId === authState.dataOwnerId && !providerSnapshotState.loading ? [...byId.values()] : [],
      providerOrder:
        providerSnapshotState.dataOwnerId === authState.dataOwnerId
          ? providerSnapshotState.order
          : [],
      ownerGeneration:
        providerSnapshotState.dataOwnerId === authState.dataOwnerId
          ? providerSnapshotState.ownerGeneration
          : null,
      loading: providerSnapshotState.dataOwnerId !== authState.dataOwnerId || providerSnapshotState.loading,
      error: providerSnapshotState.error,
      refetch: refetchProvidersSpy,
    };
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    mode: 'cloud',
    dataOwnerId: authState.dataOwnerId,
    exitLocalMode: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  isChatGptConnectionConnected: () => false,
  useCodexAuth: () => ({
    state: { kind: 'unauthenticated' },
    triggerLogin: vi.fn(),
    cancelLogin: vi.fn(),
    logout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ key: '', hasSavedKey: false, clearKey: vi.fn() }),
}));

vi.mock('@/hooks/useModelAccessStatus', () => ({
  useModelAccessStatus: () => ({ state: 'failed', source: null, endpoint: null }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: confirmSpy }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/customProviders', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/customProviders')>(),
  deleteCustomProvider: vi.fn(),
  readCustomProviderKey: vi.fn(async () => null),
  updateCustomProvider: vi.fn(),
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'X',
}));

vi.mock('@/lib/providerSubtitle', () => ({
  customProviderSubtitleForDisplay: () => '',
  providerSubtitleForDisplay: () => 'XD Gateway',
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  setModelVisibilities: vi.fn(),
  setModelVisibility: vi.fn(),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/components/settings/ProviderConnectionDialog', () => ({
  ProviderConnectionDialog: () => React.createElement('div', { 'data-testid': 'custom-provider-dialog-stub' }),
}));

// 2026-10-29 需求 6:多供应商向导已移除;建议行打开自定义连接表单。

import { updateCustomProvider } from '@/lib/customProviders';

import { ProvidersSection } from '@/components/settings/ProvidersSection';

type ScanResult = { detections: unknown[] };
let scanResult: ScanResult;

beforeEach(() => {
  authState.dataOwnerId = 'owner-1';
  providerSnapshotState.dataOwnerId = 'owner-1';
  providerSnapshotState.ownerGeneration = 1;
  providerSnapshotState.customConnected = true;
  providerSnapshotState.mediaReady = false;
  providerSnapshotState.customOverride = null;
  providerSnapshotState.loading = false;
  providerSnapshotState.error = null;
  providerSnapshotState.order = ['anthropic', 'xd', 'custom'];
  scanResult = { detections: [] };
  confirmSpy.mockReset().mockResolvedValue(false);
  vi.mocked(updateCustomProvider).mockResolvedValue({ ok: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      scanLocalCli: vi.fn(async () => scanResult),
      refreshBuiltinProviderModels: refreshBuiltinModelsSpy,
      requestProviderModelsAutoRefresh: requestAutoRefreshSpy,
      setProviderOrder: setProviderOrderSpy,
      onProviderOAuthProgress: vi.fn(() => () => {}),
      // ModelGatewayProvider(右栏模型列表)挂载即读条目清单。
      listProviders: vi.fn(async () => ({ providers: [] })),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — 双栏管理', () => {
  // （原 miniMaxConfig / selectSpeechProvider 语音夹具随下方用例一并裁剪；git history 可找回。）
  // 以下语音/模型清单用例（manual refresh handles %s speech / Server-only speech /
  // respects current Registry audio / unconfirmed proxy-oauth-disabled-route /
  // moves manual speech additions / empty speech connection suspend-resume /
  // does not supplement a reference across runtimes / speech out of native subscription /
  // discovery fails HTTP %s / confirms speech refresh Host changes）——裁剪：断言经
  // 隐藏的 UnifiedModelList（含「获取模型列表」刷新入口）触发，默认生产面不可达
  // （工程约定 §3.2「测试须验生产可达行为」）。完整断言见 git history。
  it('keeps a recovery action accessible when the first complete catalog could not be published', async () => {
    providerSnapshotState.loading = true;
    providerSnapshotState.error = { reason: 'storage-quota' };
    refetchProvidersSpy.mockResolvedValue(true);
    render(<MemoryRouter><ProvidersSection /></MemoryRouter>);
    expect(screen.getByRole('status').textContent).toContain('catalogRecovery.quota');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'settings.providers.catalogRecovery.retry' }));
    });
    expect(refetchProvidersSpy).toHaveBeenCalledOnce();
    expect(screen.queryByRole('switch', { name: 'Custom model' })).toBeNull();
  });

  // 「%s can refresh models using its saved %s connection / dims GPT Image 2 without
  // a ready image channel / keeps selections but blocks toggles when a connected
  // source becomes unavailable」——裁剪：模型刷新与可见性开关在隐藏的
  // UnifiedModelList 里，默认面不可达（§3.2）；完整断言见 git history。
  // Task 7 改写：详情头折行布局与「零模型仍可手动刷新」都在隐藏的旧详情块里（§3.2 裁去，
  // 见 git history）。生产可达部分保留：自动刷新调度、左栏品牌行、未连接内置渠道不占行。
  it('首个可见供应商默认选中;未连接内置渠道不占行;旧详情块默认隐藏', async () => {
    // ProvidersSection 内部消费 useSearchParams(深链定位),测试需要 Router 上下文。
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
    expect(requestAutoRefreshSpy).toHaveBeenCalledWith('providers-open');

    // 左栏保留品牌翻译。
    expect(
      (await screen.findAllByText('settings.providers.xd.title')).length,
    ).toBeGreaterThanOrEqual(1);
    // 未连接的 Anthropic 不出现在左栏(无检测建议时整页不出现)。
    expect(screen.queryByText('Anthropic')).toBeNull();
    // 旧详情块（身份头 + 模型工具行/刷新入口）默认不渲染。
    expect(screen.queryByTestId('provider-detail-identity')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' })).toBeNull();
  });

  // 「同一事件循环内连续点击刷新只启动一个请求 / 内置刷新失败按错误码区分文案」——
  // 裁剪：「获取模型列表」刷新入口在隐藏的 UnifiedModelList 里，默认面不可达（§3.2）。
  it('检测到本机 CLI 且渠道未连接 → 建议行出现,点击打开自定义连接表单', async () => {
    scanResult = {
      detections: [
        { cli: 'claude-cli', providerId: 'anthropic', installed: true, loggedIn: true },
        { cli: 'codex-cli', providerId: 'openai', installed: false, loggedIn: false },
      ],
    };
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    // 建议组标签 + Anthropic 建议行(codex 未安装不出现)。
    expect(await screen.findByText('settings.providers.detect.groupLabel')).not.toBeNull();
    const action = screen.getByText('settings.providers.detect.action');
    fireEvent.click(action.closest('button')!);

    // 向导已移除,点击建议行打开自定义连接表单(2026-10-29 需求 6)。
    expect(screen.getByTestId('custom-provider-dialog-stub')).not.toBeNull();
  });

  it('首次记录可见项，并用方向键提交新的可见顺序', async () => {
    providerSnapshotState.order = ['anthropic', 'xd'];
    const view = render(
      React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)),
    );

    const handles = await screen.findAllByRole('button', {
      name: 'settings.providers.order.handle',
    });
    expect(setProviderOrderSpy).toHaveBeenCalledWith('owner-1', 1, ['custom']);
    await act(async () => {
      fireEvent.keyDown(handles[0]!, { key: 'ArrowDown' });
      await Promise.resolve();
    });
    // Renderer 只提交左栏顺序；Main 负责保留曾出现但当前隐藏的供应商槽位。
    expect(setProviderOrderSpy).toHaveBeenLastCalledWith('owner-1', 1, ['custom', 'xd']);
    const selectedRows = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'true');
    expect(selectedRows).toHaveLength(1);
    expect(selectedRows[0]?.textContent).toContain('settings.providers.xd.title');
    expect(screen.queryByRole('button', { name: 'settings.providers.order.reset' })).toBeNull();

    // Main 对未观察隐藏项的权威结果会把它放到末尾。pending 只比较左栏可见顺序，
    // 收到该快照后应清除；后续 Main 顺序变化不得再被旧乐观状态覆盖。
    await act(async () => {
      providerSnapshotState.order = ['custom', 'xd', 'anthropic'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    await act(async () => {
      providerSnapshotState.order = ['xd', 'custom', 'anthropic'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    const providerRows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(providerRows[0]?.textContent).toContain('settings.providers.xd.title');
    expect(providerRows[1]?.textContent).toContain('Custom');
  });

  it('已有顺序快照挂载时不自动回写，避免旧窗口覆盖显式排序', async () => {
    providerSnapshotState.order = ['anthropic', 'custom', 'xd'];
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    await screen.findAllByRole('button', {
      name: 'settings.providers.order.handle',
    });
    expect(setProviderOrderSpy).not.toHaveBeenCalled();
  });

  it('写入结束后的同目录权威快照会结束乐观排序，以另一窗口的后写结果为准', async () => {
    let resolveOrderWrite!: (value: { ok: true }) => void;
    const orderWrite = new Promise<{ ok: true }>((resolve) => {
      resolveOrderWrite = resolve;
    });
    setProviderOrderSpy.mockReturnValueOnce(orderWrite);
    const view = render(
      React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)),
    );

    const handles = await screen.findAllByRole('button', {
      name: 'settings.providers.order.handle',
    });
    fireEvent.keyDown(handles[0]!, { key: 'ArrowDown' });
    let providerRows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(providerRows[0]?.textContent).toContain('Custom');
    expect(providerRows[1]?.textContent).toContain('settings.providers.xd.title');

    await act(async () => {
      resolveOrderWrite({ ok: true });
      await orderWrite;
      await Promise.resolve();
    });
    expect(refetchProvidersSpy).toHaveBeenCalledOnce();

    // B 窗口后写成为 Main 最终顺序；目录成员没变，但新快照必须结束 A 的 pending。
    await act(async () => {
      providerSnapshotState.order = ['anthropic', 'xd', 'custom'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    providerRows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-current'));
    expect(providerRows[0]?.textContent).toContain('settings.providers.xd.title');
    expect(providerRows[1]?.textContent).toContain('Custom');
  });

  it('切换数据 owner 后会按新 owner 重新记录可见项', async () => {
    providerSnapshotState.order = ['anthropic', 'xd'];
    const view = render(
      React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)),
    );
    await waitFor(() => {
      expect(setProviderOrderSpy).toHaveBeenCalledWith('owner-1', 1, ['custom']);
    });
    setProviderOrderSpy.mockClear();

    await act(async () => {
      authState.dataOwnerId = 'owner-2';
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    expect(setProviderOrderSpy).not.toHaveBeenCalled();

    await act(async () => {
      providerSnapshotState.dataOwnerId = 'owner-2';
      providerSnapshotState.ownerGeneration = 2;
      providerSnapshotState.order = ['xd'];
      view.rerender(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(setProviderOrderSpy).toHaveBeenCalledWith('owner-2', 2, ['custom']);
    });
  });
});
