// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`ProfileMenu`（个人弹层，FR-MENU-01~07）与
 *   `ChromeActions` 的 ≡ 下线（D2）。断言用户可观察的弹层合同：结构（身份卡 +
 *   分隔线 + 5 个菜单项 + 分隔线 + `退出登录`）与逐字文案（`问题反馈` 不改名）、
 *   锚点几何（左下对齐 / 6px 间距 / 264px 宽 / 14px 圆角 / 最大高度 = 窗高 − 72）、
 *   四种关闭方式（点外部 / Esc / 选任一项 / Tab 移出）与焦点归还、FR-MENU-07 键盘
 *   （初始焦点 = 第 1 个可用项，获取失败为「重试」；↑↓ 循环 / Home / End /
 *   Enter·Space 执行）、`role="menu"/"menuitem"/"separator"`、设置行 ⌘, 提示、
 *   打开时结果提示全收（FR-MENU-01）、打开时距上次成功 >30 分钟触发 stale 刷新
 *   （FR-PROFILE-07 R5）、以及 HR 模式标题栏不渲染 ≡（D2）而恢复开关一开即回。
 *   另钉 FR-MENU-08 未列项同迁（Ruling E）：mac 全屏「退出全屏」为弹层首项且
 *   选择触发 `exit_fullscreen` 动作，非全屏不显示（≡ 同条件显隐）。
 * - Bug／规则依据：profile-menu PRD FR-MENU-01~08 / FR-PROFILE-07 R5 / FR-WELCOME-03 /
 *   AC-04 / §6.2 迁移对照表；集成设计 §4.6（D2 / OQ-5）；「问题反馈」不改名是 PRD
 *   明文红线；≡ 收起口径 = `SHOW_CINDY_ACCOUNT_UI` 单一恢复开关（legacyVisibility）。
 * - 现有覆盖缺口：仓内只有 ≡（MenuButton）与身份卡（ProfileCard）的单体测试，
 *   无个人弹层的结构 / 键盘 / 关闭 / 锚点几何测试；ChromeActions 现有测试只覆盖
 *   恢复配置（≡ 在场）的全屏兜底与浏览历史，无「≡ 默认不渲染」的下线回归。
 * - 最小失败输入：菜单项顺序或文案（如「意见反馈」）偏离迁移表即失败；弹层锚点
 *   bottom≠内高−入口顶+6 / 宽≠264 / 圆角≠14 即失败；Esc 后焦点不在入口即失败；
 *   失败态初始焦点不在「重试」即失败；默认配置下 ChromeActions 仍渲染 ≡ 即失败。
 * - tier：unit（jsdom + RTL；IPC 以 window.electronAPI 桩注入；无真实网络、无
 *   ≥100ms 真实等待）。
 * - 实测耗时：单文件墙钟约 2.8s（vitest Duration 2.07s / tests 363ms，17 例）。
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { toast } from '@/lib/toast';
import type { PersonProfile } from '../../../../main/hr-oa/profile';
import type { ProfileResult } from '../../../../main/hr-oa/profileService';
import { ChromeActions } from '@/components/layout/ChromeActions';
import { ProfileMenu, type ProfileMenuItem } from '../ProfileMenu';
import type { ProfileState } from '../useHrOaProfile';
import { __testing as profileStoreTesting } from '../useHrOaProfile';

const bridge = vi.hoisted(() => ({
  fetchProfile: vi.fn(),
  getAvatar: vi.fn(),
  getState: vi.fn(),
  listeners: new Set<(payload: unknown) => void>(),
  /** 埋点桥（PRD §11 profile_menu_click 协议断言用）：trackHrOaEvent 的 IPC 落点。 */
  trackEvent: vi.fn(),
  menuCommandListeners: new Set<(command: string) => void>(),
}));

/** ≡ 收起 / 恢复的单一开关（legacyVisibility）：默认 HRBuddy 收起，恢复配置 = 翻回 true。 */
const visibility = vi.hoisted(() => ({ showCindy: false }));

/** macOS 全屏状态（≡ 的 onExitFullscreen 条目随全屏条件显隐，Ruling E）。 */
const fullscreenState = vi.hoisted(() => ({ isMac: true, isFullscreen: false }));

vi.mock('@/features/hr-oa-auth/legacyVisibility', () => ({
  SHOW_CINDY_ACCOUNT_UI: visibility.showCindy,
  isCindyAccountUiVisible: () => visibility.showCindy,
}));
vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => fullscreenState,
}));
vi.mock('@/features/device-link/useSharedTaskTasks', () => ({ useSharedTaskTasks: vi.fn() }));
vi.mock('@/features/device-link/SharedTaskEndedNotice', () => ({ SharedTaskEndedNotice: () => null }));

/** 入口按钮的几何锚点（jsdom 无布局，手造 DOMRect；窗口内高 768）。 */
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

function makeProfile(over: Partial<PersonProfile> = {}): PersonProfile {
  return {
    name: '张三',
    loginName: 'YLS',
    dept: '人力资源部',
    mobile: '13800000000',
    email: 'zhangsan@example.com',
    title: '专员',
    sex: '男',
    personId: 'p-1',
    ...over,
  };
}

function installBridge(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      hrOa: {
        profile: { fetchProfile: bridge.fetchProfile },
        avatar: { getAvatar: bridge.getAvatar },
        getState: bridge.getState,
        trackEvent: bridge.trackEvent,
      },
      onApplicationMenuCommand: (cb: (command: string) => void) => {
        bridge.menuCommandListeners.add(cb);
        return () => bridge.menuCommandListeners.delete(cb);
      },
      onAuthStateChange: (cb: (payload: unknown) => void) => {
        bridge.listeners.add(cb);
        return () => bridge.listeners.delete(cb);
      },
    },
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  // mac 平台 fixture：`open-settings` 快捷键（⌘,）是 darwin-only（menuBacked），
  // jsdom 默认 navigator.platform 非 Mac 会被 appShortcutStore 判成 win32 而隐藏提示。
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: 'MacIntel',
  });
  profileStoreTesting.resetHrOaProfileStore();
  bridge.fetchProfile.mockReset();
  bridge.getAvatar.mockReset();
  bridge.getState.mockReset();
  bridge.trackEvent.mockReset();
  bridge.listeners.clear();
  bridge.menuCommandListeners.clear();
  visibility.showCindy = false;
  fullscreenState.isMac = true;
  fullscreenState.isFullscreen = false;
  bridge.getState.mockResolvedValue({ status: 'signed-out' });
  bridge.getAvatar.mockResolvedValue(null);
  bridge.fetchProfile.mockResolvedValue({ ok: false, kind: 'error' } satisfies ProfileResult);
  installBridge();
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:avatar-stub'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * 生产同形宿主：入口点击开层（再点收层），ProfileMenu 消费 open / anchor /
 * onClose / onAction（UserInfoSection 的挂载方式，见 components/sidebar/UserInfoSection）。
 */
function Harness(props: {
  profileState?: ProfileState;
  initialFocus?: 'first' | 'last';
  onAction?: (item: ProfileMenuItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const { profileState = 'ready', initialFocus, onAction = () => {} } = props;
  return (
    <>
      <button type="button" data-testid="entry" onClick={() => setOpen((v) => !v)}>
        entry
      </button>
      <button type="button" data-testid="after-entry">
        after
      </button>
      <ProfileMenu
        open={open}
        anchor={open ? ANCHOR : null}
        profileState={profileState}
        initialFocus={initialFocus}
        onClose={() => setOpen(false)}
        onAction={onAction}
      />
    </>
  );
}

async function openMenu(options?: { profileState?: ProfileState; initialFocus?: 'first' | 'last' }) {
  render(<Harness profileState={options?.profileState} initialFocus={options?.initialFocus} />);
  await userEvent.click(screen.getByTestId('entry'));
  return screen.getByRole('menu');
}

describe('ProfileMenu · 结构、文案与锚点几何（FR-MENU-01~06）', () => {
  it('结构 = 身份卡 + 分隔线 + 5 个菜单项 + 分隔线 + 退出登录；role=menu/menuitem/separator', () => {
    render(
      <ProfileMenu
        open
        anchor={ANCHOR}
        profileState="ready"
        onClose={() => {}}
        onAction={() => {}}
      />,
    );
    const menu = screen.getByRole('menu');
    // 身份卡（ProfileCard 的 role="group"）+ 2 条分隔线。
    expect(within(menu).getByRole('group', { name: '个人信息' })).toBeTruthy();
    expect(within(menu).getAllByRole('separator')).toHaveLength(2);

    // 迁移对照表顺序与逐字文案（§6.2）：设置 / 资源监视器 / 帮助 / 问题反馈 / 检查更新 / 退出登录。
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      '设置⌘,',
      '资源监视器',
      '帮助',
      '问题反馈',
      '检查更新',
      '退出登录',
    ]);
    // 「问题反馈」不得改名成 WorkBuddy 的「意见反馈」（FR-MENU-05 红线）。
    expect(screen.queryByText('意见反馈')).toBeNull();
  });

  it('设置行右侧显示 ⌘,（FR-MENU-02 快捷键提示，跟随平台格式化）', async () => {
    await openMenu();
    const settings = screen.getByRole('menuitem', { name: /设置/ });
    expect(within(settings).getByText('⌘,')).toBeTruthy();
    expect(settings.getAttribute('aria-keyshortcuts')).toBe('Meta+Comma');
  });

  it('锚点几何：左缘对齐入口、向上留 6px、宽 264 / 圆角 14 / 最大高度 = 窗高 − 72（FR-MENU-01）', () => {
    render(
      <ProfileMenu
        open
        anchor={ANCHOR}
        profileState="ready"
        onClose={() => {}}
        onAction={() => {}}
      />,
    );
    const menu = screen.getByRole('menu');
    // 原型 .profile-pop { left: 0; bottom: calc(100% + 6px) } 的 fixed 换算：
    // left = 入口左缘；底边 = 入口顶边上方 6px；宽度固定 264px。
    expect(menu.style.left).toBe(`${ANCHOR.left}px`);
    expect(menu.style.bottom).toBe(`${window.innerHeight - ANCHOR.top + 6}px`);
    expect(menu.style.width).toBe('264px');
    // 最大高度 = 窗口高度 − 72px，超出内部滚动（FR-MENU-01）。
    expect(menu.style.maxHeight).toBe(`${window.innerHeight - 72}px`);
    expect(menu.className).toContain('overflow-y-auto');
    // 14px 圆角 = §5 登记形状 hrbuddy-profile-menu；阴影同「更多」浮层 --shadow-menu。
    expect(menu.className).toContain('rounded-[14px]');
    expect(menu.className).toContain('shadow-[shadow:var(--shadow-menu)]');
  });
});

describe('ProfileMenu · 关闭与焦点归还（FR-MENU-01 / FR-MENU-07）', () => {
  it('Esc 关闭并把焦点还给个人入口', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const entry = screen.getByTestId('entry');
    await user.click(entry);
    expect(screen.getByRole('menu')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

  it('点外部关闭且不移焦（原型 outside pointerdown 口径）', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId('entry'));
    const first = screen.getByRole('menuitem', { name: /设置/ });
    expect(document.activeElement).toBe(first);

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
    // 外部点击关闭不把焦点抢走（焦点跟随用户点击目标）。
    expect(document.activeElement).not.toBe(first);
    expect(document.activeElement).not.toBe(screen.getByTestId('entry'));
  });

  it('选任一菜单项：执行 onAction 并关闭，焦点还给入口', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    const entry = screen.getByTestId('entry');
    await user.click(entry);

    await user.click(screen.getByRole('menuitem', { name: /资源监视器/ }));
    expect(onAction).toHaveBeenCalledWith('resource_monitor');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(entry);

    // 退出登录同样经 onAction 收口（Task 5 的确认弹窗接在宿主侧）。
    await user.click(entry);
    await user.click(screen.getByRole('menuitem', { name: '退出登录' }));
    expect(onAction).toHaveBeenCalledWith('logout');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(entry);
  });

  /**
   * profile_menu_click 埋点（profile-menu PRD §11）——对外数据协议，失效 = 「迁移项使用量」
   * 指标静默缺失（Task 8 挂账同类：触发点缺一即不上线）。
   * - 生产入口与可观察结果：ProfileMenu 选中项经 `hrOa.trackEvent` 桥发出 profile_menu_click。
   * - Bug／规则依据：PRD §11（item / method 维度）+ FR-MENU-02（⌘, 开着=设置项等价动作）。
   * - 现有覆盖缺口：既有用例只断言 onAction 回调，未断言埋点载荷与 method 分流。
   * - 最小失败输入：鼠标点选 / Enter / `open-settings` 命令三路各一次，断言 name/item/method。
   * - tier：unit（jsdom + RTL，同本文件 fixture）。
   */
  it('profile_menu_click 埋点：点选=pointer、Enter=keyboard、⌘, 命令=shortcut', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    const entry = screen.getByTestId('entry');

    await user.click(entry);
    await user.click(screen.getByRole('menuitem', { name: /资源监视器/ }));
    expect(bridge.trackEvent).toHaveBeenLastCalledWith('profile_menu_click', {
      item: 'resource_monitor',
      method: 'pointer',
    });

    // Enter 激活焦点项 = 合成 click（detail=0）→ method:'keyboard'。
    await user.click(entry);
    screen.getByRole('menuitem', { name: /设置/ }).focus();
    await user.keyboard('{Enter}');
    expect(bridge.trackEvent).toHaveBeenLastCalledWith('profile_menu_click', {
      item: 'settings',
      method: 'keyboard',
    });

    // FR-MENU-02：弹层开着收 `open-settings` 命令 = 设置项快捷键等价动作（method:'shortcut'）。
    await user.click(entry);
    act(() => {
      for (const cb of bridge.menuCommandListeners) cb('open-settings');
    });
    expect(bridge.trackEvent).toHaveBeenLastCalledWith('profile_menu_click', {
      item: 'settings',
      method: 'shortcut',
    });
    expect(onAction).toHaveBeenLastCalledWith('settings');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Tab 关闭并按顺序移走焦点；Shift+Tab 关闭并回到入口（原型 stageFocusables 口径）', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const entry = screen.getByTestId('entry');
    await user.click(entry);

    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
    // 前进 = 继续入口之后的下一个可聚焦元素（弹层收起不占 Tab 序）。
    expect(document.activeElement).toBe(screen.getByTestId('after-entry'));

    await user.click(entry);
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.queryByRole('menu')).toBeNull();
    // 后退 = 入口本身（菜单项不留在 Tab 序里）。
    expect(document.activeElement).toBe(entry);
  });
});

describe('ProfileMenu · 键盘与初始焦点（FR-MENU-07 / AC-04）', () => {
  it('打开后焦点在第 1 个可用项；↑ 打开聚焦最后一项（退出登录）', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId('entry'));
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /设置/ }));
    cleanup();

    render(<Harness initialFocus="last" />);
    await userEvent.click(screen.getByTestId('entry'));
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '退出登录' }));
  });

  it('获取失败时初始焦点为「重试」（第 1 个可用项）', async () => {
    render(<Harness profileState="error" />);
    await userEvent.click(screen.getByTestId('entry'));
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '重试' }));
  });

  it('↑/↓ 循环移动焦点，Home/End 跳首末项', async () => {
    const user = userEvent.setup();
    await openMenu();
    const items = [
      screen.getByRole('menuitem', { name: /设置/ }),
      screen.getByRole('menuitem', { name: /资源监视器/ }),
      screen.getByRole('menuitem', { name: '退出登录' }),
    ];

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(items[2]);
    // 末项再 ↓ 循环回首项；首项 ↑ 循环到末项。
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(items[2]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(items[0]);
  });

  it('Enter / Space 执行当前项（onAction）并收起', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    await user.click(screen.getByTestId('entry'));

    await user.keyboard('{Enter}');
    expect(onAction).toHaveBeenCalledWith('settings');
    expect(screen.queryByRole('menu')).toBeNull();
    onAction.mockClear();

    await user.click(screen.getByTestId('entry'));
    await user.keyboard(' ');
    expect(onAction).toHaveBeenCalledWith('settings');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ProfileMenu · 打开收口（FR-MENU-01）与 stale 刷新（FR-PROFILE-07 R5）', () => {
  it('打开时结果提示全部收口（toast.dismissAll）', async () => {
    const dismissAll = vi.spyOn(toast, 'dismissAll');
    render(<Harness />);
    expect(dismissAll).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('entry'));
    expect(dismissAll).toHaveBeenCalled();
  });

  it('距上次成功获取超过 30 分钟：打开弹层触发后台 stale 刷新（不回骨架）', async () => {
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile(),
      fromCache: false,
    } satisfies ProfileResult);
    render(<Harness />);
    // 首次取数（launch）落定后制造「30 分钟前成功」的缓存年龄。
    await vi.waitFor(() => expect(bridge.fetchProfile).toHaveBeenCalled());
    profileStoreTesting.ageLastSuccess(31 * 60 * 1000);
    bridge.fetchProfile.mockClear();

    await userEvent.click(screen.getByTestId('entry'));
    expect(bridge.fetchProfile).toHaveBeenCalledWith('stale');
  });
});

describe('≡ 未列项同迁（FR-MENU-08 / Ruling E）：mac 全屏「退出全屏」', () => {
  it('全屏时「退出全屏」为弹层首项（保持 ≡ 相对顺序，先于设置），选择触发 exit_fullscreen 动作', async () => {
    fullscreenState.isFullscreen = true;
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    await user.click(screen.getByTestId('entry'));

    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual([
      '退出全屏',
      '设置⌘,',
      '资源监视器',
      '帮助',
      '问题反馈',
      '检查更新',
      '退出登录',
    ]);

    await user.click(items[0]);
    expect(onAction).toHaveBeenCalledWith('exit_fullscreen');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('非全屏不显示「退出全屏」（与 ≡ 的 onExitFullscreen 条件显隐一致）', async () => {
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: '退出全屏' })).toBeNull();
  });
});

describe('≡ 下线（D2）：HR 模式标题栏不渲染 MenuButton，恢复开关一开即回', () => {
  const idleBrowseHistory = {
    canBack: false,
    canForward: false,
    goBack: () => false,
    goForward: () => false,
  };

  function renderChrome() {
    return render(
      <MemoryRouter>
        <ChromeActions
          isSidebarCollapsed={false}
          onToggleSidebar={() => {}}
          browseHistory={idleBrowseHistory}
        />
      </MemoryRouter>,
    );
  }

  it('默认（SHOW_CINDY_ACCOUNT_UI=false）标题栏不再显示 ≡；其余图标保留', () => {
    renderChrome();
    // ≡ 的「菜单」触发钮与全屏兜底项都随 ≡ 收起。
    expect(screen.queryByRole('button', { name: '菜单' })).toBeNull();
    expect(screen.queryByRole('button', { name: '退出全屏' })).toBeNull();
    // 其余标题栏图标保留：折叠 + 任务浏览后退/前进（无栈时为「不可用」态）。
    expect(screen.getByRole('button', { name: '收起侧边栏' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '没有上一个任务' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '没有下一个任务' })).toBeTruthy();
  });

  it('恢复配置（SHOW_CINDY_ACCOUNT_UI=true）≡ 整块回来，不需重接线', () => {
    visibility.showCindy = true;
    renderChrome();
    expect(screen.getByRole('button', { name: '菜单' })).toBeTruthy();
  });
});
