// @vitest-environment jsdom

/**
 * ProvidersSection — 深链定位(?tab / ?connect / ?wizard / ?receivedShare)关键不变量:
 *   1. `#/settings?tab=providers`（聊天下拉「去设置」等入口的深链）仍打开本页，
 *      且平铺模型列表可见（路由 / tab id 不随改名变化）。
 *   2. connect=<内置未占行渠道> → 打开「添加模型」弹窗;URL 参数消费后被清除。
 *   3. connect=<目录内已占行供应商> → **不**打开弹窗（占行判定照旧），参数清除。
 *   4. connect=<目录外 id> → 「添加模型」弹窗打开（旧 preset 直达已移除）。
 *   5. wizard=1 → 「添加模型」弹窗打开;参数清除。
 *   6. receivedShare=<shareId> 的参数生命周期（消费清除 / 名单空时保留）不随平铺改变。
 *
 * 【Task 7 处置】旧多供应商详情块已整体藏进 SHOW_LEGACY_PROVIDER_UI（owner「藏起来
 * 以后再说」）；断言该块的用例已按 §3.2 裁剪（见 git history）。
 *
 * 【PRD 2026-11-01 整页平铺处置】provider 轨（左栏供应商列表 + 右栏登录/分享/远程/
 * 旧详情整卡）结构性隐藏、不再挂载。凡断言 provider 轨可见性的用例逐条处置如下
 * （被裁用例的完整断言见 git history；恢复需重新接线 provider 轨，见 ProvidersSection
 * `PROVIDER_TRACK_RENDERED` 注释）：
 *
 * | 原用例 | 处置 | 依据 |
 * | --- | --- | --- |
 * | does not rediscover a deleted local Codex provider into the settings list | 裁剪 | 断言面是左栏列表行；左栏不挂载，扫描建议行同在轨内 |
 * | keeps a native Codex account without models visible (connected=%s) | 裁剪 | 左栏占行 + 详情头断言，均在轨内 |
 * | shows the saved name in the sidebar for %s | 裁剪 | 左栏行显示保存名，轨内 |
 * | keeps gateway entries out of the left rail… | 改写 | 左栏半边失效；保留「网关条目只在模型列表出现」，另钉「页面无 provider 行」 |
 * | renames an account when its sidebar row is double-clicked | 裁剪 | 双击重命名挂在左栏行 |
 * | does not offer double-click rename for Cindy AI | 裁剪 | 同上 |
 * | ChatGPT 系统共享登录失效时左栏行显示失效态 | 裁剪 | 失效态标签挂在左栏行 |
 * | connect=<左栏占行供应商> → 直接选中 | 改写 | 「选中」无可见面；只保留「不开弹窗 + 参数清除」 |
 * | 目录无 xd → Cindy 登录引导行 + CTA | 裁剪 | 登录引导面（左栏行 + 右栏）在轨内 |
 * | receivedShare → 选中那条分享来的供应商（详情出现） | 改写 | 详情在轨内；只保留参数消费清除，另断言详情不再渲染 |
 * | 名单暂时为空期间用户改选了别的供应商 → 放弃跳转 | 裁剪 | 「改选」交互在左栏行，平铺页无选中面 |
 */

import { cleanup, act, render, screen, waitFor } from '@testing-library/react';
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
import { SettingsView } from '@/components/settings/SettingsView';
import { useProviderSubscriptionCard } from '@/components/settings/useProviderSubscriptionCard';
import { resetProviderShareStoreForTests } from '@/features/provider-share/providerShareStore';

vi.mock('@/components/settings/useProviderSubscriptionCard', () => ({
  useProviderSubscriptionCard: vi.fn(() => null),
}));

vi.mock('@/components/settings/LlamaCppProviderDetail', () => ({ LlamaCppProviderDetail: () => null }));

vi.mock('@/components/settings/OllamaProviderDetail', () => ({ OllamaProviderDetail: () => null }));

// SettingsView 路由壳的同级分区全部换空壳（深链 #/settings?tab=providers 的真实入口），
// 只留真实 ProvidersSection——验证 tab 参数 → 「模型」页的路由映射本身。
const { ShellStub } = vi.hoisted(() => ({ ShellStub: () => null }));
vi.mock('@/components/settings/SettingsSidebarNav', () => ({ SettingsSidebarNav: ShellStub }));
vi.mock('@/components/settings/UserProfileCard', () => ({ UserProfileCard: ShellStub }));
vi.mock('@/components/settings/VoiceInputSection', () => ({ VoiceInputSection: ShellStub }));
vi.mock('@/components/settings/AppearanceSection', () => ({ AppearanceSection: ShellStub }));
vi.mock('@/components/settings/SubagentModelSection', () => ({ SubagentModelSection: ShellStub }));
vi.mock('@/components/settings/AuxiliaryModelSection', () => ({ AuxiliaryModelSection: ShellStub }));
vi.mock('@/components/settings/VisionBridgeSection', () => ({ VisionBridgeSection: ShellStub }));
vi.mock('@/components/settings/McpServersSection', () => ({ McpServersSection: ShellStub }));
vi.mock('@/components/settings/RemoteControlSection', () => ({ RemoteControlSection: ShellStub }));
vi.mock('@/components/settings/LocalAgentSection', () => ({ LocalAgentSection: ShellStub }));
vi.mock('@/features/device-link/SharedTaskDialog', () => ({ SharedTaskDialog: ShellStub }));
vi.mock('@/components/settings/NotificationSection', () => ({ NotificationSection: ShellStub }));
vi.mock('@/components/settings/WindowBehaviorSection', () => ({ WindowBehaviorSection: ShellStub }));
vi.mock('@/components/settings/ComposerSendShortcutSection', () => ({ ComposerSendShortcutSection: ShellStub }));
vi.mock('@/components/settings/KeyboardShortcutsSection', () => ({ KeyboardShortcutsSection: ShellStub }));
vi.mock('@/components/settings/AgentIslandSection', () => ({ AgentIslandSection: ShellStub }));
vi.mock('@/components/settings/LanguageSection', () => ({ LanguageSection: ShellStub }));
vi.mock('@/components/settings/LogoutSection', () => ({ LogoutSection: ShellStub }));
vi.mock('@/components/settings/ImBotSection', () => ({
  ImBotSection: ShellStub,
  isImBotSettingsGroup: (value: unknown) => value === 'cindy' || value === 'personal',
}));
vi.mock('@/components/settings/AboutSection', () => ({ AboutSection: ShellStub }));
vi.mock('@/components/settings/WorktreeRecycleCard', () => ({ WorktreeRecycleCard: ShellStub }));
vi.mock('@/components/settings/StorageManagementCard', () => ({ StorageManagementCard: ShellStub }));
vi.mock('@/components/settings/UserPromptSection', () => ({ UserPromptSection: ShellStub }));
vi.mock('@/components/settings/MemorySection', () => ({ MemorySection: ShellStub }));
vi.mock('@/components/settings/TerminalShellSection', () => ({ TerminalShellSection: ShellStub }));
vi.mock('@/components/settings/LinkOpenSection', () => ({ LinkOpenSection: ShellStub }));
vi.mock('@/components/settings/StreamFadeSection', () => ({ StreamFadeSection: ShellStub }));
vi.mock('@/components/settings/TipsSection', () => ({ TipsSection: ShellStub }));
vi.mock('@/components/settings/ExperimentalSection', () => ({ ExperimentalSection: ShellStub }));
vi.mock('@/components/settings/GitSafetySection', () => ({ GitSafetySection: ShellStub }));
vi.mock('@/components/settings/SessionImportSection', () => ({ SessionImportSection: ShellStub }));
vi.mock('@/components/settings/HelpSection', () => ({ HelpSection: ShellStub }));
vi.mock('@/components/settings/HelpAssistantPanel', () => ({ HelpAssistantPanel: ShellStub }));
vi.mock('@/components/settings/AgentResourceSection', () => ({ AgentResourceSection: ShellStub }));
vi.mock('@/components/settings/PiPackagesSection', () => ({ PiPackagesSection: ShellStub }));
vi.mock('@/components/settings/CollaborationSection', () => ({ CollaborationSection: ShellStub }));
vi.mock('@/components/settings/BuiltinToolsSection', () => ({ BuiltinToolsSection: ShellStub }));
vi.mock('@/components/settings/contacts/ContactsSection', () => ({ ContactsSection: ShellStub }));
vi.mock('@/components/settings/ComputerUseSection', () => ({ ComputerUseSection: ShellStub }));
vi.mock('@/components/settings/SettingsCatalogPanel', () => ({ SettingsCatalogPanel: ShellStub }));
vi.mock('@/components/settings/usage/UsageHistorySection', () => ({ UsageHistorySection: ShellStub }));
vi.mock('@/features/billing/BillingPage', () => ({ BillingSettingsSection: ShellStub }));
vi.mock('@/features/bots/BotsGlobalSettingsSection', () => ({ BotsGlobalSettingsSection: ShellStub }));

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
  // jsdom 无 Element.scrollTo（SettingsView 切 tab 回顶用它）；与 SettingsViewEscape 同法补空实现。
  Element.prototype.scrollTo = () => {};
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
  // 测试价值
  // - 生产入口与可观察结果：`#/settings?tab=providers`（聊天下拉「去设置」等入口的
  //   深链）经**真实 SettingsView 路由壳**（同级分区打桩）落到设置「模型」页，
  //   页面标题与平铺模型列表可见。
  // - Bug／规则依据：PRD 2026-11-01 改名（导航「模型供应商」→「模型」）只动展示名，
  //   路由 / tab id 必须保持 `providers`——改坏 isSettingsTab / activeTab 映射或
  //   panel 挂点会让所有「去设置」深链落空（owner delta 3 的硬性要求）。
  // - 现有覆盖缺口：providersSection* 此前只直接渲染 ProvidersSection，从未验过
  //   tab 参数 → 本页的路由映射。
  // - 最小失败输入：以 `/settings?tab=providers` 挂真实 SettingsView；路由落错 tab
  //   或 panel 不渲染本页即失败。
  // - tier：unit（jsdom；同级分区空壳，只带真实 ProvidersSection；IPC 打桩）。
  it('深链 #/settings?tab=providers 仍打开本页且模型列表可见', async () => {
    render(
      <MemoryRouter initialEntries={['/settings?tab=providers']}>
        <Routes>
          <Route path="/settings" element={<SettingsView />} />
        </Routes>
      </MemoryRouter>,
    );

    // tab id 未改：?tab=providers 仍路由到本页 panel。
    await waitFor(() =>
      expect(document.getElementById('settings-panel-providers')).not.toBeNull(),
    );
    // 页面构成：标题 + 平铺模型列表。
    expect(screen.getByText('settings.providers.title')).toBeTruthy();
    expect(screen.getByText('settings.providers.modelGateway.title')).toBeTruthy();
  });

  // 「does not rediscover a deleted local Codex provider into the settings list /
  // keeps a native Codex account without models visible / shows the saved name in
  // the sidebar for %s」——裁剪：断言面全部是左栏列表行（轨内），平铺页无 provider
  // 行（见文件头处置表）。完整断言见 git history。

  // 测试价值
  // - 生产入口与可观察结果：真实 ProvidersSection 渲染；网关条目（custom provider 带
  //   `catalogPresetId: 'hrbuddy-gateway'` 标记）出现在平铺模型列表
  //   （ModelGatewayList → model-gateway-row），页面不渲染任何 provider 行。
  // - Bug／规则依据：PRD 2026-11-01「供应商列表 + 详情大卡片整体移除」——网关条目
  //   的唯一入口是模型列表；回归 = provider 行复活（含点它无响应的旧问题）。
  // - 现有覆盖缺口：providersSection* 只验过左栏行归属，平铺后需钉「无 provider 行」。
  // - 最小失败输入：providers 目录里一条带网关标记的 user 条目 + 一条普通内置行。
  // - tier：unit（jsdom 渲染生产组件，无网络 / 真实计时）。
  it('keeps gateway entries in the flat model list and renders no provider rows', async () => {
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

    // 模型列表仍是网关条目唯一入口。
    const rows = await screen.findAllByTestId('model-gateway-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('gw-model-alpha');
    // 页面没有任何 provider 行（旧左栏的普通行 / 网关行都不再渲染）。
    expect(screen.queryByRole('button', { name: /Anthropic/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /gw-model-alpha/ })).toBeNull();
  });

  // 「renames an account when its sidebar row is double-clicked / ChatGPT 系统共享
  // 登录失效时左栏行显示失效态」——裁剪：断言面是左栏行（轨内），平铺页无入口
  // （§3.2 + 文件头处置表）。完整断言见 git history。
  // 其余旧详情块用例（API key / device-code / OpenAI recovery…）同前轮裁剪说明。

  // 「ChatGPT 非共享失效凭证通过浏览器重新登录 / 主动断开后仍使用本机账号连接 /
  // 系统共享打开 App 后保留恢复入口」——裁剪：恢复入口按钮在隐藏的详情头里，
  // 默认面不可达（§3.2）；完整断言见 git history。
  it('connect=anthropic(未占行内置渠道)→ 打开添加模型弹窗;参数消费后清除', async () => {
    renderAt('?tab=providers&connect=anthropic');

    await waitFor(() => expect(screen.queryByTestId('gateway-stub')).not.toBeNull());
    expect(wizardSpy).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
  });

  // PRD 平铺改写：「直接选中」在平铺页没有可见面（provider 轨不挂载）；占行判定的
  // 可观察结果只剩「不打开添加模型弹窗 + 参数清除」。
  it('connect=<目录内已占行供应商> → 不打开添加模型弹窗;参数消费后清除', async () => {
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

    // 页面仍是平铺模型列表（挂载即终态），弹窗不开。
    await screen.findByText('settings.providers.modelGateway.title');
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

  // 「目录无 xd(无账号会话)→ 左栏置顶 Cindy 登录引导行,connect=xd 落到该行,CTA 跳
  // /login」——裁剪：登录引导行与引导面都在 provider 轨内（PRD 平铺不挂载）。
  // 完整断言见 git history。

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

  // PRD 平铺改写：分享详情面在 provider 轨内（不再渲染）；deep-link 的可观察契约
  // 收窄为参数生命周期（消费清除 / 名单空时保留）。选中态不再有可见面。
  it('receivedShare=<shareId> → 参数消费后清除（分享详情随 provider 轨不再渲染）', async () => {
    stubReceived([share]);
    renderAt('?tab=providers&receivedShare=share-1');

    await waitFor(() => expect(window.electronAPI.providerShare.command).toHaveBeenCalledWith({ action: 'received' }));
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
    // 页面停在平铺模型列表；分享详情（轨内）不渲染。
    await screen.findByText('settings.providers.modelGateway.title');
    expect(screen.queryByTestId('provider-share-received-detail')).toBeNull();
  });

  it('这条分享已不在列表里 → 只停在供应商页，参数同样清除', async () => {
    stubReceived([{ ...share, shareId: 'share-other' }]);
    renderAt('?tab=providers&receivedShare=share-gone');

    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
    expect(screen.queryByTestId('provider-share-received-detail')).toBeNull();
  });

  it('名单暂时为空(断线、换账号) → 保留参数，名单回来后再消费', async () => {
    const push = stubReceived([]);
    renderAt('?tab=providers&receivedShare=share-1');

    await waitFor(() => expect(window.electronAPI.providerShare.command).toHaveBeenCalledWith({ action: 'received' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByTestId('search').textContent).toBe('?tab=providers&receivedShare=share-1');
    expect(screen.queryByTestId('provider-share-received-detail')).toBeNull();

    push([share]);
    await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=providers'));
    expect(screen.queryByTestId('provider-share-received-detail')).toBeNull();
  });

  // 「名单暂时为空期间用户改选了别的供应商 → 放弃跳转」——裁剪：「改选」交互在
  // 左栏行（轨内），平铺页没有选中面可移动。完整断言见 git history。
});
