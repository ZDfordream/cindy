// @vitest-environment jsdom

/**
 * ProvidersSection — 深链定位(?connect / ?wizard)关键不变量:
 *   1. connect=<内置未占行渠道> → 向导以 builtin entry 直达授权步;URL 参数消费后被清除。
 *   2. connect=<左栏占行供应商>(如已连接的 anthropic)→ 直接选中,不开向导。
 *   3. connect=<目录外 id> → 视为 preset id,向导以 preset entry 打开。
 *   4. wizard=1 → 向导目录第一步(entry undefined)。
 *
 * 【Task 7 处置】旧多供应商详情块（身份/断开/「···」菜单、账户资产、允许被远程调用、
 * 预设/多协议/获取模型列表入口）已整体藏进 SHOW_LEGACY_PROVIDER_UI（owner「藏起来
 * 以后再说」）。断言该块的用例按工程约定 §3.2「测试须验生产可达行为」裁剪或改写，
 * 逐条依据见各处就地注释（被裁用例的完整断言见 git history，恢复开关即可找回）。
 * 保留的用例都只依赖：左栏行（含 aria-current 选中态）、网关表单深链、登录引导面、
 * 分享来的供应商详情——这些不在本次收起范围内。
 */

import { cleanup, fireEvent, act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderShareReceived } from '@cindy/device-link';
import type { ProviderView } from '@cindy/model-providers';

const {
  wizardSpy,
  providersState,
  codexAuthState,
  codexAuthActions,
  toastError,
  setModelVisibilitiesSpy,
  customDialogSpy,
} = vi.hoisted(() => ({
  wizardSpy: vi.fn(),
  providersState: { providers: [] as unknown[], order: [] as string[] },
  codexAuthState: {
    state: { kind: 'unauthenticated' } as Record<string, unknown>,
    reconnectCredentialScope: undefined as string | undefined,
    recoveryCheck: 'idle' as 'idle' | 'checking' | 'failed',
  },
  codexAuthActions: {
    refresh: vi.fn(async () => undefined),
    triggerLogin: vi.fn(async () => 'authenticated'),
    cancelLogin: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  },
  toastError: vi.fn(),
  setModelVisibilitiesSpy: vi.fn(() => true),
  customDialogSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: providersState.providers,
    providerOrder: providersState.order,
    ownerGeneration: 1,
    loading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthUser: () => null,
  useAuth: () => ({ mode: 'local', exitLocalMode: vi.fn(async () => undefined) }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  isChatGptConnectionConnected: (state: { kind?: string; authSource?: string }) =>
    state.kind === 'authenticated' && state.authSource === 'oauth',
  useCodexAuth: () => ({
    ...codexAuthState,
    ...codexAuthActions,
  }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ key: '', hasSavedKey: false, clearKey: vi.fn() }),
}));

vi.mock('@/hooks/useModelAccessStatus', () => ({
  useModelAccessStatus: () => ({ state: 'failed', source: null, endpoint: null }),
}));

const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: confirmSpy }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock('@/lib/customProviders', () => ({
  deleteCustomProvider: vi.fn(),
  providerViewToCustomProviderConfig: (provider: ProviderView) => ({
    id: provider.id,
    name: provider.name,
    auth: provider.auth,
    runtimes: {},
  }),
  readCustomProviderKey: vi.fn(async () => null),
  updateCustomProvider: vi.fn(),
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: () => 'X',
}));

vi.mock('@/lib/providerSubtitle', () => ({
  customProviderSubtitleForDisplay: () => '',
  providerSubtitleForDisplay: () => 'subtitle',
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  setModelVisibilities: setModelVisibilitiesSpy,
  setModelVisibility: vi.fn(),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/components/settings/ProviderConnectionDialog', () => ({
  ProviderConnectionDialog: (props: unknown) => {
    customDialogSpy(props);
    return React.createElement('div', { 'data-testid': 'custom-provider-dialog-stub' });
  },
}));

// 2026-10-29 需求 6:多供应商向导已移除;2026-10-31 模型网关:入口为三栏表单弹窗。
vi.mock('@/features/model-gateway/ModelGatewayForm', () => ({
  ModelGatewayForm: (props: { open?: boolean }) => {
    // 组件常驻挂载、靠 open 显隐;桩只在打开时渲染,断言才与「该不该出现」对齐。
    if (!props.open) return null;
    wizardSpy(props.open);
    return React.createElement('div', { 'data-testid': 'gateway-stub' });
  },
}));


import { ProvidersSection } from '@/components/settings/ProvidersSection';
import { useProviderSubscriptionCard } from '@/components/settings/useProviderSubscriptionCard';
import { resetProviderShareStoreForTests } from '@/features/provider-share/providerShareStore';

vi.mock('@/components/settings/useProviderSubscriptionCard', () => ({
  useProviderSubscriptionCard: vi.fn(() => null),
}));

vi.mock('@/components/settings/LlamaCppProviderDetail', () => ({ LlamaCppProviderDetail: () => null }));

vi.mock('@/components/settings/OllamaProviderDetail', () => ({ OllamaProviderDetail: () => null }));

function makeProvider(id: string, over?: Partial<ProviderView>): ProviderView {
  return {
    id,
    name: id,
    source: 'builtin',
    agents: ['claude-code'],
    auth: { method: 'oauth', oauth: { authorizeUrl: 'https://auth.example.test/authorize', tokenUrl: 'https://auth.example.test/token', clientId: 'fixture', scopes: 'openid' } },
    routing: {},
    models: { 'claude-code': [] },
    connected: false,
    ...over,
  } as unknown as ProviderView;
}

function SearchProbe() {
  const location = useLocation();
  return <div data-testid="search">{location.search}</div>;
}

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <Routes>
        <Route
          path="/settings"
          element={
            <>
              <ProvidersSection />
              <SearchProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useProviderSubscriptionCard).mockReset().mockReturnValue(null);
  confirmSpy.mockReset().mockResolvedValue(true);
  codexAuthState.state = { kind: 'unauthenticated' };
  codexAuthState.reconnectCredentialScope = undefined;
  codexAuthState.recoveryCheck = 'idle';
  providersState.order = [];
  providersState.providers = [
    makeProvider('anthropic', { name: 'Anthropic' }),
    makeProvider('xd', {
      name: 'Cindy AI',
      auth: { method: 'managed' } as ProviderView['auth'],
      agents: ['claude-code', 'codex'],
      models: { 'claude-code': [], codex: [] },
    }),
  ];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      listProviders: vi.fn(async () => ({ providers: providersState.providers, dataOwnerId: 'owner', ownerGeneration: 1 })),
      setProviderPresentation: vi.fn(async () => ({ ok: true })),
      providerOAuthLogout: vi.fn(async () => ({ ok: true })),
      onProviderOAuthProgress: vi.fn(() => () => undefined),
      auth: { logout: codexAuthActions.logout },
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
      llamaCppStatus: vi.fn(async () => ({ installed: false, supported: true, running: false, models: [] })),
      localModelStatus: vi.fn(async () => ({ kind: 'ready' })),
      onLocalModelStatus: vi.fn(() => () => undefined),
      requestProviderModelsAutoRefresh: vi.fn(async () => ({ ok: true })),
      setProviderOrder: vi.fn(async () => ({ ok: true })),
    },
    openChatGPTApp: vi.fn(async () => ({ success: true })),
    builtinApiKeyRemove: vi.fn(async () => undefined),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — 深链定位', () => {
  it('does not rediscover a deleted local Codex provider into the settings list', async () => {
    providersState.providers.push(makeProvider('openai', {
      name: 'Deleted local account', removed: true, imageModels: [{ id: 'image', name: 'Image' }],
    }));
    vi.mocked(window.electronAPI.maker.scanLocalCli).mockResolvedValue({ detections: [{
      cli: 'codex-cli', providerId: 'openai', installed: true, loggedIn: true, sharedWithCindy: false,
    }] });
    renderAt('?tab=providers');
    await waitFor(() => expect(window.electronAPI.maker.scanLocalCli).toHaveBeenCalled());
    expect(screen.queryByText('Deleted local account')).toBeNull();
  });

  // Task 7 改写：生产可达部分是「无模型的原生 Codex 账号仍占左栏一行」（曾有账号从
  // 列表消失的回归）。原断言顺带验详情头的「断开/授权」主操作，按钮在隐藏的旧详情块
  // 里，默认面不可达（工程约定 §3.2），改为断言详情头不渲染。
  it.each([true, false])(
    'keeps a native Codex account without models visible (connected=%s)',
    async (connected) => {
      providersState.providers = [
        makeProvider('openai-account', {
          name: 'OpenAI Work',
          source: 'user',
          agents: ['codex'],
          auth: { method: 'oauth', native: 'codex' },
          models: { codex: [] },
          connected,
        }),
      ];
      renderAt('?tab=providers&connect=openai-account');
      expect(await screen.findByRole('button', { name: /OpenAI Work/ })).toBeTruthy();
      expect(screen.queryByTestId('gateway-stub')).toBeNull();
      expect(screen.queryByTestId('provider-detail-identity')).toBeNull();
    },
  );

  // 「uses the same local header and empty model treatment for llama.cpp」——裁剪：
  // 断言全部落在隐藏的 LocalRuntimeHeader / LlamaCppProviderDetail（旧详情块），
  // 默认面不可达（工程约定 §3.2）；完整断言见 git history。

  // Task 7 改写：详情头已藏，生产可达面只剩左栏行显示保存名；顺带断言详情头不渲染。
  it.each(['anthropic', 'xai', 'cindy-local-ollama', 'cindy-local-llamacpp'])('shows the saved name in the sidebar (detail header hidden) for %s', async (id) => {
    providersState.providers = [makeProvider(id, {
      name: 'My renamed provider', connected: true,
      source: id.startsWith('cindy-local-') ? 'user' : 'builtin',
    })];
    renderAt(`?tab=providers&connect=${id}`);
    expect((await screen.findAllByText('My renamed provider')).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId('provider-detail-identity')).toBeNull();
  });

  // 测试价值
  // - 生产入口与可观察结果：真实 ProvidersSection 渲染；网关条目（custom provider 带
  //   `catalogPresetId: 'hrbuddy-gateway'` 标记）不得出现在左栏行里，但仍出现在右栏
  //   模型列表（ModelGatewayList → model-gateway-row）。
  // - Bug／规则依据：最终全分支 review F1——网关条目即 custom provider，曾整行落进
  //   左栏；点它旧详情门后为 null，只剩高亮、右栏无任何变化（点击无响应）。
  // - 现有覆盖缺口：providersSection* 只验过左栏普通行 / 深链，从未断言网关条目行
  //   的归属（右栏列表才是网关条目唯一入口）。
  // - 最小失败输入：providers 目录里一条带网关标记的 user 条目 + 一条普通内置行。
  // - tier：unit（jsdom 渲染生产组件，无网络 / 真实计时）。
  it('keeps gateway entries out of the left rail while the right model list still lists them', async () => {
    providersState.providers = [
      makeProvider('anthropic', { name: 'Anthropic', connected: true }),
      makeProvider('gw-entry', {
        name: 'gw-model-alpha',
        source: 'user',
        agents: ['claude-code'],
        connected: true,
        models: {
          'claude-code': [
            {
              id: 'gw-model-alpha',
              name: 'gw-model-alpha',
              catalogPresetId: 'hrbuddy-gateway',
              contextWindow: 200_000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
      }),
    ];
    renderAt('?tab=providers');

    // 对照行：普通供应商照常占左栏。
    expect(await screen.findByRole('button', { name: /Anthropic/ })).toBeTruthy();
    // 网关条目行不得进左栏（点它右栏无任何变化）。
    expect(screen.queryByRole('button', { name: /gw-model-alpha/ })).toBeNull();
    // 右栏模型列表仍是网关条目的入口。
    const rows = await screen.findAllByTestId('model-gateway-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('gw-model-alpha');
  });

  // 「keeps identity outside the shared model scroll area for %s」——裁剪：断言全部
  // 落在隐藏的旧详情块（provider-detail-scroll / 模型工具条布局），默认面不可达（§3.2）。
  // 「shows usage windows without a details disclosure across %s changes」——裁剪：
  // provider-usage-module 在隐藏的 DetailHeader 内（同上）。
  // 「added OpenAI shares status and moves rename/delete into the single menu」——裁剪：
  // 「···」菜单契约在隐藏的身份行内（同上）。完整断言见 git history。

  it('renames an account when its sidebar row is double-clicked', async () => {
    providersState.providers = [
      makeProvider('openai-work', {
        name: 'Work account',
        source: 'user',
        agents: ['codex'],
        connected: true,
        auth: { method: 'oauth', native: 'codex' },
        models: { codex: [] },
      }),
    ];
    renderAt('?tab=providers');

    fireEvent.doubleClick(await screen.findByRole('button', { name: /Work account/ }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'settings.providers.pill.rename' }),
    ));
    await waitFor(() => expect(window.electronAPI.maker.setProviderPresentation).toHaveBeenCalledWith(
      {
        providerId: 'openai-work',
        action: 'rename',
        name: 'Work account',
        dataOwnerId: 'owner',
        ownerGeneration: 1,
      },
    ));
  });

  it('does not offer double-click rename for Cindy AI', async () => {
    providersState.providers = [makeProvider('xd', {
      name: 'Cindy AI',
      auth: { method: 'managed' } as ProviderView['auth'],
      agents: ['claude-code', 'codex'],
      models: { 'claude-code': [], codex: [] },
    })];
    renderAt('?tab=providers');

    fireEvent.doubleClick(
      await screen.findByRole('button', { name: 'settings.providers.xd.title' }),
    );

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(window.electronAPI.maker.setProviderPresentation).not.toHaveBeenCalled();
  });

  // 以下用例（API key presence / replacement-key inputs / device-code authorization /
  // OpenAI recovery / cancelled login / Dev 只读断开 / OpenAI deletion 顺序 /
  // busy disconnect 确认 / unsupported builtin 动作面 / generic builtin OAuth bridge /
  // invalidated OpenAI auth 锁模型开关）——裁剪：断言全部落在隐藏的旧详情块
  // （DetailHeader 动作、「···」菜单、UnifiedModelList），默认生产面不可达
  // （工程约定 §3.2「测试须验生产可达行为」）。它们保护的 OAuth/凭证时序契约仍在
  // 代码里，随 SHOW_LEGACY_PROVIDER_UI 恢复即可原样找回（git history）。
  // Task 7 改写：生产可达部分是左栏行呈现失效态（标签 + 失败色）。原断言还点了详情头
  // 的恢复入口（chatgptAuthRecovery.openApp），入口在隐藏的旧详情块里，按 §3.2 裁去
  // （恢复入口断言见 git history）。
  it('ChatGPT 系统共享登录失效时左栏行显示失效态', async () => {
    codexAuthState.state = {
      kind: 'reconnect-required',
      reason: 'token_revoked',
      credentialScope: 'system-shared',
    };
    codexAuthState.reconnectCredentialScope = 'system-shared';
    providersState.providers = [
      makeProvider('openai', {
        name: 'OpenAI',
        agents: ['codex', 'claude-code'],
        connected: false,
        models: { codex: [], 'claude-code': [] },
      }),
    ];
    renderAt('?tab=providers&connect=openai');

    const openAiListRow = await screen.findByRole('button', { name: /OpenAI/ });
    expect(openAiListRow.textContent).toContain('settings.providers.openai.reconnectRequired');
    expect((openAiListRow.lastElementChild as HTMLElement).style.backgroundColor).toBe(
      'var(--remote-status-failed)',
    );
    // 恢复入口在隐藏的详情头里（见上方裁剪说明）。
    expect(screen.queryByTestId('provider-detail-identity')).toBeNull();
  });

  // 「ChatGPT 非共享失效凭证通过浏览器重新登录 / 主动断开后仍使用本机账号连接 /
  // 系统共享打开 App 后保留恢复入口」——裁剪：恢复入口按钮在隐藏的详情头里，
  // 默认面不可达（§3.2）；完整断言见 git history。
  it('connect=anthropic(未占行内置渠道)→ 打开添加模型弹窗;参数消费后清除', async () => {
    renderAt('?tab=providers&connect=anthropic');

    await waitFor(() => expect(screen.queryByTestId('gateway-stub')).not.toBeNull());
    expect(wizardSpy).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  it('connect=<左栏占行供应商> → 直接选中,不开向导', async () => {
    providersState.providers = [
      makeProvider('anthropic', { name: 'Anthropic', connected: true }),
      makeProvider('xd', {
        name: 'Cindy AI',
        auth: { method: 'managed' } as ProviderView['auth'],
        agents: ['claude-code', 'codex'],
        models: { 'claude-code': [], codex: [] },
      }),
    ];
    renderAt('?tab=providers&connect=anthropic');

    // Task 7 改写：详情头已藏，「选中」改由左栏行的 aria-current 观测。向导不打开。
    await waitFor(() => {
      const row = screen.getByRole('button', { name: /Anthropic/ });
      expect(row.getAttribute('aria-current')).toBeTruthy();
    });
    expect(screen.queryByTestId('provider-detail-identity')).toBeNull();
    expect(screen.queryByTestId('gateway-stub')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  // 「内置供应商深链会定位目标模型行 / 自定义供应商深链定位统一模型列表 /
  // keeps enterprise models visible inside the unified detail layout」——裁剪：
  // 深链模型行定位目标在隐藏的 UnifiedModelList 内，默认面不可达（§3.2）。
  it('connect=<目录外 id> → 打开添加模型弹窗(向导 preset 直达已移除)', async () => {
    renderAt('?tab=providers&connect=deepseek');

    await waitFor(() => expect(screen.queryByTestId('gateway-stub')).not.toBeNull());
    expect(wizardSpy).toHaveBeenCalledWith(true);
  });

  it('目录无 xd(无账号会话)→ 左栏置顶 Cindy 登录引导行,connect=xd 落到该行,CTA 跳 /login', async () => {
    const { fireEvent } = await import('@testing-library/react');
    providersState.providers = [makeProvider('anthropic', { name: 'Anthropic' })];
    render(
      <MemoryRouter initialEntries={['/settings?tab=providers&connect=xd']}>
        <Routes>
          <Route path="/settings" element={<ProvidersSection />} />
          <Route path="/login" element={<div data-testid="login-page" />} />
        </Routes>
      </MemoryRouter>,
    );

    // 引导行 + 右栏登录引导(connect=xd 深链选中;列表为空时它也是默认选中)。
    expect(await screen.findByText('settings.providers.xdSignin.badge')).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByText('settings.providers.xdSignin.desc')).not.toBeNull(),
    );
    expect(screen.queryByTestId('gateway-stub')).toBeNull();

    fireEvent.click(screen.getByText('settings.providers.xdSignin.cta'));
    // local 模式:先 exitLocalMode 再进 /login(直跳会被 GuestRoute 弹回)。
    await waitFor(() => expect(screen.getByTestId('login-page')).not.toBeNull());
  });

  it('wizard=1 → 打开添加模型弹窗;参数清除', async () => {
    renderAt('?tab=providers&wizard=1');

    await waitFor(() => expect(screen.queryByTestId('gateway-stub')).not.toBeNull());
    expect(wizardSpy).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  // 「统一模型开关跨 agent 一次提交 / authorization-code 登录期间卸载取消授权」——
  // 裁剪：断言经隐藏的 UnifiedModelList 与详情头登录面板触发，默认面不可达（§3.2）。
});

// 「允许被远程调用与供应商组」describe——裁剪：RemoteProviderAccessRow 在隐藏的
// 旧详情块里（owner 本次把「允许被远程调用 + 远程与分享」入口一并收进开关），
// 默认面不可达（§3.2）；恢复 SHOW_LEGACY_PROVIDER_UI 后可从 git history 找回。

// 模型面板底部「配置模型」在分享来的供应商上带 receivedShare，设置页直接选中那一条。
describe('ProvidersSection — 分享来的供应商深链', () => {
  const share: ProviderShareReceived = {
    shareId: 'share-1',
    memberId: 'mem-1',
    providerId: 'anthropic',
    providerLabel: 'Anthropic',
    hostDeviceId: 'host-1',
    deviceName: "Magi's Mac Mini",
    owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
    // 暂停中的分享不读对方目录，详情页不依赖 device-link。
    status: 'paused',
    hostOnline: true,
    hostCapable: true,
  };

  /** 返回推送新名单的函数(模拟 main 的 RECEIVED_CHANGED)。 */
  function stubReceived(received: ProviderShareReceived[]) {
    resetProviderShareStoreForTests();
    let push: ((list: ProviderShareReceived[]) => void) | null = null;
    const command = vi.fn(async (cmd: { action: string }) => {
      if (cmd.action === 'received') return received;
      throw new Error(`unexpected ${cmd.action}`);
    });
    Object.assign(window.electronAPI, {
      providerShare: {
        command,
        onReceivedChanged: (listener: (list: ProviderShareReceived[]) => void) => {
          push = listener;
          return () => undefined;
        },
      },
    });
    return (list: ProviderShareReceived[]) => act(() => push?.(list));
  }

  afterEach(() => resetProviderShareStoreForTests());

  it('receivedShare=<shareId> → 选中那条分享来的供应商；参数消费后清除', async () => {
    stubReceived([share]);
    renderAt('?tab=providers&receivedShare=share-1');

    await screen.findByTestId('provider-share-received-detail');
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  it('这条分享已不在列表里 → 只停在供应商页，参数同样清除', async () => {
    stubReceived([{ ...share, shareId: 'share-other' }]);
    renderAt('?tab=providers&receivedShare=share-gone');

    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
    expect(screen.queryByTestId('provider-share-received-detail')).toBeNull();
  });

  it('名单暂时为空(断线、换账号) → 保留参数，名单回来后再选中', async () => {
    const push = stubReceived([]);
    renderAt('?tab=providers&receivedShare=share-1');

    await waitFor(() => expect(window.electronAPI.providerShare.command).toHaveBeenCalledWith({ action: 'received' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByTestId('search').textContent).toBe('?tab=providers&receivedShare=share-1');
    expect(screen.queryByTestId('provider-share-received-detail')).toBeNull();

    push([share]);
    await screen.findByTestId('provider-share-received-detail');
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  it('名单暂时为空期间用户改选了别的供应商 → 放弃跳转，名单回来后不切走右栏', async () => {
    providersState.providers = [makeProvider('anthropic', { name: 'Anthropic', connected: true })];
    const push = stubReceived([]);
    renderAt('?tab=providers&receivedShare=share-1');

    await waitFor(() => expect(window.electronAPI.providerShare.command).toHaveBeenCalledWith({ action: 'received' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.click(await screen.findByRole('button', { name: /^Anthropic/ }));
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));

    push([share]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByTestId('provider-share-received-detail')).toBeNull();
    // Task 7 改写：详情头已藏，「右栏仍留在用户选中的供应商上」改由左栏行的
    // aria-current 观测（原断言看 provider-detail-identity）。分享名单回来后左栏
    // 多出一条同名分享行，按 aria-current 精确找用户选中的那条。
    expect(
      screen
        .getAllByRole('button', { name: /^Anthropic/ })
        .filter((row) => row.getAttribute('aria-current') === 'true'),
    ).toHaveLength(1);
  });
});
