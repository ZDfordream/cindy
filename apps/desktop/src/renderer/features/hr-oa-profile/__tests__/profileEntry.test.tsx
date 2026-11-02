// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`ProfileEntry`（侧栏个人信息入口，FR-PROFILE-01/02/04/05）
 *   与其数据源 `useHrOaProfile`（经 `window.electronAPI.hrOa.profile/.avatar` 桥桩取数）。
 *   断言用户可观察的入口合同：加载骨架（28px 圆 + 72×10 条 + 读屏「正在获取个人信息」）、
 *   已获取（姓名 + 首字/图片头像）、失败（人形图标 +「未获取到信息」）、首字规则
 *   （PRD §8.1：中文取第 1 个字、拉丁字母取首字母大写、按 Unicode 码点不拆代理对）、
 *   无头像/头像失败时的品牌蓝首字兜底、点击 / Enter / Space / ↓ 打开弹层（焦点首项）、
 *   ↑ 打开并聚焦最后一项、`aria-haspopup="menu"` / `aria-expanded` / 动态 aria-label，
 *   以及 FR-PROFILE-01 布局契约（入口 44px 高、头像 28px、姓名 13.5px/500、左右 12px
 *   边距）——jsdom 无布局引擎，几何以组件渲染 class 为对外样式契约断言（改值即视觉违约）。
 * - Bug／规则依据：profile-menu PRD FR-PROFILE-01/02/04/05、§8.1 首字规则、SC-1/SC-4/SC-8；
 *   集成设计 §4.1（头像兜底色）；首字兜底/空姓名人形图标沿 PRD §8.1 表。
 * - 现有覆盖缺口：hr-oa-profile 是本计划新 feature，仓内无侧栏个人入口测试；既有
 *   sidebar/userInfoSection 测试只覆盖 Cindy 账号行（mode !== 'hr' 路径）。
 * - 最小失败输入：无资料在途不出骨架即失败；「张三」首字非「张」即失败；「alice wang」
 *   首字非「A」即失败；↑ 以焦点首项意图开层即失败；失败态缺人形图标/文案即失败；
 *   `aria-haspopup`/`aria-expanded` 缺失即失败；44px/28px/13.5px 几何类被改即失败。
 * - tier：unit（jsdom + RTL；IPC 以 window.electronAPI 桩注入；URL.createObjectURL
 *   为 jsdom 缺失项，文件内桩；无真实网络、无 ≥100ms 真实等待）。
 * - 实测耗时：单文件墙钟约 2.1s（vitest Duration 190ms，11 例）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { PersonProfile } from '../../../../main/hr-oa/profile';
import type { AvatarCache } from '../../../../main/hr-oa/avatar';
import type { ProfileResult } from '../../../../main/hr-oa/profileService';
import { ProfileEntry } from '../ProfileEntry';
import { __testing as profileStoreTesting } from '../useHrOaProfile';

const bridge = vi.hoisted(() => ({
  fetchProfile: vi.fn(),
  getAvatar: vi.fn(),
  getState: vi.fn(),
  listeners: new Set<(payload: unknown) => void>(),
}));

/** 手动落定的取数门：加载态断言必须停在「结果未回」的时刻。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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
  profileStoreTesting.resetHrOaProfileStore();
  bridge.fetchProfile.mockReset();
  bridge.getAvatar.mockReset();
  bridge.getState.mockReset();
  bridge.listeners.clear();
  bridge.getState.mockResolvedValue({ status: 'signed-out' });
  bridge.getAvatar.mockResolvedValue(null);
  installBridge();
  // jsdom 无 createObjectURL：头像字节转 blob URL 的渲染依赖，文件内桩（非真实 Blob 通道）。
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

afterEach(cleanup);

/** 找 className 含给定样式契约片段的元素（jsdom 无布局，几何以 class 契约断言）。 */
function elWithClass(fragment: string): Element | null {
  return [...document.querySelectorAll('*')].find((el) => el.className?.includes?.(fragment)) ?? null;
}

function renderEntry(
  onOpen: (options?: { focus?: 'first' | 'last'; method?: 'pointer' | 'keyboard' }) => void = () => {},
) {
  return render(<ProfileEntry onOpen={onOpen} expanded={false} />);
}

describe('ProfileEntry · 加载 / 已获取 / 失败三态（FR-PROFILE-01/02/04/05）', () => {
  it('加载态：28px 骨架圆 + 72×10 骨架条，读屏文案「正在获取个人信息」（FR-PROFILE-04）', async () => {
    const gate = deferred<ProfileResult>();
    bridge.fetchProfile.mockReturnValue(gate.promise);
    renderEntry();

    // 骨架在取数结果落定前必须可见（FR-PROFILE-04：骨架与内容尺寸一致，切换不跳动）。
    const busy = await screen.findByText('正在获取个人信息');
    expect(busy).toBeTruthy();
    expect(elWithClass('w-[72px]')).toBeTruthy();
    expect(elWithClass('h-2.5')).toBeTruthy();
    expect(elWithClass('h-7 w-7')).toBeTruthy();
    const entry = screen.getByRole('button');
    expect(entry.getAttribute('aria-busy')).toBe('true');
  });

  it('已获取：显示姓名；中文名首字取第 1 个字、拉丁名首字母大写（PRD §8.1）', async () => {
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile({ name: '张三' }),
      fromCache: false,
    } satisfies ProfileResult);
    renderEntry();
    expect(await screen.findByText('张三')).toBeTruthy();
    // 首字兜底（头像未回前）：「张」而不是「张三」或拼音首字母。
    expect(await screen.findByText('张')).toBeTruthy();

    // 换人（拉丁名）：镜像是模块级（跨重挂载保留），手动复位后新取数生效。
    cleanup();
    profileStoreTesting.resetHrOaProfileStore();
    bridge.fetchProfile.mockClear();
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile({ name: 'alice wang' }),
      fromCache: false,
    } satisfies ProfileResult);
    renderEntry();
    expect(await screen.findByText('alice wang')).toBeTruthy();
    expect(await screen.findByText('A')).toBeTruthy();
  });

  it('码点取首字：复姓/代理对不拆分（§8.1「按 Unicode 码点计算，不拆分代理对」）', async () => {
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile({ name: '欧阳锋' }),
      fromCache: false,
    } satisfies ProfileResult);
    renderEntry();
    expect(await screen.findByText('欧阳锋')).toBeTruthy();
    expect(await screen.findByText('欧')).toBeTruthy();
  });

  it('头像字节就绪时渲染图片层，首字兜底仍在下层（FR-PROFILE-02 图片淡入覆盖）', async () => {
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile(),
      fromCache: false,
    } satisfies ProfileResult);
    const bytes = new Uint8Array([1, 2, 3]);
    bridge.getAvatar.mockResolvedValue({
      key: 'p-1stub',
      bytes,
      contentType: 'image/png',
    } satisfies AvatarCache);
    renderEntry();

    // 图片层是装饰（alt=''，首字才是可读锚点）；加载完成淡入覆盖，但兜底不得被移除。
    await waitFor(() => {
      expect(document.querySelector('img')?.getAttribute('src')).toContain('blob:');
    });
    expect(screen.getByText('张')).toBeTruthy();
  });

  it('无头像（getAvatar 回 null）：品牌蓝首字兜底（ready-avatar-fallback，SC-4）', async () => {
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile(),
      fromCache: false,
    } satisfies ProfileResult);
    bridge.getAvatar.mockResolvedValue(null);
    renderEntry();

    expect(await screen.findByText('张三')).toBeTruthy();
    const initial = await screen.findByText('张');
    // 品牌蓝圆底 = FR-PROFILE-02 / 集成设计 §4.1 的 --hr-oa-fallback-bg。
    expect(initial.className).toContain('bg-[var(--hr-oa-fallback-bg)]');
  });

  it('头像图片加载失败（img onError）：退回品牌蓝首字兜底（SC-4）', async () => {
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile(),
      fromCache: false,
    } satisfies ProfileResult);
    bridge.getAvatar.mockResolvedValue({
      key: 'p-1stub',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    } satisfies AvatarCache);
    renderEntry();

    await waitFor(() => {
      expect(document.querySelector('img')).toBeTruthy();
    });
    fireEvent.error(document.querySelector('img')!);
    // 图片失败后兜底仍在（首字在图片层之下），界面不空窗。
    expect(screen.getByText('张')).toBeTruthy();
    expect(screen.getByText('张').className).toContain('bg-[var(--hr-oa-fallback-bg)]');
  });

  it('获取失败且无缓存：人形图标 +「未获取到信息」（FR-PROFILE-05）', async () => {
    bridge.fetchProfile.mockResolvedValue({ ok: false, kind: 'error' } satisfies ProfileResult);
    renderEntry();

    expect(await screen.findByText('未获取到信息')).toBeTruthy();
    // 空姓名人形图标（§8.1）：灰底兜底容器 + UserRound 图标（不是首字）。
    const emptyHolder = elWithClass('bg-[var(--hr-oa-fallback-empty)]');
    expect(emptyHolder).toBeTruthy();
    expect(emptyHolder?.querySelector('svg')).toBeTruthy();
  });
});

describe('ProfileEntry · 键盘与开层意图（FR-PROFILE-01 / SC-8）', () => {
  async function renderReady(onOpen: ReturnType<typeof vi.fn>) {
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile(),
      fromCache: false,
    } satisfies ProfileResult);
    renderEntry(onOpen);
    await screen.findByText('张三');
    return screen.getByRole('button');
  }

  it('点击 / Enter / Space / ↓ 打开弹层（焦点首项语义）', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const entry = await renderReady(onOpen);

    // method（profile-menu PRD §11 profile_menu_open）随开层意图一并传出：点击=pointer、
    // 键盘=keyboard——埋点维度的契约，形状整体钉死。
    await user.click(entry);
    expect(onOpen).toHaveBeenLastCalledWith({ focus: 'first', method: 'pointer' });

    entry.focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenLastCalledWith({ focus: 'first', method: 'keyboard' });

    await user.keyboard(' ');
    expect(onOpen).toHaveBeenLastCalledWith({ focus: 'first', method: 'keyboard' });

    await user.keyboard('{ArrowDown}');
    expect(onOpen).toHaveBeenLastCalledWith({ focus: 'first', method: 'keyboard' });
  });

  it('↑ 打开并聚焦最后一项（focus last）', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const entry = await renderReady(onOpen);

    entry.focus();
    await user.keyboard('{ArrowUp}');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenLastCalledWith({ focus: 'last', method: 'keyboard' });
  });

  it('aria-haspopup="menu"、aria-expanded 随展开标记切换、aria-label 随资料变化', async () => {
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile(),
      fromCache: false,
    } satisfies ProfileResult);
    const { rerender } = render(<ProfileEntry onOpen={() => {}} expanded={false} />);
    const entry = await screen.findByRole('button');
    expect(entry.getAttribute('aria-haspopup')).toBe('menu');
    expect(entry.getAttribute('aria-expanded')).toBe('false');
    expect(entry.getAttribute('aria-label')).toBe('个人信息与菜单：张三');

    rerender(<ProfileEntry onOpen={() => {}} expanded />);
    expect(entry.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ProfileEntry · FR-PROFILE-01 布局契约（几何 class 即对外样式契约）', () => {
  it('入口 44px 高、头像 28px、姓名 13.5px/500、左右 12px 边距（改值 = 视觉违约）', async () => {
    bridge.fetchProfile.mockResolvedValue({
      ok: true,
      profile: makeProfile(),
      fromCache: false,
    } satisfies ProfileResult);
    renderEntry();
    const entry = await screen.findByRole('button');

    // PRD FR-PROFILE-01：高 44px、圆角 10px（§5 `hrbuddy-profile-entry` 登记形状）。
    expect(entry.className).toContain('h-11');
    expect(entry.className).toContain('rounded-[10px]');
    // 姓名 13.5px / 500（FR-PROFILE-01；13.5px 走 §3 排版豁免登记）。
    const name = await screen.findByText('张三');
    expect(name.className).toContain('text-[13.5px]');
    expect(name.className).toContain('font-medium');
    // 头像 28px（h-7 = 1.75rem）。
    expect(elWithClass('h-7 w-7')).toBeTruthy();
    // 左右各 12px 边距（px-3 = 12px）在入口容器上。
    expect(entry.parentElement?.className).toContain('px-3');
  });
});
