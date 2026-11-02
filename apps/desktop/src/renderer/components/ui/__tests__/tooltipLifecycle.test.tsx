// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：`Tip`（所有图标提示的生命周期宿主，BUG-TOOLTIP-01）与真实
 *   菜单触发面 `MenuButton`（标题栏 ≡）。可观察结果 = 提示的出现/消失时机：
 *   悬停 500ms / Tab 聚焦出现；离开、按下、点击、Esc、窗口失焦、滚动、菜单打开立即消失；
 *   菜单关闭后焦点回到图标不再出现；300ms 内移到相邻图标立即显示（不重新计时）；
 *   未悬停时不常驻。
 * - Bug／规则依据：BUG-TOOLTIP-01（profile-menu PRD §6.5 TT-01~TT-12 + PRD 四条回归
 *   自测）。原始症状：≡ 的「菜单」提示未悬停仍常驻遮挡内容；菜单关闭后焦点回到 ≡ 提示再弹。
 * - 现有覆盖缺口：`MenuButton.test.tsx` 只盖「菜单打开时提示消失」；
 *   `tipControlledOpen.test.tsx` 只盖受控切换不告警。悬停延迟、立即消失（按下/点击/Esc/
 *   失焦/滚动）、相邻图标 skip 窗口、焦点回返抑制均无用例。
 * - 最小失败输入：修前必红——①点 ≡ 开菜单后按 Esc，焦点回到 ≡ 时提示再现；②悬停中
 *   window blur 提示不消失；③滚动不含 trigger 的容器提示不消失；④300ms 内移到相邻图标
 *   仍要等 500ms。修前已绿（钉回归）：悬停 500ms 出现/移开立即消失、Tab 聚焦出现/离开消失、
 *   按下/点击/Esc 立即消失。
 * - tier：unit（jsdom + RTL fireEvent；vi.useFakeTimers；无真实网络、无 ≥100ms 真实等待）。
 * - 实测耗时：单文件墙钟约 4.1s（vitest Duration 2.9s，9 例），5s 预算内。
 *
 * TT 编号映射（PRD 正文不在仓内，编号按任务规则清单顺序钉死）：
 * TT-01 悬停 500ms 出现｜TT-02 Tab 聚焦出现｜TT-03 离开 0ms 消失｜TT-04 按下 0ms 消失｜
 * TT-05 点击 0ms 消失｜TT-06 Esc 0ms 消失｜TT-07 窗口失焦 0ms 消失｜TT-08 滚动 0ms 消失｜
 * TT-09 菜单打开 0ms 消失｜TT-10 菜单关闭焦点回返不再出现｜TT-11 300ms 相邻图标立即显示｜
 * TT-12 未悬停不常驻。
 */
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Tip } from '../tooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/', search: '' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/checkForUpdateWithToast', () => ({
  checkForUpdateWithToast: vi.fn(),
}));

import { MenuButton } from '@/components/title-bar/MenuButton';

function IconTip({ label }: { label: string }) {
  return (
    <Tip text={label}>
      <button type="button" aria-label={label} />
    </Tip>
  );
}

function tooltip(): HTMLElement | null {
  return screen.queryByRole('tooltip');
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('BUG-TOOLTIP-01 图标提示生命周期（TT-01~TT-12）', () => {
  it('自测 1：悬停「切换侧边栏」0.5s 出现提示，移开立即消失且不常驻 (TT-01/TT-03/TT-12)', () => {
    render(<IconTip label="切换侧边栏" />);
    const trigger = screen.getByRole('button', { name: '切换侧边栏' });

    fireEvent.pointerMove(trigger);
    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(tooltip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tooltip()).not.toBeNull();

    fireEvent.pointerLeave(trigger);
    expect(tooltip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(tooltip()).toBeNull();
  });

  it('自测 2：点击 ≡ 提示消失、菜单打开；Esc 关菜单焦点回到 ≡ 后提示不再出现 (TT-09/TT-10)', () => {
    render(<MenuButton />);
    const trigger = screen.getByRole('button', { name: 'titleBar.menu' });

    fireEvent.pointerMove(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tooltip()).not.toBeNull();

    // 点击 ≡：按下即消失、菜单打开（Radix DropdownMenu 在 pointerdown 开层）。
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(tooltip()).toBeNull();
    // 补齐一次完整点击（含 document pointerup）：让 Tooltip 的 isPointerDownRef 复位，
    // 否则后续焦点回返被 Radix 自己挡住，用例会空转。
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    // Radix FocusScope 把「焦点回到 ≡」挂在 setTimeout(0)（unmount autofocused），
    // 走完这 0ms 复现路径才成立。
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.activeElement).toBe(trigger);
    // BUG-TOOLTIP-01 原始症状：此刻提示不得再现。
    expect(tooltip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(tooltip()).toBeNull();
  });

  it('键盘唤出菜单（无 pointer/无 click）关闭后提示不出现 (TT-10 键盘路径)', () => {
    render(<MenuButton />);
    const trigger = screen.getByRole('button', { name: 'titleBar.menu' });

    // TT-02：Tab 聚焦出现提示——hoverOpen 被置 true，来源=focus（键盘开弹层的前提）。
    act(() => {
      trigger.focus();
    });
    expect(tooltip()).not.toBeNull();

    // Enter 由 Radix DropdownMenuTrigger onKeyDown 处理并 preventDefault——
    // 不产生 pointerdown/click，本用例钉的就是这条没有指针补偿的路径。
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(tooltip()).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(document.activeElement).toBe(trigger);
    // 弹层关闭、控制交回后不得复弹：受迫关闭期间 blur-close 被 useControllableState
    // 吞掉，hoverOpen 不清就会在这一刻亮回来（review Important 复现点）。
    expect(tooltip()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(tooltip()).toBeNull();
  });

  it('自测 3：Tab 聚焦标题栏图标出现提示，焦点离开立即消失 (TT-02)', () => {
    render(
      <>
        <IconTip label="icon-a" />
        <button type="button" aria-label="elsewhere" />
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'icon-a' });

    act(() => {
      trigger.focus();
    });
    expect(tooltip()).not.toBeNull();

    act(() => {
      screen.getByRole('button', { name: 'elsewhere' }).focus();
    });
    expect(tooltip()).toBeNull();
  });

  it('自测 4：悬停时切窗口提示立即消失，切回不出现，指针重新移入才恢复 (TT-07)', () => {
    render(<IconTip label="icon-a" />);
    const trigger = screen.getByRole('button', { name: 'icon-a' });

    fireEvent.pointerMove(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tooltip()).not.toBeNull();

    fireEvent(window, new Event('blur'));
    expect(tooltip()).toBeNull();

    fireEvent(window, new Event('focus'));
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(tooltip()).toBeNull();

    // 「需重新移入」：移出再移入并过完 500ms 才恢复。
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerMove(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tooltip()).not.toBeNull();
  });

  it.each([
    ['按下 pointerdown', (el: HTMLElement) => fireEvent.pointerDown(el, { button: 0, ctrlKey: false })],
    ['点击 click', (el: HTMLElement) => fireEvent.click(el)],
  ])('%s 立即消失 (TT-04/TT-05)', (_name, fire) => {
    render(<IconTip label="icon-a" />);
    const trigger = screen.getByRole('button', { name: 'icon-a' });

    fireEvent.pointerMove(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tooltip()).not.toBeNull();

    fire(trigger);
    expect(tooltip()).toBeNull();
  });

  it('Esc 立即消失 (TT-06)', () => {
    render(<IconTip label="icon-a" />);
    const trigger = screen.getByRole('button', { name: 'icon-a' });

    fireEvent.pointerMove(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tooltip()).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(tooltip()).toBeNull();
  });

  it('滚动任意容器立即消失（不限定滚动容器包含 trigger）(TT-08)', () => {
    render(
      <>
        <IconTip label="icon-a" />
        <div data-testid="scroller" />
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'icon-a' });

    fireEvent.pointerMove(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tooltip()).not.toBeNull();

    fireEvent.scroll(screen.getByTestId('scroller'));
    expect(tooltip()).toBeNull();
  });

  it('300ms 内移到相邻图标立即显示，不重新计时 (TT-11)', () => {
    render(
      <>
        <IconTip label="icon-a" />
        <IconTip label="icon-b" />
      </>,
    );
    const a = screen.getByRole('button', { name: 'icon-a' });
    const b = screen.getByRole('button', { name: 'icon-b' });

    fireEvent.pointerMove(a);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(tooltip()?.textContent).toContain('icon-a');

    fireEvent.pointerLeave(a);
    expect(tooltip()).toBeNull();

    // 移到相邻图标：不重新计 500ms，下一拍即出。
    fireEvent.pointerMove(b);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tooltip()?.textContent).toContain('icon-b');
  });
});
