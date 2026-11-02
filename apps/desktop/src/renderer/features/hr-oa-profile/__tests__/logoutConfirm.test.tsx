// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：真实 `ProfileMenu`（个人弹层末项「退出登录」，FR-LOGOUT-01）→
 *   真实 `LogoutConfirmDialog`（FR-LOGOUT-02）→ 真实 `useHrOaLogoutConfirm` /
 *   `requestHrOaLogout()`（清理清单 + 停任务）→ 真实 `countRunningAgentRuns()`
 *   （Ruling B 口径）。断言用户可观察结果：弹窗几何与文案、有任务时的 N 提示行、
 *   初始焦点 / 焦点陷阱 / 三种关闭路径的焦点归还、确认拍「正在退出…」≥400ms、
 *   落 signed-out **之前**在途 Agent 轮已被真停（Review Focus #1 账号隔离）、
 *   手动退出清草稿而登录态失效保留草稿、失效强退把开着的确认弹窗一并收掉、
 *   「更多」不再承载退出登录（迁移对照表双入口消除）。
 * - Bug／规则依据：profile-menu PRD FR-LOGOUT-01~06 / T15（§9.2 确认拍）；
 *   「进行中任务」口径与「先停后落」顺序（owner 裁定 Ruling B / Review Focus #1：
 *   只靠 UI 卸载会留下旧轮写旧 owner 分区、用旧凭证发请求的隔离漏洞）；草稿分流
 *   沿用 FR-SESSION-02/03；FR-LOGOUT-05 失效强退收确认弹窗。
 * - 现有覆盖缺口：`sessionRules.test.tsx` 钉的是会话规则（草稿 / toast / owner
 *   分区）经「更多 → 退出登录」直出的旧行为，无确认弹窗、无任务中断、无 T15 拍；
 *   `profileMenu.test.tsx` 只钉弹层结构与键盘，`onAction('logout')` 后的行为无覆盖。
 * - 最小失败输入：弹窗宽≠400 / 圆角≠22 即失败；有 2 个在途轮时提示行不出现「2」即失败；
 *   确认后 400ms 内落 signed-out 即失败；`hrOa.logout` 被调用时仍有会话在跑即失败
 *   （停任务必须先于 commit）；失效后草稿消失即失败（FR-SESSION-02 要保留）。
 * - tier：unit（jsdom + RTL；IPC 以 window.electronAPI 桩注入；makerChatStore 打桩
 *   为可观察 Map + stopSession 记录序——同 AccountSwitcherDialog.test 口径；无真实
 *   网络、无 ≥100ms 真实等待，T15 / 转场锁全走 fake timers）。
 * - 实测耗时：单文件墙钟 3.34s（vitest Duration；9 例执行 269ms，其余为收集/环境）——
 *   预算内（pnpm --dir apps/desktop exec vitest run
 *   src/renderer/features/hr-oa-profile/__tests__/logoutConfirm.test.tsx）。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import {
  discardDraft,
  getDraft,
  plainTextToTiptapDoc,
  saveDraft as saveComposerDraft,
  setComposerDraftOwner,
} from '@/lib/composerDraftStore';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HrOaMoreMenuItems } from '@/features/hr-oa-auth/HrOaMoreMenuItems';
import {
  HR_OA_LOGOUT_CONFIRM_BEAT_MS,
  __testing as hrOaStoreTesting,
  useHrOaAuth,
} from '@/features/hr-oa-auth/hrOaAuthStore';
import { ProfileMenu, type ProfileMenuItem } from '../ProfileMenu';
import { LogoutConfirmDialog, useHrOaLogoutConfirm } from '../LogoutConfirmDialog';
import { countRunningAgentRuns, registerRunningTaskStore } from '../runningTasks';
// 仅类型引用（vi.mock 的模块拿类型不受影响；运行时打桩见下）。
import type { SessionStatusInfo } from '@/lib/makerChatStore';

// ── makerChatStore 打桩（AccountSwitcherDialog.test 同口径）：可观察运行快照 +
//    stopSession 调用序，钉「先停后落」的顺序合同。─────────────────────────────
const maker = vi.hoisted(() => ({
  running: new Map<string, SessionStatusInfo>(),
  stopSession: vi.fn(),
  order: [] as string[],
}));

/** 标一条在途 Agent 轮（SessionStatusInfo 的必填面 + isRunning）。 */
function markRunning(sessionId: string): void {
  maker.running.set(sessionId, {
    isRunning: true,
    hasError: false,
    hasPendingAskUser: false,
    hasPendingPermission: false,
    hasPendingPlanReview: false,
    hasPendingPluginSetup: false,
  });
}

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getRunningSnapshot: () => maker.running,
    stopSession: (sessionId: string) => {
      maker.order.push(`stop:${sessionId}`);
      maker.running.delete(sessionId);
      maker.stopSession(sessionId);
    },
    subscribeAll: () => () => {},
    hasPausedQueue: () => false,
    hasRunningWakeTask: () => false,
    hasBackgroundAgentWork: () => false,
    hasSessionTerminalError: () => false,
    hasSessionRecoveryPending: () => false,
    wasLastStopSideTask: () => false,
  },
}));

/** macOS 全屏状态（ProfileMenu「退出全屏」条件项依赖，与本案无关恒 false）。 */
const fullscreenState = vi.hoisted(() => ({ isMac: true, isFullscreen: false }));
vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => fullscreenState,
}));
vi.mock('@/features/device-link/useSharedTaskTasks', () => ({ useSharedTaskTasks: vi.fn() }));
vi.mock('@/features/device-link/SharedTaskEndedNotice', () => ({ SharedTaskEndedNotice: () => null }));
// 「更多 → 自定义」的重依赖（弹窗 / 网关 store）：本文件只断言「更多」不再承载
// 退出登录，条目树的重孩子按边界打桩（不在本案观测面内）。
vi.mock('@/features/model-gateway/OnboardingModelDialog', () => ({
  OnboardingModelDialog: () => null,
}));
vi.mock('@/features/model-gateway/homeOnboardingGate', () => ({
  trackHomeGateTrigger: () => {},
}));
vi.mock('@/features/hr-oa-auth/OnboardingSessionHost', () => ({
  requestHomeCustomizeDialog: () => false,
}));

// ── IPC 桥桩（hrOa.*；推送走 auth:state-change，与生产同链）────────────────────
const bridge = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  getState: vi.fn(),
  fetchProfile: vi.fn(),
  getAvatar: vi.fn(),
  listeners: new Set<(payload: unknown) => void>(),
}));

const PROFILE = {
  name: '张三',
  loginName: 'zhangsan',
  dept: '人力资源部',
  mobile: '',
  email: '',
  title: '',
  sex: '',
  personId: 'P100',
};
const SIGNED_IN = { status: 'signed-in', accountKey: 'P100', profile: PROFILE };
const SIGNED_OUT_LOGOUT = { status: 'signed-out', reason: 'logout' };
const SIGNED_OUT_EXPIRED = { status: 'signed-out', reason: 'expired' };

const TITLE = '确定退出登录？';
const BODY = '退出后需要重新登录才能使用 HRBuddy。';
const CANCEL_LABEL = '取消';
const CONFIRM_LABEL = '退出登录';
const CONFIRMING_LABEL = '正在退出…';
const MORE_LABEL = '更多';
const LOGOUT_ITEM_NAME = '退出登录';
const DRAFT_KEY = 'logout-confirm-draft';

function installBridge(): void {
  // 生产时序：manager.settle 先投影并广播 auth:state-change（早于 invoke 回包）。
  bridge.logout.mockImplementation(async () => {
    maker.order.push('logout');
    bridge.getState.mockResolvedValue(SIGNED_OUT_LOGOUT);
    for (const listener of bridge.listeners) listener({});
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      hrOa: {
        login: bridge.login,
        logout: bridge.logout,
        getState: bridge.getState,
        profile: { fetchProfile: bridge.fetchProfile },
        avatar: { getAvatar: bridge.getAvatar },
      },
      onAuthStateChange: (cb: (payload: unknown) => void) => {
        bridge.listeners.add(cb);
        return () => bridge.listeners.delete(cb);
      },
      uiMockData: false,
      platform: 'darwin',
    },
  });
}

/** 入口按钮的几何锚点（jsdom 无布局，手造 DOMRect；ProfileMenu 开层用）。 */
const ANCHOR = {
  left: 20,
  top: 700,
  width: 181,
  height: 44,
  bottom: 744,
  right: 201,
  x: 20,
  y: 700,
  toJSON: () => ({}),
} as DOMRect;

/**
 * 生产同形宿主（UserInfoSection 的 HrProfileFooter 同款接线）：个人弹层末项
 * `onAction('logout')` → 打开确认弹窗；「更多」浮层只留「自定义」（迁移对照表）。
 */
function MenuHarness() {
  const flow = useHrOaLogoutConfirm();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <button type="button" data-testid="entry" onClick={() => setMenuOpen((v) => !v)}>
        entry
      </button>
      <button type="button" data-testid="after-entry">
        after
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">{MORE_LABEL}</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <HrOaMoreMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
      <ProfileMenu
        open={menuOpen}
        anchor={ANCHOR}
        profileState="ready"
        onClose={() => setMenuOpen(false)}
        onAction={(item: ProfileMenuItem) => {
          if (item === 'logout') flow.openConfirm();
        }}
      />
      <LogoutConfirmDialog
        open={flow.dialogOpen}
        runningTaskCount={flow.runningTaskCount}
        onCancel={flow.cancelConfirm}
        onConfirm={() => void flow.confirmLogout()}
        confirming={flow.confirming}
      />
    </>
  );
}

/** 纯流程宿主（弹窗几何 / 焦点 / T15 拍的合同面）：入口按钮直接走同一确认流程。 */
function FlowHarness() {
  const flow = useHrOaLogoutConfirm();
  return (
    <>
      <button type="button" data-testid="entry" onClick={flow.openConfirm}>
        entry
      </button>
      <button type="button" data-testid="after-entry">
        after
      </button>
      <LogoutConfirmDialog
        open={flow.dialogOpen}
        runningTaskCount={flow.runningTaskCount}
        onCancel={flow.cancelConfirm}
        onConfirm={() => void flow.confirmLogout()}
        confirming={flow.confirming}
      />
    </>
  );
}

const dialog = () => screen.queryByRole('dialog');
const dialogPanel = () => screen.getByRole('dialog');

/**
 * signed-out 落定探针：消费生产 `useHrOaAuth` 的状态镜像，状态真正落成 signed-out
 * （= 用户可见的 S1 切换边界）时记一笔 'settled'，供顺序合同断言与 stop 对照。
 */
function SettleProbe() {
  const { state } = useHrOaAuth();
  useEffect(() => {
    if (state?.status === 'signed-out') maker.order.push('settled');
  }, [state]);
  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    // runningTasks 经动态 import 进 hook（模块静态图卫生）：多放两拍让计数落定。
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  hrOaStoreTesting.resetHrOaGateMemory();
  window.localStorage.clear();
  // mac 平台 fixture（profileMenu.test 同款）：⌘, 提示的平台格式化探测。
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: 'MacIntel',
  });
  bridge.login.mockReset();
  bridge.logout.mockReset();
  bridge.getState.mockReset();
  bridge.fetchProfile.mockReset();
  bridge.getAvatar.mockReset();
  bridge.listeners.clear();
  maker.running.clear();
  maker.stopSession.mockReset();
  maker.order.length = 0;
  bridge.getState.mockResolvedValue(SIGNED_IN);
  bridge.fetchProfile.mockResolvedValue({ ok: false, kind: 'error' });
  bridge.getAvatar.mockResolvedValue(null);
  installBridge();
  setComposerDraftOwner('P100');
  discardDraft(DRAFT_KEY);
  setDataOwnerGeneration('P100', 1);
  // runningTasks 的 store 自登记缝（makerChatStore 装入即自登记；本用例打桩不装入）：
  // 登记可观察 fake，钉「先停后落」的顺序合同（stop 记进 maker.order）。
  registerRunningTaskStore({
    getRunningSnapshot: () => maker.running,
    stopSession: (sessionId: string) => {
      maker.order.push(`stop:${sessionId}`);
      maker.running.delete(sessionId);
      maker.stopSession(sessionId);
    },
  });
  fullscreenState.isMac = true;
  fullscreenState.isFullscreen = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LogoutConfirmDialog · 几何与文案（FR-LOGOUT-02）', () => {
  it('宽 400px / 圆角 22px；标题与正文逐字；无进行中任务时不显示运行提示行', async () => {
    render(<FlowHarness />);
    fireEvent.click(screen.getByTestId('entry'));
    const panel = dialogPanel();
    // PRD FR-LOGOUT-02：400px 确认弹窗宽 + 22px 圆角（§5 登记 hrbuddy-logout-confirm-panel）。
    expect(panel.style.maxWidth).toBe('400px');
    expect(panel.className).toContain('rounded-[22px]');
    expect(screen.getByText(TITLE)).toBeTruthy();
    expect(screen.getByText(BODY)).toBeTruthy();
    expect(screen.queryByText(/正在运行/)).toBeNull();
    expect(screen.getByRole('button', { name: CANCEL_LABEL })).toBeTruthy();
    expect(screen.getByRole('button', { name: CONFIRM_LABEL })).toBeTruthy();
  });

  it('有 N 个进行中任务时增一行「当前有 N 个任务正在运行，退出将中断该任务。」（N=实际数）', async () => {
    markRunning('sess-a');
    markRunning('sess-b');
    render(<FlowHarness />);
    fireEvent.click(screen.getByTestId('entry'));
    expect(countRunningAgentRuns()).toBe(2);
    await flush();
    expect(screen.getByText('当前有 2 个任务正在运行，退出将中断该任务。')).toBeTruthy();
  });
});

describe('LogoutConfirmDialog · 焦点与关闭（FR-LOGOUT-02）', () => {
  it('初始焦点在「取消」；Esc / 点遮罩 / 取消 → 关闭并把焦点还给个人入口', async () => {
    const user = userEvent.setup();
    render(<FlowHarness />);
    const entry = screen.getByTestId('entry');
    // 开弹窗前焦点在个人入口（ProfileMenu 选中后归还焦点的同款时序）。
    entry.focus();
    fireEvent.click(entry);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: CANCEL_LABEL }));

    await user.keyboard('{Escape}');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(entry);

    entry.focus();
    fireEvent.click(entry);
    fireEvent.click(screen.getByRole('button', { name: CANCEL_LABEL }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(entry);

    entry.focus();
    fireEvent.click(entry);
    fireEvent.click(document.querySelector('.modal-scrim')!);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

  it('焦点陷阱在弹窗内：Tab / Shift+Tab 只在「取消 / 退出登录」间循环', async () => {
    const user = userEvent.setup();
    render(<FlowHarness />);
    fireEvent.click(screen.getByTestId('entry'));
    const cancel = screen.getByRole('button', { name: CANCEL_LABEL });
    const confirm = screen.getByRole('button', { name: CONFIRM_LABEL });
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    expect(dialog()).toBeTruthy();
  });
});

describe('确认执行 · T15 拍与任务中断（FR-LOGOUT-02 / Review Focus #1）', () => {
  it('确认后按钮显示「正在退出…」并禁用，至少 400ms 后才落 signed-out', async () => {
    vi.useFakeTimers();
    render(<FlowHarness />);
    fireEvent.click(screen.getByTestId('entry'));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_LABEL }));

    const busy = screen.getByRole('button', { name: CONFIRMING_LABEL });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(bridge.logout).not.toHaveBeenCalled();
    // 先让动态 import（停任务模块）落定、T15 拍计时器起跑，再按拍计时。
    await flush();

    await act(async () => {
      vi.advanceTimersByTime(HR_OA_LOGOUT_CONFIRM_BEAT_MS - 1);
    });
    expect(bridge.logout).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: CONFIRMING_LABEL })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(bridge.logout).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('落 signed-out 前先真停在途 Agent 轮（含伙伴后台轮）：停任务先于 hrOa.logout', async () => {
    vi.useFakeTimers();
    markRunning('sess-a');
    markRunning('sess-b');
    render(<MenuHarness />);
    await flush();

    // 生产链路：个人弹层末项 → 确认弹窗（N=2）→ 确认（fireEvent：fake timers 下
    // userEvent 的内部延迟计时器会挂起，同 T15 用例口径）。
    fireEvent.click(screen.getByTestId('entry'));
    fireEvent.click(screen.getByRole('menuitem', { name: LOGOUT_ITEM_NAME }));
    await flush();
    expect(screen.getByText('当前有 2 个任务正在运行，退出将中断该任务。')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: CONFIRM_LABEL }));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(HR_OA_LOGOUT_CONFIRM_BEAT_MS);
    });
    await flush();

    // 顺序合同（账号隔离）：stop 必须发生在 commit（hrOa.logout）之前——
    // 反序 = 登出后旧轮仍可写旧 owner 分区 / 用旧凭证发请求。
    expect(maker.order).toEqual(['stop:sess-a', 'stop:sess-b', 'logout']);
    expect(bridge.logout).toHaveBeenCalledTimes(1);
  });
});

describe('草稿分流与失效强退（FR-SESSION-02/03 · FR-LOGOUT-05）', () => {
  it('手动退出清草稿；登录态失效保留草稿', async () => {
    vi.useFakeTimers();
    render(<MenuHarness />);
    await flush();
    await act(async () => {
      saveComposerDraft(DRAFT_KEY, { text: plainTextToTiptapDoc('未发送草稿'), attachments: [] });
    });
    expect(getDraft(DRAFT_KEY)).toBeTruthy();

    // 手动路径：个人入口开确认弹窗 → 确认 → FR-SESSION-03 清草稿（fake timers 下
    // 全走 fireEvent，见 T15 用例口径）。
    fireEvent.click(screen.getByTestId('entry'));
    fireEvent.click(screen.getByRole('menuitem', { name: LOGOUT_ITEM_NAME }));
    fireEvent.click(screen.getByRole('button', { name: CONFIRM_LABEL }));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(HR_OA_LOGOUT_CONFIRM_BEAT_MS);
    });
    await flush();
    expect(getDraft(DRAFT_KEY)).toBeUndefined();

    // 同账号再登（投影 signed-in）→ 再存草稿 → 登录态失效：FR-SESSION-02 保留草稿。
    bridge.getState.mockResolvedValue(SIGNED_IN);
    await act(async () => {
      for (const listener of bridge.listeners) listener({});
    });
    await flush();
    await act(async () => {
      saveComposerDraft(DRAFT_KEY, { text: plainTextToTiptapDoc('失效前草稿'), attachments: [] });
    });
    expect(getDraft(DRAFT_KEY)).toBeTruthy();

    bridge.getState.mockResolvedValue(SIGNED_OUT_EXPIRED);
    await act(async () => {
      for (const listener of bridge.listeners) listener({});
    });
    await flush();
    expect(getDraft(DRAFT_KEY)).toBeTruthy();
  });

  it('登录态失效强退同样先真停在途 Agent 轮再落 signed-out（Ruling F 顺序合同）', async () => {
    // 失效强退（FR-LOGOUT-05「同样清理」/ Ruling F：凡落 signed-out 先停）此前只走
    // owner 边界的 renderer 收口（不发 input.stop）——旧轮会继续写旧 owner 分区、
    // 用旧凭证发请求。与确认路径同一顺序钉：stop 必须发生在 signed-out 落定之前。
    markRunning('sess-a');
    markRunning('sess-b');
    render(
      <>
        <SettleProbe />
        <MenuHarness />
      </>,
    );
    await flush();
    expect(countRunningAgentRuns()).toBe(2);

    bridge.getState.mockResolvedValue(SIGNED_OUT_EXPIRED);
    await act(async () => {
      for (const listener of bridge.listeners) listener({});
    });
    await flush();

    // 顺序合同：['stop:*' …, 'settled']——反序（先 settled 后 stop）或漏 stop 即失败。
    expect(maker.order).toEqual(['stop:sess-a', 'stop:sess-b', 'settled']);
  });

  it('确认弹窗开着时登录态失效 → 弹窗一并关闭（FR-LOGOUT-05）', async () => {
    render(<MenuHarness />);
    await flush();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('entry'));
    await user.click(screen.getByRole('menuitem', { name: LOGOUT_ITEM_NAME }));
    expect(dialog()).toBeTruthy();

    bridge.getState.mockResolvedValue(SIGNED_OUT_EXPIRED);
    await act(async () => {
      for (const listener of bridge.listeners) listener({});
    });
    await flush();
    // 失效 toast 的时机由 sessionRules 的 FR-SESSION-02 钉（转场锁末弹出）；这里只钉弹窗收口。
    expect(dialog()).toBeNull();
  });
});

describe('退出入口迁移（迁移对照表：退出登录 → 个人弹层末项）', () => {
  it('「更多」浮层不再承载退出登录；个人弹层末项打开确认弹窗', async () => {
    const user = userEvent.setup();
    render(<MenuHarness />);
    await flush();

    // 旧位置收口：「更多」只有「自定义」，不再有退出登录（双入口消除）。
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: MORE_LABEL }), { key: 'Enter' });
    });
    await flush();
    const moreMenu = screen.getByRole('menu');
    expect(within(moreMenu).queryByRole('menuitem', { name: LOGOUT_ITEM_NAME })).toBeNull();
    expect(within(moreMenu).getByRole('menuitem', { name: '自定义' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await flush();

    // 新位置：个人弹层末项 → 确认弹窗（FR-LOGOUT-01/02）。
    await user.click(screen.getByTestId('entry'));
    const pop = screen.getByRole('menu');
    await user.click(within(pop).getByRole('menuitem', { name: LOGOUT_ITEM_NAME }));
    expect(dialog()).toBeTruthy();
    expect(screen.getByText(TITLE)).toBeTruthy();
  });
});
