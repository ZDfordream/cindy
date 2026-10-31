// @vitest-environment jsdom

/**
 * ProvidersSection — 旧详情块可见性（单一恢复点）+ Cindy AI 账户资产模块组件契约。
 *
 * 【Task 7 处置记录】旧多供应商详情块（身份行/断开/「···」菜单、账户资产模块、
 * 允许被远程调用 + 远程与分享入口、预设/多协议/「获取模型列表」入口）已整体藏到
 * `SHOW_LEGACY_PROVIDER_UI` 后（owner 2026-10-31「藏起来以后再说」，保留代码、
 * 隐藏入口）。原先透过 ProvidersSection 逐条验资产模块/身份头/「···」菜单行为的
 * 用例在默认生产面不可达，按工程约定 §3.2「测试须验生产可达行为」逐条裁剪并在此
 * 登记依据（完整断言见 git history；把 legacyVisibility.ts 常量改回 true 即整块
 * 回到生产面，届时可原样找回）：
 *
 * | 原用例 | 处置 | 依据 |
 * | --- | --- | --- |
 * | 仅免费个人账号在 Cindy AI 名称后显示身份标签 | 裁剪 | 免费标签挂在隐藏的身份行内 |
 * | 非套餐用户:查看用量始终在,右边购买套餐,不显示充值 | 裁剪 | 账户资产模块整块隐藏 |
 * | 有套餐还能升级:查看用量始终在,右边升级套餐,不显示充值 | 裁剪 | 同上 |
 * | 升满以后:查看用量始终在,右边才是余额充值 | 裁剪 | 同上 |
 * | 正常态版面上没有重试 / 轮换 / 重新获取凭据按钮(它们退进「···」菜单) | 裁剪 | 「···」菜单在隐藏的身份行内 |
 * | 企业账号:显示周期额度,不读取个人余额或提供充值 | 裁剪 | 账户资产模块整块隐藏 |
 * | shows no personal limit rather than an unavailable quota for an enterprise | 裁剪 | 同上 |
 * | local 会话(未登录云账号):同样不渲染 | 裁剪 | 结论被「默认隐藏」覆盖（现在任何会话都不渲染该模块） |
 * | 拿不到余额:显示说明和就地重试,不伪造零余额 | 裁剪 | 账户资产模块整块隐藏 |
 * | 凭据同步失败:故障说明 + 重试,且不显示「已连接」 | 裁剪 | 故障条与「···」菜单都在隐藏区 |
 * | 凭据管理三项与脱敏 key 都在「···」菜单里 | 裁剪 | 「···」菜单在隐藏的身份行内 |
 *
 * 保留：顶部 `ProviderAccountUsageModule` 直连用例（PR #7031 dashboard URL 契约）
 * 不经过 ProvidersSection、不受可见性开关影响，是资产模块组件自身的对外契约，
 * 恢复开关后仍需成立，故留（逐条判定，非一刀切）。新增两例验生产可达的可见性
 * 契约本身：默认藏、单开关整块回。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';
import { ProviderAccountUsageModule } from '../components/settings/ProviderAccountUsageModule';

const {
  providersState,
  authState,
  creditUsageState,
  quotaState,
  modelAccessState,
  apiKeyState,
  primaryActionState,
} = vi.hoisted(() => ({
  providersState: { providers: [] as unknown[], order: [] as string[] },
  authState: {
    mode: 'cloud' as 'cloud' | 'local' | 'signed-out',
    user: { membershipKind: 'personal' } as { membershipKind: 'personal' | 'org' } | null,
    dataOwnerId: 'account-1' as string | null,
  },
  quotaState: {
    unlimited: false,
    usage: null as import('../hooks/useClaudeAccountUsage').ClaudeAccountUsageSnapshot | null,
  },
  creditUsageState: { available: null as string | null },
  modelAccessState: {
    state: 'ok' as 'ok' | 'failed' | 'unsupported' | 'idle' | 'syncing' | 'disabled',
    source: 'server' as string | null,
    accountTier: null as 'free' | 'paid' | 'not_applicable' | null,
  },
  apiKeyState: { key: 'sk-live-abcd1234ef2a', hasSavedKey: true },
  primaryActionState: {
    value: 'buy-plan' as 'buy-plan' | 'upgrade-plan' | 'topup' | null,
    lastEnabled: false,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
  }),
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
  useAuth: () => ({ ...authState, exitLocalMode: vi.fn(async () => undefined) }),
}));

vi.mock('@/hooks/useModelAccessCreditUsage', () => ({
  useModelAccessCreditUsageResult: (enabled: boolean) => ({
    usage:
      enabled && creditUsageState.available !== null
        ? { available: creditUsageState.available }
        : null,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useClaudeAccountUsage', () => ({
  useClaudeAccountUsageResult: (enabled: boolean) => ({
    usage: enabled ? quotaState.usage : null,
    unlimited: enabled && quotaState.unlimited,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useXdAssetPrimaryAction', () => ({
  useXdAssetPrimaryAction: (enabled: boolean) => {
    primaryActionState.lastEnabled = enabled;
    return enabled ? primaryActionState.value : null;
  },
}));

vi.mock('@/hooks/useModelAccessStatus', () => ({
  useModelAccessStatus: () => ({ ...modelAccessState, endpoint: null }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ ...apiKeyState, clearKey: vi.fn(async () => true) }),
}));

vi.mock('@/hooks/useCodexAuth', () => ({
  isChatGptConnectionConnected: () => false,
  useCodexAuth: () => ({
    state: { kind: 'unauthenticated' },
    reconnectCredentialScope: undefined,
    recoveryCheck: 'idle',
    refresh: vi.fn(async () => undefined),
    triggerLogin: vi.fn(async () => 'authenticated'),
    cancelLogin: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/lib/customProviders', () => ({
  appendDiscoveredCustomProviderModels: vi.fn(),
  deleteCustomProvider: vi.fn(),
  providerViewToCustomProviderConfig: vi.fn(),
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
  setModelVisibilities: vi.fn(),
  setModelVisibility: vi.fn(),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/components/settings/ProviderConnectionDialog', () => ({
  ProviderConnectionDialog: () => null,
}));

vi.mock('@/components/settings/AddProviderWizard', () => ({
  AddProviderWizard: () => React.createElement('div', { 'data-testid': 'wizard-stub' }),
}));

vi.mock('@/features/billing/money', () => ({
  BILLING_CURRENCY: 'cny',
  formatBillingAmount: (amount: string, currency: string) => `${currency}:${amount}`,
}));

// 可控的单一恢复点替身：ProvidersSection 只读 isLegacyProviderUiVisible()，
// 翻转它即验证「改一处即整块恢复」（真实常量契约见 legacyVisibility.test.ts）。
const legacyFlag = vi.hoisted(() => ({ visible: false }));
vi.mock('@/features/model-gateway/legacyVisibility', () => ({
  SHOW_LEGACY_PROVIDER_UI: false,
  isLegacyProviderUiVisible: () => legacyFlag.visible,
}));

import { ProvidersSection } from '@/components/settings/ProvidersSection';

function makeXd(): ProviderView {
  return {
    id: 'xd',
    name: 'Cindy AI',
    source: 'builtin',
    agents: ['claude-code', 'codex'],
    auth: { method: 'managed' },
    routing: {},
    models: {
      'claude-code': [
        {
          id: 'cindy-test-model',
          name: 'Cindy Test Model',
          contextWindow: 200000,
          efforts: ['high'],
          defaultEffort: 'high',
        },
      ],
      codex: [],
    },
    connected: true,
  } as unknown as ProviderView;
}

function SearchProbe() {
  const location = useLocation();
  return <div data-testid="search">{`${location.pathname}${location.search}`}</div>;
}

function renderSection() {
  return render(
    <MemoryRouter initialEntries={['/settings?tab=providers']}>
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
  legacyFlag.visible = false;
  providersState.order = [];
  providersState.providers = [makeXd()];
  authState.mode = 'cloud';
  authState.user = { membershipKind: 'personal' };
  authState.dataOwnerId = 'account-1';
  creditUsageState.available = '18.42';
  quotaState.usage = null;
  quotaState.unlimited = false;
  modelAccessState.state = 'ok';
  modelAccessState.source = 'server';
  modelAccessState.accountTier = null;
  apiKeyState.hasSavedKey = true;
  primaryActionState.value = 'buy-plan';
  primaryActionState.lastEnabled = false;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      scanLocalCli: vi.fn(async () => ({ detections: [] })),
      requestProviderModelsAutoRefresh: vi.fn(async () => ({ ok: true })),
      setProviderOrder: vi.fn(async () => ({ ok: true })),
      // ModelGatewayProvider(右栏模型列表)挂载即读条目清单。
      listProviders: vi.fn(async () => ({ providers: [] })),
    },
    modelAccess: {
      retry: vi.fn(async () => undefined),
      rotate: vi.fn(async () => undefined),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// PR #7031: settings and chip must both open the queried account's dashboard.
// Unit/jsdom, a CN-first configuration whose usable key belongs to Global/Pi.
it.each(['ready', 'unavailable'])('uses the queried dashboard in the settings card (%s)', async (status) => {
  const dashboardUrl = 'https://z.ai/manage-apikey/coding-plan/personal/my-plan';
  Object.assign(window.electronAPI, { openExternal: vi.fn(async () => undefined) });
  Object.assign(window.electronAPI.maker, { fetchProviderAccountUsage: vi.fn(async () => ({
    status, dashboardUrl,
    ...(status === 'ready'
      ? { agent: 'pi', stale: false, snapshot: { kind: 'zhipu-coding-plan-quota', noPlan: true, level: null, fiveHour: null, weekly: null, fetchedAt: 1 } }
      : { error: 'auth' }),
  })) });
  render(<ProviderAccountUsageModule provider={{
    id: 'mixed-glm', auth: { method: 'apiKey' },
    routing: {
      'claude-code': { upstream: 'https://open.bigmodel.cn/api/anthropic', authStrategy: 'api-key-header' },
      pi: { upstream: 'https://api.z.ai/api/coding/paas/v4', authStrategy: 'api-key-header' },
    },
  } as ProviderView} />);
  await screen.findByText(status === 'ready' ? 'Pi' : 'providerAccountUsage.error.auth');
  fireEvent.click(screen.getByRole('button', { name: 'providerAccountUsage.zhipuCodingPlan.usage' }));
  expect(window.electronAPI.openExternal).toHaveBeenCalledExactlyOnceWith(dashboardUrl);
});

// 原「ProvidersSection — Cindy AI 账户资产模块」describe 的逐条处置见文件头登记表；
// 下面两例是 Task 7 后该文件在生产可达面的职责：默认藏、单开关整块回。
describe('ProvidersSection — 旧详情块可见性（单一恢复点）', () => {
  it('hides the legacy identity and asset block by default', async () => {
    legacyFlag.visible = false;
    renderSection();

    // 左栏的 Cindy AI 行还在（列表在左栏，不属于被收的旧详情块）。
    await screen.findAllByText('settings.providers.xd.title');
    // 右栏只剩模型网关列表：身份行、账户资产模块都不渲染。
    expect(screen.queryByTestId('provider-detail-identity')).toBeNull();
    expect(screen.queryByTestId('cindy-ai-asset-module')).toBeNull();
    expect(screen.queryByTestId('provider-detail-scroll')).toBeNull();
    expect(screen.getByText('settings.providers.modelGateway.title')).toBeTruthy();
    // F2 起左栏「添加」按钮与列表「添加模型」同文案（同一 ModelGatewayForm 入口），
    // getByText 会命中多处，按至少一处收口。
    expect(
      screen.getAllByText('settings.providers.modelGateway.add').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('flipping the single flag restores the legacy block', async () => {
    // 翻转唯一恢复点 → 整块回归（身份行 + 账户资产模块）。
    legacyFlag.visible = true;
    renderSection();

    await screen.findByTestId('provider-detail-identity');
    await screen.findByTestId('cindy-ai-asset-module');
  });
});
