// @vitest-environment jsdom

/**
 * sessionRules — 退出登录 / 登录态失效 / SESSION 规则 + S3 引导宿主（Task 7）。
 *
 * 测试价值
 * - 生产入口与可观察结果：走真实 `HrOaGate` + 真实 `ModelGatewayProvider` +
 *   真实 `HomeOnboardingGateProvider` + 真实 `OnboardingSessionHost`（S3 引导宿主）+
 *   真实 `HrOaMoreMenuItems`（「更多」浮层条目）+ 真实 `OnboardingModelDialog` /
 *   `OnboardingHomeBanner` / `useCurrentModel`，只在 IPC 边界打桩（hrOa.* 与
 *   maker.*）。断言均为用户可观察结果：S3 弹窗出没出、横幅两态、菜单点击后弹窗
 *   开合与落库、退出后回 S1、草稿没了模型还在、toast 出没出与早晚。
 * - Bug／规则依据：login-onboarding PRD §6.5 FR-SESSION-02…05、§6.2 FR-HOME-02/03
 *   （AC-14/15）、§9.2 T3/T4/T9/T10；简报「显式再登 vs 仅启动」分流（FR-SESSION-05
 *   最细的一条）；主动登出不得误弹「登录已过期」（LocalDbGate 离开路径同款误伤）；
 *   Task 5 弹窗成功尾 `onSaved` + `onClose` 双回调合同（宿主不得把 onClose 当放弃）。
 * - 现有覆盖缺口：`hrOaGate.test.tsx` 只钉门禁面（S1/S2 往返与失效 toast），无 S3
 *   宿主、无会话规则、无「更多」条目；`homeOnboardingGate.test.tsx` 只钉首页两态与
 *   补配门禁，无「显式登录才弹 S3」、无退出/失效分流、无 owner 分区边界。
 * - 最小失败输入：显式登录成功 + `listProviders` 落定零条目 → 不出 S3 即失败；
 *   仅 `getState` 静默落定 signed-in（= 启动）却弹 S3 即失败；主动登出弹了
 *   「登录已过期」即失败；失效 toast 在转场锁结束前出现即失败。
 * - tier：unit（jsdom，真实 store + 组件，IPC 边界打桩；500ms 成功拍 / 450ms
 *   已保存保持 / 600ms 转场锁全走 fake timers，无真实等待）。
 * - 实测耗时：单文件墙钟 3.3s（`pnpm --dir apps/desktop exec vitest run
 *   src/renderer/features/hr-oa-auth/__tests__/sessionRules.test.tsx`，7 用例执行
 *   0.37s；其余为真实 ModelGatewayForm / LoginScreen 树的导入收集）——预算内。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import type { ProviderView } from '@cindy/model-providers';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import i18n from '@/i18n';
import { getToastSnapshot } from '@/lib/toast';
import {
  getDraft,
  plainTextToTiptapDoc,
  saveDraft as saveComposerDraft,
  setComposerDraftOwner,
  subscribeDraftContent,
} from '@/lib/composerDraftStore';
import { ModelGatewayProvider, useModelGateway } from '@/features/model-gateway/ModelGatewayStore';
import {
  HomeOnboardingGateProvider,
  useHomeGateSurface,
} from '@/features/model-gateway/homeOnboardingGate';
import { OnboardingHomeBanner } from '@/features/model-gateway/OnboardingHomeBanner';
import { useCurrentModel } from '@/features/model-gateway/currentModelStore';
import { HrOaGate } from '../HrOaGate';
import { HrOaMoreMenuItems } from '../HrOaMoreMenuItems';
import { OnboardingSessionHost } from '../OnboardingSessionHost';
import { __testing as hrOaStoreTesting } from '../hrOaAuthStore';

// ── IPC 桥桩（hrOa.* 与 maker.*；推送走 auth:state-change，与生产同链）──────────
const bridge = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  getState: vi.fn(),
  listeners: new Set<(payload: unknown) => void>(),
  // 按账号分区的网关条目（owner 分区在 main 侧由 dataOwnerId 承担；这里按
  // accountKey 分桶模拟同一合同，供断言「换账号看不到上一账号的模型」）。
  providersByAccount: new Map<string, ProviderView[]>(),
  currentAccountKey: 'P100',
  listProviders: vi.fn(),
  createCustomProvider: vi.fn(),
  testProviderConnection: vi.fn(),
}));

const PROFILE_A = {
  name: '张三',
  loginName: 'zhangsan',
  dept: '人力资源部',
  mobile: '',
  email: '',
  title: '',
  sex: '男',
  personId: 'P100',
};
const PROFILE_B = { ...PROFILE_A, name: '李四', loginName: 'lisi', personId: 'P200' };
const SIGNED_IN_A = { status: 'signed-in', accountKey: 'P100', profile: PROFILE_A };
const SIGNED_IN_B = { status: 'signed-in', accountKey: 'P200', profile: PROFILE_B };
const SIGNED_OUT = { status: 'signed-out' };

const WELCOME_TITLE = 'HRBuddy，我帮你';
const EXPIRED_TOAST = '登录已过期，请重新登录';
const BANNER_TEXT = '还没有配置模型，配置后即可开始对话';
const BANNER_ACTION = '去配置';
const DIALOG_TITLE = '添加模型';
const SKIP_LABEL = '跳过，稍后配置';
const SKIP_HINT = '也可以先跳过，稍后在「更多 → 自定义」中配置。';
const CUSTOMIZE_LABEL = '自定义';
const LOGOUT_LABEL = '退出登录';
const MORE_LABEL = '更多';
const UNCONFIGURED_LABEL = '未配置模型';
const DRAFT_KEY = 'session-rules-draft';

function gatewayEntryProvider(modelId = 'gw-model-alpha', id = 'gw-entry'): ProviderView {
  return {
    id,
    name: modelId,
    source: 'user',
    connected: true,
    agents: ['claude-code'],
    auth: { method: 'apiKey' },
    routing: { 'claude-code': { upstream: 'https://gw.example.test', authStrategy: 'api-key-header' } },
    models: {
      'claude-code': [
        { id: modelId, name: modelId, catalogPresetId: 'hrbuddy-gateway', contextWindow: 200_000, efforts: [], defaultEffort: null },
      ],
    },
  };
}

function installBridge(): void {
  bridge.listProviders.mockImplementation(() =>
    Promise.resolve({ providers: [...(bridge.providersByAccount.get(bridge.currentAccountKey) ?? [])] }),
  );
  bridge.createCustomProvider.mockImplementation(() => {
    const bucket = bridge.providersByAccount.get(bridge.currentAccountKey) ?? [];
    // 落库语义：保存后条目进入当前账号分区（重挂载后 listProviders 可见）。
    bridge.providersByAccount.set(bridge.currentAccountKey, [
      ...bucket,
      gatewayEntryProvider(`gw-model-${bucket.length + 1}`, `gw-entry-${bucket.length + 1}`),
    ]);
    return Promise.resolve({ ok: true });
  });
  bridge.testProviderConnection.mockImplementation(() => Promise.resolve({ ok: true, latencyMs: 64 }));
  // 生产时序：manager.settle 先投影并广播 auth:state-change（早于 invoke 回包）。
  bridge.logout.mockImplementation(async () => {
    bridge.getState.mockResolvedValue(SIGNED_OUT);
    for (const listener of bridge.listeners) listener({});
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      hrOa: {
        login: bridge.login,
        logout: bridge.logout,
        getState: bridge.getState,
      },
      onAuthStateChange: (cb: (payload: unknown) => void) => {
        bridge.listeners.add(cb);
        return () => bridge.listeners.delete(cb);
      },
      uiMockData: false,
      maker: {
        listProviders: bridge.listProviders,
        createCustomProvider: bridge.createCustomProvider,
        updateCustomProvider: vi.fn(async () => ({ ok: true })),
        deleteCustomProvider: vi.fn(async () => ({ ok: true })),
        exportHrbuddyModels: vi.fn(async () => undefined),
        testProviderConnection: bridge.testProviderConnection,
      },
      safeStorageRead: vi.fn(async () => 'sk-test'),
      platform: 'darwin',
    },
  });
}

/** jsdom 无真实媒体查询：吉祥物 / 减少动效探测需要桩（默认 reduce = 瞬时转场）。 */
function mockMatchMedia(reduce = true): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

/** 未发送草稿探针：订阅生产 `subscribeDraftContent`（ChatInput 同一来源），内容随写入/清除实时反映。 */
function DraftProbe() {
  const [present, setPresent] = useState(() => Boolean(getDraft(DRAFT_KEY)));
  useEffect(() => subscribeDraftContent(DRAFT_KEY, () => setPresent(Boolean(getDraft(DRAFT_KEY)))), []);
  return <span data-testid="draft-probe">{present ? 'has-draft' : ''}</span>;
}

/** 首页面（与 NewMakerDraftRoute 的宿主接线同构）：横幅两态 + 模型/当前模型标记 + 「更多」浮层。 */
function HomeSurface() {
  const surface = useHomeGateSurface();
  const { entries, hydrated } = useModelGateway();
  const { currentId } = useCurrentModel();
  const currentEntry = entries.find((entry) => entry.id === currentId) ?? null;
  return (
    <div data-testid="home-surface">
      <OnboardingHomeBanner
        visible={surface?.phase === 'unconfigured'}
        onConfigure={() => surface?.gate('banner')}
      />
      <span data-testid="phase-marker">{hydrated ? surface?.phase : 'loading'}</span>
      <span data-testid="entry-ids">{entries.map((entry) => entry.modelId).join(',')}</span>
      <span data-testid="current-model">{currentEntry?.modelId ?? ''}</span>
      <DraftProbe />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">{MORE_LABEL}</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <HrOaMoreMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** 生产同构树：HrOaGate → ModelGatewayProvider → HomeOnboardingGateProvider → OnboardingSessionHost。 */
function renderSessionHome() {
  return render(
    <HrOaGate>
      <ModelGatewayProvider>
        <HomeOnboardingGateProvider>
          <OnboardingSessionHost>
            <HomeSurface />
          </OnboardingSessionHost>
        </HomeOnboardingGateProvider>
      </ModelGatewayProvider>
    </HrOaGate>,
  );
}

const welcomeTitle = () => screen.queryByText(WELCOME_TITLE);
const homeSurface = () => screen.queryByTestId('home-surface');
const bannerText = () => screen.queryByText(BANNER_TEXT);
const phaseMarker = () => screen.getByTestId('phase-marker').textContent;
const entryIds = () => screen.getByTestId('entry-ids').textContent;
const currentModel = () => screen.getByTestId('current-model').textContent;
const draftProbe = () => screen.queryByTestId('draft-probe')?.textContent ?? '';
const s3Preview = () => document.body.dataset.hrS3Preview ?? '';
const dialog = () => screen.queryByRole('dialog');

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** S1 → S2 → 填账号密码 → 提交（显式登录生产入口）。 */
async function submitLogin(username: string, password = 'pw'): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '登录' }));
  fireEvent.change(screen.getByLabelText('账号'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /^(登录|登录中…|登录成功)$/ }));
  await flush();
  // FR-LOGIN-04 成功拍 500ms（模拟耗时保留，不随 reduce 归零）。
  await act(async () => {
    vi.advanceTimersByTime(500);
  });
  await flush();
}

async function pushAuthStateChange(): Promise<void> {
  await act(async () => {
    for (const listener of bridge.listeners) listener({});
  });
  await flush();
}

/** 通过弹窗真实保存一个模型（探测 → 落库 → ✓已保存 450ms 保持）。 */
async function saveModelThroughDialog(modelId: string): Promise<void> {
  fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://gw.example.test' } });
  fireEvent.change(screen.getByLabelText('密钥'), { target: { value: 'sk-test' } });
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: modelId } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await flush();
  await act(async () => {
    vi.advanceTimersByTime(450);
  });
  await flush();
}

async function openMoreMenu(): Promise<HTMLElement> {
  // Radix DropdownMenu 的 jsdom 打开路径是键盘激活（同 SessionTaskMenu.test 口径）。
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('button', { name: MORE_LABEL }), { key: 'Enter' });
  });
  await flush();
  return screen.getByRole('menu');
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  hrOaStoreTesting.resetHrOaGateMemory();
  window.localStorage.clear();
  bridge.login.mockReset();
  bridge.logout.mockReset();
  bridge.getState.mockReset();
  bridge.listeners.clear();
  bridge.providersByAccount.clear();
  bridge.currentAccountKey = 'P100';
  bridge.getState.mockResolvedValue(SIGNED_OUT);
  installBridge();
  setComposerDraftOwner('P100');
  mockMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete document.body.dataset.hrS3Preview;
  delete document.body.dataset.hrLeave;
});

describe('FR-SESSION-05：显式再登必经 S3，仅启动不弹', () => {
  it('显式登录成功且无模型 → 弹 S3（origin=onboarding）；跳过后进 S4b', async () => {
    vi.useFakeTimers();
    bridge.login.mockImplementation(async () => {
      bridge.currentAccountKey = 'P100';
      bridge.getState.mockResolvedValue(SIGNED_IN_A);
      for (const listener of bridge.listeners) listener({});
      return SIGNED_IN_A;
    });
    renderSessionHome();
    await flush();

    await submitLogin('zhangsan');
    await flush();

    // T3：S3 弹窗（origin=onboarding：有跳过 + 底部提示）出现在预览姿态上。
    expect(homeSurface()).toBeTruthy();
    expect(dialog()).toBeTruthy();
    expect(within(dialog() as HTMLElement).getByText(DIALOG_TITLE)).toBeTruthy();
    expect(within(dialog() as HTMLElement).getByText(SKIP_LABEL)).toBeTruthy();
    expect(within(dialog() as HTMLElement).getByText(SKIP_HINT)).toBeTruthy();
    expect(s3Preview()).toBe('on');

    // T4：跳过 → 弹窗关闭、预览姿态落位（settle）、S4b 横幅出现。
    fireEvent.click(within(dialog() as HTMLElement).getByRole('button', { name: SKIP_LABEL }));
    await flush();
    expect(dialog()).toBeNull();
    expect(s3Preview()).toBe('');
    expect(bannerText()).toBeTruthy();
    expect(phaseMarker()).toBe('unconfigured');
  });

  it('仅启动且登录态有效 → 不弹 S3，只出未配置横幅', async () => {
    bridge.getState.mockResolvedValue(SIGNED_IN_A);
    renderSessionHome();
    await flush();

    // 无显式登录（getState 静默落定 = 启动恢复）：S3 不得出现。
    expect(dialog()).toBeNull();
    expect(homeSurface()).toBeTruthy();
    expect(bannerText()).toBeTruthy();
    expect(phaseMarker()).toBe('unconfigured');
  });
});

describe('FR-SESSION-04 / SC-6：模型配置绑定账号', () => {
  it('同账号再登（已有模型）→ 直接 S4a，不再弹 S3', async () => {
    bridge.providersByAccount.set('P100', [gatewayEntryProvider()]);
    vi.useFakeTimers();
    bridge.login.mockImplementation(async () => {
      bridge.currentAccountKey = 'P100';
      bridge.getState.mockResolvedValue(SIGNED_IN_A);
      for (const listener of bridge.listeners) listener({});
      return SIGNED_IN_A;
    });
    renderSessionHome();
    await flush();

    await submitLogin('zhangsan');
    await flush();

    expect(dialog()).toBeNull();
    expect(bannerText()).toBeNull();
    expect(entryIds()).toContain('gw-model-alpha');
  });

  it('换账号登录看不到上一账号的模型（owner 分区），且新账号无模型仍必经 S3', async () => {
    bridge.providersByAccount.set('P100', [gatewayEntryProvider()]);
    vi.useFakeTimers();
    // 先以 A 登录（S4a 可见 A 的模型）。
    bridge.login.mockImplementation(async (username: string) => {
      const account = username === 'lisi' ? SIGNED_IN_B : SIGNED_IN_A;
      bridge.currentAccountKey = account.accountKey;
      bridge.getState.mockResolvedValue(account);
      for (const listener of bridge.listeners) listener({});
      return account;
    });
    renderSessionHome();
    await flush();
    await submitLogin('zhangsan');
    await flush();
    expect(entryIds()).toContain('gw-model-alpha');

    // 退出 → 换账号 B 登录：B 分区为空，不得看到 A 的模型（SC-6），且必经 S3。
    const menu = await openMoreMenu();
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: LOGOUT_LABEL }));
    });
    await flush();
    expect(welcomeTitle()).toBeTruthy();

    await submitLogin('lisi');
    await flush();
    expect(entryIds()).not.toContain('gw-model-alpha');
    expect(currentModel()).toBe('');
    expect(dialog()).toBeTruthy();
    expect(within(dialog() as HTMLElement).getByText(SKIP_LABEL)).toBeTruthy();
  });
});

describe('FR-SESSION-03 / FR-HOME-03：退出登录', () => {
  it('退出清登录态与草稿、保留模型配置、回 S1，且不弹「登录已过期」', async () => {
    vi.useFakeTimers();
    bridge.providersByAccount.set('P100', [gatewayEntryProvider()]);
    bridge.getState.mockResolvedValue(SIGNED_IN_A);
    renderSessionHome();
    await flush();
    expect(homeSurface()).toBeTruthy();

    // 未发送草稿（owner = 账号键，AuthContext 的 setComposerDraftOwner 同源）。
    await act(async () => {
      saveComposerDraft(DRAFT_KEY, { text: plainTextToTiptapDoc('未发送草稿'), attachments: [] });
    });
    expect(draftProbe()).toBe('has-draft');

    const toastsBefore = getToastSnapshot();
    const menu = await openMoreMenu();
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: LOGOUT_LABEL }));
    });
    await flush();

    // FR-HOME-03 / FR-SESSION-03：回 S1、草稿清除；主动登出**不得**误弹失效 toast
    // ——锁内不弹还不够：转场锁（600ms）走完后也永远不弹（与 FR-SESSION-02 的分界）。
    expect(welcomeTitle()).toBeTruthy();
    expect(homeSurface()).toBeNull();
    expect(getDraft(DRAFT_KEY)).toBeUndefined();
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    let newToasts = getToastSnapshot().filter((item) => !toastsBefore.includes(item));
    expect(newToasts.some((item) => item.message === EXPIRED_TOAST)).toBe(false);

    // 同账号再登：模型配置保留（S4a），草稿不复活（FR-SESSION-03 清除而非隐藏）。
    bridge.login.mockImplementation(async () => {
      bridge.currentAccountKey = 'P100';
      bridge.getState.mockResolvedValue(SIGNED_IN_A);
      for (const listener of bridge.listeners) listener({});
      return SIGNED_IN_A;
    });
    await submitLogin('zhangsan');
    await flush();
    expect(dialog()).toBeNull();
    expect(entryIds()).toContain('gw-model-alpha');
    expect(draftProbe()).toBe('');
    expect(getDraft(DRAFT_KEY)).toBeUndefined();
    newToasts = getToastSnapshot().filter((item) => !toastsBefore.includes(item));
    expect(newToasts.some((item) => item.message === EXPIRED_TOAST)).toBe(false);
  });
});

describe('FR-SESSION-02 / T10：登录态失效', () => {
  it('失效回 S1，toast 在转场锁结束后才弹', async () => {
    vi.useFakeTimers();
    bridge.getState.mockResolvedValue(SIGNED_IN_A);
    renderSessionHome();
    await flush();
    expect(homeSurface()).toBeTruthy();

    const toastsBefore = getToastSnapshot();
    bridge.getState.mockResolvedValue(SIGNED_OUT);
    await pushAuthStateChange();

    // 回 S1 立即发生；toast 卡在 T9 转场锁（600ms）后（PRD T10）。
    expect(welcomeTitle()).toBeTruthy();
    expect(homeSurface()).toBeNull();
    let newToasts = getToastSnapshot().filter((item) => !toastsBefore.includes(item));
    expect(newToasts.some((item) => item.message === EXPIRED_TOAST)).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(599);
    });
    newToasts = getToastSnapshot().filter((item) => !toastsBefore.includes(item));
    expect(newToasts.some((item) => item.message === EXPIRED_TOAST)).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    newToasts = getToastSnapshot().filter((item) => !toastsBefore.includes(item));
    expect(newToasts.some((item) => item.message === EXPIRED_TOAST)).toBe(true);
  });
});

describe('FR-HOME-02 / AC-14：更多 → 自定义', () => {
  it('打开 origin=home 弹窗（无跳过、无底部提示）；保存后入列表并成为当前模型', async () => {
    bridge.getState.mockResolvedValue(SIGNED_IN_A);
    renderSessionHome();
    await flush();
    expect(bannerText()).toBeTruthy();

    // 打开「更多 → 自定义」：弹窗是 origin=home（无跳过按钮、无跳过提示）。
    let menu = await openMoreMenu();
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: CUSTOMIZE_LABEL }));
    });
    await flush();
    expect(dialog()).toBeTruthy();
    expect(within(dialog() as HTMLElement).getByText(DIALOG_TITLE)).toBeTruthy();
    expect(within(dialog() as HTMLElement).queryByText(SKIP_LABEL)).toBeNull();
    expect(within(dialog() as HTMLElement).queryByText(SKIP_HINT)).toBeNull();

    // 关闭回原界面（S4b 不变）。
    fireEvent.click(within(dialog() as HTMLElement).getByRole('button', { name: '取消' }));
    await flush();
    expect(dialog()).toBeNull();
    expect(bannerText()).toBeTruthy();

    // 再开并保存：条目进列表并成为当前模型（S4a）。
    vi.useFakeTimers();
    menu = await openMoreMenu();
    await act(async () => {
      fireEvent.click(within(menu).getByRole('menuitem', { name: CUSTOMIZE_LABEL }));
    });
    await flush();
    await saveModelThroughDialog('gw-model-beta');
    expect(dialog()).toBeNull();
    expect(entryIds()).toContain('gw-model-beta');
    expect(currentModel()).toBe('gw-model-beta');
    expect(bannerText()).toBeNull();
  });
});
