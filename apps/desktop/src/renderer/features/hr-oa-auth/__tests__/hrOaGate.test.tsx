// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`HrOaGate`（路由门禁，PRD G1 / FR-WELCOME-03 / FR-SESSION-02）。
 *   断言用户可观察的门禁合同：未登录任何路由只出 S1 且不渲染 children（含深链/副窗同
 *   根挂载）、S1↔S2 往返、显式登录成功**停留成功拍后**才进 children、静默重登落定前
 *   不判决（加载期不出 S1 防闪现、落定 signed-in 直接进 children）、登录态失效推送回
 *   S1 + toast「登录已过期，请重新登录」、`XDT_UI_MOCK`（`uiMockData`）旁路直出
 *   children、以及 `SHOW_CINDY_ACCOUNT_UI === false` 时门禁面无任何 Cindy 账号入口
 *   （LoginPage 标记 / 账号切换 / local 免登录 / SSO）。
 * - Bug／规则依据：login-onboarding PRD G1（未登录只有 S1/S2）/ FR-WELCOME-03 /
 *   FR-SESSION-02；任务简报 Task 4 Step 1 用例矩阵；mock 评审通道
 *   （docs/dev-rules/ui-mock-data.md）不得被门禁截断。
 * - 现有覆盖缺口：门禁是新组件，仓库无路由门禁测试；welcomeScreen/loginScreen 测试
 *   只覆盖单屏，不覆盖「门禁 ↔ children ↔ 推送」的落差与旁路。
 * - 最小失败输入：signed-out 渲染出 children 标记即失败；state 未落定就出 S1 即失败
 *   （静默重登闪现回归）；had-session→signed-out 不出 toast 即失败；uiMockData=true
 *   出 S1 即失败（mock 通道被截断）。
 * - tier：unit（进程内 RTL 组件测试，IPC 以 window.electronAPI 桩注入，500ms 成功
 *   停留走 fake timers，无真实网络）。
 * - 实测耗时：单文件墙钟约 2.3s（vitest Duration 2.1s，8 例）
 *
 * AppSessionMode 分支审计（任务简报 Step 3，回归护栏记录）：
 * 全仓 `mode === 'cloud'|'local'|'signed-out'` 判据 ~112 处，`'hr'` 的预期走法是
 * 「云功能全关、local UI 全关、账号切换全关」——`mode === 'cloud'` 为假即天然关停，
 * 不逐条改判。以下是**协议护栏**（判据改错即出事故）与本任务已改点：
 * - `GuestRoute`：`'hr'` 必须弹走 /login——否则 HR 已登录用户撞见 Cindy LoginPage
 *   （Cindy 账号层泄漏）。
 * - `authManager.initialize()`：mode==='hr' 必须早退返回现状——冷启动收敛
 *   （finishColdStartSignedOut）会把 hr 会话打回 signed-out，把 HR 登录踢下线。
 * - `LocalDbGate` 的 leave：`'hr'` 不得走 Cindy `logout()`（会 commit signed-out
 *   踩掉 hr 会话），必须走 `hrOa.logout`。
 * - `sidebarSettingsStore`：`'hr'` 走 local 同路（ready、不认领 legacy 全局文件）——
 *   挡成 blocked 会让 HR 侧栏置顶/隐藏设置全部写失败；认领 legacy 会跨账号污染。
 * - `appCapabilities`（canUseCindy* 全套）：`'hr'` 恒 false 是**有意的**护栏，
 *   Cindy 账号平面服务对 HR 会话必须全关；失效后果是 HR 会话越权调用 Cindy 云服务。
 * - `heartbeatService` / `device-link` / `im/ownerScopedStorage` / `contacts-sync` /
 *   `model-access` 配额 / `usage/claudeAccountUsage`：`mode==='cloud'` 门保持不动
 *   ——云功能对 `'hr'` 关闭是正确行为。
 * - 云/HR 插件市场（plugin-market `captureMarketOwner`）暂挡 `'hr'`（fail-closed），
 *   归后续任务裁决 HR 插件可见性口径，不在本任务放宽。
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { getToastSnapshot } from '@/lib/toast';
import { HrOaGate } from '../HrOaGate';
import { __testing as hrOaStoreTesting } from '../hrOaAuthStore';
import { SHOW_CINDY_ACCOUNT_UI } from '../legacyVisibility';

const bridge = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  getState: vi.fn(),
  listeners: new Set<(payload: unknown) => void>(),
}));

const PROFILE = {
  name: '张三',
  loginName: 'zhangsan',
  dept: '人力资源部',
  mobile: '',
  email: '',
  title: '',
  sex: '男',
  personId: 'P100',
};
const SIGNED_IN = { status: 'signed-in', accountKey: 'P100', profile: PROFILE };

function installBridge(options?: { uiMockData?: boolean }): void {
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
      uiMockData: options?.uiMockData === true,
    },
  });
}

/** jsdom 无真实媒体查询：吉祥物 prefers-reduced-motion 探测需要桩。 */
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

function renderGate() {
  return render(
    <HrOaGate>
      <div data-testid="children-marker">main-app</div>
    </HrOaGate>,
  );
}

/**
 * 模拟 `OwnerScopedRouter` 的 ownerKey 重挂载：每次 hr 落定（登录 commit 账号键 /
 * 登出 commit null）都会改 `dataOwnerId` → RouterProvider 换 key → 整棵路由树
 * （含门禁）重建。gateKey 变化即重挂载。
 */
function KeyedGate({ gateKey }: { gateKey: number }) {
  return (
    <HrOaGate key={gateKey}>
      <div data-testid="children-marker">main-app</div>
    </HrOaGate>
  );
}

const childrenMarker = () => screen.queryByTestId('children-marker');
const welcomeTitle = () => screen.queryByText('HRBuddy，我帮你');
const accountField = () => screen.getByLabelText('账号') as HTMLInputElement;
const passwordField = () => screen.getByLabelText('密码') as HTMLInputElement;
const submitButton = () =>
  screen.getByRole('button', { name: /^(登录|登录中…|登录成功)$/ }) as HTMLButtonElement;

/** 模拟 main 侧 auth:state-change 推送（useHrOaAuth 据此重拉 hrOa:state）。 */
async function fireAuthStateChange(): Promise<void> {
  for (const listener of bridge.listeners) listener({});
  await Promise.resolve();
}

async function pushAuthStateChange(): Promise<void> {
  await act(async () => {
    await fireAuthStateChange();
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  hrOaStoreTesting.resetHrOaGateMemory();
  bridge.login.mockReset();
  bridge.logout.mockReset();
  bridge.getState.mockReset();
  bridge.listeners.clear();
  bridge.getState.mockResolvedValue({ status: 'signed-out' });
  mockMatchMedia();
  installBridge();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('HrOaGate 门禁收口（G1 / FR-WELCOME-03）', () => {
  it('未登录只出 S1、不渲染 children；无任何 Cindy 账号入口', async () => {
    renderGate();
    await act(async () => {});

    expect(welcomeTitle()).toBeTruthy();
    expect(childrenMarker()).toBeNull();
    // G1：门禁面只有 S1 三件套，不出现 LoginPage（账号切换 / local 免登录 / SSO）的痕迹。
    expect(screen.queryByText('跳过登录')).toBeNull();
    expect(screen.queryByText('选择一种方式安全登录')).toBeNull();
    expect(screen.queryByText('使用企业 SSO 登录')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('S1 点登录 → S2；S2 返回与 Esc → S1', async () => {
    const user = userEvent.setup();
    renderGate();
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(accountField()).toBeTruthy();
    expect(welcomeTitle()).toBeNull();

    await user.click(screen.getByRole('button', { name: '返回' }));
    expect(welcomeTitle()).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '登录' }));
    fireEvent.keyDown(accountField().closest('form') as HTMLFormElement, { key: 'Escape' });
    expect(welcomeTitle()).toBeTruthy();
  });

  it('登录成功停留「登录成功」拍后才渲染 children', async () => {
    vi.useFakeTimers();
    // 生产链路：manager.settle 先投影并广播 auth:state-change（早于 hrOa:login 的
    // invoke 回包），门禁经推送重拉 hrOa:state 得知会话落定。测试按同一时序模拟。
    bridge.login.mockImplementation(async () => {
      bridge.getState.mockResolvedValue(SIGNED_IN);
      await fireAuthStateChange();
      return SIGNED_IN;
    });
    renderGate();
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    fireEvent.change(accountField(), { target: { value: 'alice' } });
    fireEvent.change(passwordField(), { target: { value: 'pw' } });
    fireEvent.click(submitButton());
    await act(async () => {});

    // 成功拍（FR-LOGIN-04 / §9.2 500ms）期间不得切走 S2。
    expect(submitButton().textContent).toBe('登录成功');
    expect(childrenMarker()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(childrenMarker()).toBeTruthy();
    expect(welcomeTitle()).toBeNull();
  });

  it('静默重登落定前不判决：加载期不出 S1 也不出 children，落定 signed-in 直接进 children', async () => {
    let settle!: (state: unknown) => void;
    bridge.getState.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    renderGate();
    await act(async () => {});

    // 门禁在 hrOa:state 落定前不判决：既不闪 S1，也不露出主界面空壳。
    expect(containerEmpty()).toBe(true);

    await act(async () => {
      settle(SIGNED_IN);
    });
    expect(childrenMarker()).toBeTruthy();
    expect(welcomeTitle()).toBeNull();
  });

  it('登录态失效推送 → 回 S1 + toast「登录已过期，请重新登录」', async () => {
    bridge.getState.mockResolvedValue(SIGNED_IN);
    renderGate();
    await act(async () => {});
    expect(childrenMarker()).toBeTruthy();

    const toastsBefore = getToastSnapshot();
    bridge.getState.mockResolvedValue({ status: 'signed-out' });
    await pushAuthStateChange();

    expect(welcomeTitle()).toBeTruthy();
    expect(childrenMarker()).toBeNull();
    const newToasts = getToastSnapshot().filter((item) => !toastsBefore.includes(item));
    expect(newToasts.some((item) => item.message === '登录已过期，请重新登录')).toBe(true);
  });

  it('登录态失效 toast 跨 ownerKey 重挂载仍弹出（FR-SESSION-02 回归）', async () => {
    bridge.getState.mockResolvedValue(SIGNED_IN);
    const { rerender } = render(<KeyedGate gateKey={1} />);
    await act(async () => {});
    expect(childrenMarker()).toBeTruthy();

    const toastsBefore = getToastSnapshot();
    // 生产时序：auth:state-change 推送同时触发 hrOa:state 重拉与 AuthContext 的
    // dataOwnerId 更新（ownerKey 变）→ RouterProvider 整树重挂载。旧门禁实例在
    // 重拉回包**之前**被卸载（cancelled 丢弃），失效落差必须由模块级记忆接手。
    let settleNext!: (state: unknown) => void;
    bridge.getState.mockReturnValue(new Promise((resolve) => (settleNext = resolve)));
    await act(async () => {
      for (const listener of bridge.listeners) listener({});
      await Promise.resolve();
    });
    rerender(<KeyedGate gateKey={2} />);
    await act(async () => {
      settleNext({ status: 'signed-out' });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(welcomeTitle()).toBeTruthy();
    expect(childrenMarker()).toBeNull();
    const newToasts = getToastSnapshot().filter((item) => !toastsBefore.includes(item));
    expect(newToasts.some((item) => item.message === '登录已过期，请重新登录')).toBe(true);
  });

  it('显式登录的「登录成功」拍跨 ownerKey 重挂载不被吞（FR-LOGIN-04 回归）', async () => {
    vi.useFakeTimers();
    bridge.getState.mockResolvedValue({ status: 'signed-out' });
    const { rerender } = render(<KeyedGate gateKey={1} />);
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    fireEvent.change(accountField(), { target: { value: 'alice' } });
    fireEvent.change(passwordField(), { target: { value: 'pw' } });
    let resolveLogin!: (value: unknown) => void;
    bridge.login.mockReturnValue(new Promise((resolve) => (resolveLogin = resolve)));
    fireEvent.click(submitButton());

    // 生产时序：manager.settle 的投影推送早于 hrOa:login 的 invoke 回包；推送携带
    // 新 dataOwnerId → ownerKey 重挂载把 S2（含 500ms 成功拍 timer）整棵卸载。
    await act(async () => {
      bridge.getState.mockResolvedValue(SIGNED_IN);
      await fireAuthStateChange();
      await Promise.resolve();
    });
    rerender(<KeyedGate gateKey={2} />);
    await act(async () => {
      resolveLogin(SIGNED_IN);
      await Promise.resolve();
      await Promise.resolve();
    });

    // 拍仍在：不得进 children；成功面（FR-LOGIN-04）在重挂载后续上。
    expect(childrenMarker()).toBeNull();
    expect(screen.getByRole('button', { name: '登录成功' })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(childrenMarker()).toBeTruthy();
    expect(welcomeTitle()).toBeNull();
  });

  it('offline（静默重登网络类失败）同样放行：离线首页可读，不锁在门外', async () => {
    bridge.getState.mockResolvedValue({
      status: 'offline',
      accountKey: 'P100',
      profile: PROFILE,
    });
    renderGate();
    await act(async () => {});

    expect(childrenMarker()).toBeTruthy();
    expect(welcomeTitle()).toBeNull();
  });

  it('uiMockData（XDT_UI_MOCK）旁路：跳过门禁直接渲染 children', async () => {
    installBridge({ uiMockData: true });
    bridge.getState.mockResolvedValue({ status: 'signed-out' });
    renderGate();
    await act(async () => {});

    expect(childrenMarker()).toBeTruthy();
    expect(welcomeTitle()).toBeNull();
  });

  it('SHOW_CINDY_ACCOUNT_UI 为 false（藏不删：Cindy 账号层整体收起）', () => {
    expect(SHOW_CINDY_ACCOUNT_UI).toBe(false);
  });
});

/** 加载期容器应为空（无 S1、无 children、无登录表单）。 */
function containerEmpty(): boolean {
  return (
    childrenMarker() === null
    && welcomeTitle() === null
    && screen.queryByLabelText('账号') === null
    && screen.queryByRole('button') === null
  );
}
