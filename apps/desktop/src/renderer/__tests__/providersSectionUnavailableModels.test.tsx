// @vitest-environment jsdom

/**
 * ProvidersSection — 设置「模型」页构成（PRD model-provider-settings 2026-11-01 平铺）:
 *   1. 页面只有平铺模型列表：标题 + 「模型 (n)」顶栏 + 「添加模型」入口 + 列表/空态；
 *      无 provider 行、无「输入分享链接…」、无页头描述句。
 *   2. 模型行 / 添加 / 编辑 / 删除 / 开关行为经本页入口保持可观察。
 *   3. 目录拉取失败的恢复条（quota 等）照旧可重试；进入页面的自动刷新调度照旧。
 *
 * 【Task 7 处置】旧多供应商详情块已整体藏进 SHOW_LEGACY_PROVIDER_UI；断言该块的
 * 语音/模型清单/刷新/可见性开关等用例已裁剪（git history 可找回）。
 *
 * 【PRD 2026-11-01 整页平铺处置】provider 轨结构性隐藏、不再挂载（ProvidersSection
 * `PROVIDER_TRACK_RENDERED`）。凡断言 provider 轨可见性的用例逐条处置：
 *
 * | 原用例 | 处置 | 依据 |
 * | --- | --- | --- |
 * | 首个可见供应商默认选中;未连接内置渠道不占行;旧详情块默认隐藏 | 改写 | 选中/占行在左栏（轨内）；保留自动刷新调度 + 「无 provider 行」 |
 * | hides the local-CLI suggestion row (and the legacy form entry) by default | 改写 | 建议行在左栏（轨内）；保留「旧表单无活口」（无建议行、无表单弹层） |
 * | flipping the single flag restores the suggestion row and the legacy form together | 裁剪 | 整卡不挂载，翻 flag 无可见效果；恢复需重新接线（owner 注释口径） |
 * | 首次记录可见项，并用方向键提交新的可见顺序 | 裁剪 | 拖拽/方向键排序在左栏行（轨内）；挂载首记录 IPC 仍留组件内（仅簿记，无可见面） |
 * | 已有顺序快照挂载时不自动回写 | 裁剪 | 同上（排序可见面在轨内） |
 * | 写入结束后的同目录权威快照会结束乐观排序 | 裁剪 | 同上 |
 * | 切换数据 owner 后会按新 owner 重新记录可见项 | 裁剪 | 同上 |
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn(), dismissAll: vi.fn() },
}));

vi.mock('@/lib/customProviders', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/customProviders')>(),
  createCustomProvider: vi.fn(async () => ({ ok: true })),
  // store 的 remove 卸载 flush 会对 delete/update 结果链 .catch——桩必须返回 Promise。
  deleteCustomProvider: vi.fn(async () => ({ ok: true })),
  readCustomProviderKey: vi.fn(async () => null),
  updateCustomProvider: vi.fn(async () => ({ ok: true })),
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

// 「添加 / 编辑模型」弹窗（ModelGatewayForm）：常驻挂载、open 显隐；桩只在打开时渲染。
const gatewayFormSpy = vi.hoisted(() => vi.fn());
vi.mock('@/features/model-gateway/ModelGatewayForm', () => ({
  ModelGatewayForm: (props: { open?: boolean; mode?: string; initial?: { modelId?: string } }) => {
    if (!props.open) return null;
    gatewayFormSpy(props);
    return React.createElement('div', { 'data-testid': 'gateway-form-stub' });
  },
}));

// legacyVisibility 替身：provider 轨不挂载后它对本页渲染不再有可见效果（恢复需重新
// 接线）；模块契约（单一恢复点）由 legacyVisibility.test.ts 钉住，这里保留替身以免
// 测试意外依赖真实常量。
const legacyFlag = vi.hoisted(() => ({ visible: false }));
vi.mock('@/features/model-gateway/legacyVisibility', () => ({
  SHOW_LEGACY_PROVIDER_UI: false,
  isLegacyProviderUiVisible: () => legacyFlag.visible,
}));

// 2026-10-29 需求 6:多供应商向导已移除;建议行打开自定义连接表单。

import { updateCustomProvider } from '@/lib/customProviders';

import { ProvidersSection } from '@/components/settings/ProvidersSection';

type ScanResult = { detections: unknown[] };
let scanResult: ScanResult;

/** ModelGatewayStore 的条目清单（挂载即读 listProviders）；测试经它灌网关条目。 */
let gatewayRows: unknown[];

/** 灌一条网关条目（custom provider + `catalogPresetId: 'hrbuddy-gateway'` 标记）。 */
function seedGatewayRow(modelId: string) {
  gatewayRows.push({
    id: `gw-${modelId}`,
    name: modelId,
    source: 'user',
    agents: ['claude-code'],
    auth: { method: 'apiKey' },
    routing: {},
    models: {
      'claude-code': [
        {
          id: modelId,
          name: modelId,
          catalogPresetId: 'hrbuddy-gateway',
          contextWindow: 200_000,
          efforts: [],
          defaultEffort: null,
        },
      ],
    },
    connected: true,
  });
}

beforeEach(() => {
  legacyFlag.visible = false;
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
  gatewayRows = [];
  gatewayFormSpy.mockReset();
  confirmSpy.mockReset().mockResolvedValue(false);
  vi.mocked(updateCustomProvider).mockResolvedValue({ ok: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      scanLocalCli: vi.fn(async () => scanResult),
      refreshBuiltinProviderModels: refreshBuiltinModelsSpy,
      requestProviderModelsAutoRefresh: requestAutoRefreshSpy,
      setProviderOrder: setProviderOrderSpy,
      onProviderOAuthProgress: vi.fn(() => () => {}),
      // ModelGatewayProvider（平铺模型列表）挂载即读条目清单。
      listProviders: vi.fn(async () => ({ providers: gatewayRows })),
      exportHrbuddyModels: vi.fn(async () => undefined),
    },
    safeStorageRead: vi.fn(async () => 'sk-test'),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProvidersSection — 「模型」页构成', () => {
  // （原 miniMaxConfig / selectSpeechProvider 语音夹具随语音用例一并裁剪；git history 可找回。）
  // 语音/模型清单用例（manual refresh handles %s speech 等）——裁剪：断言经隐藏的
  // UnifiedModelList（含「获取模型列表」刷新入口）触发，默认生产面不可达（§3.2）。
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
  });

  // 测试价值
  // - 生产入口与可观察结果：真实 ProvidersSection 渲染；用户在设置「模型」页可观察到
  //   标题、平铺模型列表顶栏（「模型 (n)」+ 「添加模型」）与列表/空态；**不**能观察到
  //   provider 行、页头描述句、「输入分享链接…」贴链入口。
  // - Bug／规则依据：PRD model-provider-settings 2026-11-01「原『供应商列表 + 详情』
  //   大卡片整体移除，改为平铺的模型列表」（owner 对照截图裁决的结构差异）。
  // - 现有覆盖缺口：providersSection* 旧用例都以左栏存在为前提，没有一条钉住平铺构成。
  // - 最小失败输入：挂载本页；provider 轨任一面（左栏行 / 描述句 / 贴链按钮）复活即失败。
  // - tier：unit（jsdom 渲染生产组件；IPC 打桩）。
  it('页面只有平铺模型列表：无 provider 行、无贴链入口、无描述句', async () => {
    seedGatewayRow('gw-model-alpha'); // 网关条目对照面（useProviders 目录另有普通 Anthropic）
    render(<MemoryRouter><ProvidersSection /></MemoryRouter>);

    // 标题与模型列表顶栏（「模型 (n)」+「添加模型」）在。
    await screen.findByText('settings.providers.title');
    expect(screen.getByText('settings.providers.modelGateway.title')).toBeTruthy();
    expect(
      screen.getAllByText('settings.providers.modelGateway.add').length,
    ).toBeGreaterThanOrEqual(1);
    // 网关条目以模型行出现。
    const rows = await screen.findAllByTestId('model-gateway-row');
    expect(rows[0].textContent).toContain('gw-model-alpha');
    // 页面没有：页头描述句、「输入分享链接…」贴链入口、任何 provider 行。
    expect(screen.queryByText('settings.providers.subtitle')).toBeNull();
    expect(screen.queryByText('providerShare.received.enterLink')).toBeNull();
    expect(screen.queryByRole('button', { name: /Anthropic/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /gw-model-alpha/ })).toBeNull();
  });

  // 测试价值
  // - 生产入口与可观察结果：真实 ProvidersSection + ModelGatewayList 入口；用户可观察 =
  //   「添加模型」打开添加弹窗、行「编辑」打开同一弹窗回填、行开关只翻启用、删除即
  //   从列表消失（撤销窗口契约见 model-gateway 套件）。
  // - Bug／规则依据：PRD 2026-11-01 平铺页的全部交互面就是这张列表（行/添加/编辑/
  //   删除/开关）；provider 轨下线后本页入口只剩它，行为退化=用户完全没法改模型。
  // - 现有覆盖缺口：providersSection* 旧用例从不经过本页入口验这五个行为
  //   （model-gateway 套件测的是组件直挂，不是设置页入口）。
  // - 最小失败输入：一条网关条目 + 点添加/编辑/开关/删除。
  // - tier：unit（jsdom 渲染生产组件；IPC 打桩）。
  it('模型行 / 添加 / 编辑 / 删除 / 开关经本页入口可观察', async () => {
    seedGatewayRow('gw-alpha');
    render(<MemoryRouter><ProvidersSection /></MemoryRouter>);

    // 模型行在。
    const row = (await screen.findAllByTestId('model-gateway-row'))[0]!;
    expect(row.textContent).toContain('gw-alpha');

    // 添加 → 打开「添加模型」弹窗（create）。
    fireEvent.click(screen.getAllByText('settings.providers.modelGateway.add')[0]!);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('gateway-form-stub')).toBeTruthy();
    expect(gatewayFormSpy).toHaveBeenLastCalledWith(expect.objectContaining({ open: true, mode: 'create' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    // 编辑 → 同一弹窗回填该条目。
    fireEvent.click(within(row).getByText('settings.providers.modelGateway.edit'));
    await act(async () => { await Promise.resolve(); });
    expect(gatewayFormSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      open: true,
      mode: 'edit',
      initial: expect.objectContaining({ modelId: 'gw-alpha' }),
    }));

    // 开关 → 只翻启用，行仍在（配置不丢；细粒度契约见 model-gateway 套件）。
    const toggle = within(row).getByRole('switch');
    fireEvent.click(toggle);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(screen.getAllByTestId('model-gateway-row')).toHaveLength(1);

    // 删除 → 行立即从列表消失（5s 撤销窗口契约见 model-gateway 套件）。
    fireEvent.click(within(row).getByText('settings.providers.modelGateway.delete'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('model-gateway-row')).toBeNull();
  });

  // Ruling 19 沿革：旧表单藏了不能留活口——建议行（及其打开的 ProviderConnectionDialog）
  // 在 provider 轨内，平铺页整体无入口；翻 SHOW_LEGACY_PROVIDER_UI 也接不回来（恢复需
  // 重新接线，owner 注释口径）。此处钉「无建议行 + 无旧表单弹层」。
  it('本机 CLI 建议行与旧完整表单在平铺页无活口', async () => {
    scanResult = {
      detections: [
        { cli: 'claude-cli', providerId: 'anthropic', installed: true, loggedIn: true },
        { cli: 'codex-cli', providerId: 'openai', installed: false, loggedIn: false },
      ],
    };
    render(React.createElement(MemoryRouter, null, React.createElement(ProvidersSection)));

    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('settings.providers.detect.groupLabel')).toBeNull();
    expect(screen.queryByText('settings.providers.detect.action')).toBeNull();
    expect(screen.queryByTestId('custom-provider-dialog-stub')).toBeNull();
    expect(gatewayFormSpy).not.toHaveBeenCalled();
  });

  // 「首次记录可见项，并用方向键提交新的可见顺序 / 已有顺序快照挂载时不自动回写 /
  // 写入结束后的同目录权威快照会结束乐观排序 / 切换数据 owner 后会按新 owner 重新
  // 记录可见项」——裁剪：拖拽/方向键排序与顺序可见面都在左栏（provider 轨不挂载，
  // 平铺页没有排序交互）。挂载时的首记录 IPC 仍留在组件里（仅簿记，供模型选择器
  // 分组消费），但无可观察面，按 §3.2 不再立用例。完整断言见 git history。
});
