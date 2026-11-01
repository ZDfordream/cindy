// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`WelcomeScreen`（S1 欢迎门禁，PRD §6.1 FR-WELCOME-01~03）。
 *   断言页面可感知内容只有吉祥物 + 标题 + 「登录」三件套（无任何进首页入口）、
 *   「登录」默认获焦且 Enter/Space 触发 onLogin、以及 `prefers-reduced-motion: reduce`
 *   时吉祥物不挂浮动/眨眼动效类（FR-WELCOME-01）。
 * - Bug／规则依据：login-onboarding PRD §6.1 FR-WELCOME-01~03（含 G1 门禁：
 *   未登录不得出现首页入口）；任务简报 Step 3 用例矩阵。
 * - 现有覆盖缺口：S1 是新屏，仓库无 hr-oa-auth 测试；旧 LoginPage/品牌屏测试
 *   （LoginHandoffContext）不覆盖 HRBuddy 欢迎门禁的元素收口与焦点合同。
 * - 最小失败输入：渲染后 activeElement 不是「登录」即失败；reduce 下挂上
 *   hr-oa-mascot-float 类即失败；出现第二个按钮（首页入口）即失败。
 * - tier：unit（进程内 RTL 组件测试，matchMedia 桩注入，无真实网络/计时）。
 * - 实测耗时：单文件墙钟约 2.1s（vitest Duration 1.51s，3 例）
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { WelcomeScreen } from '../WelcomeScreen';

/** jsdom 无真实媒体查询：按需桩掉 matchMedia，只认 reduced-motion 查询。 */
function mockMatchMedia(reduce: boolean): void {
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

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  mockMatchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WelcomeScreen 门禁收口（FR-WELCOME-01~03）', () => {
  it('可感知内容只有吉祥物、标题与「登录」；没有进首页入口', () => {
    const { container } = render(<WelcomeScreen onLogin={() => {}} />);

    expect(screen.getByText('HRBuddy，我帮你')).toBeTruthy();
    expect(container.querySelector('svg.hr-oa-mascot')).toBeTruthy();

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toBe('登录');
    // G1：未登录不得出现任何进首页途径（链接/导航都算）。
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('「登录」默认获焦；Enter 与 Space 触发 onLogin', async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn();
    render(<WelcomeScreen onLogin={onLogin} />);

    const button = screen.getByRole('button', { name: '登录' });
    expect(document.activeElement).toBe(button);

    await user.keyboard('{Enter}');
    expect(onLogin).toHaveBeenCalledTimes(1);

    await user.keyboard(' ');
    expect(onLogin).toHaveBeenCalledTimes(2);

    await user.click(button);
    expect(onLogin).toHaveBeenCalledTimes(3);
  });

  it('prefers-reduced-motion: reduce 时吉祥物不挂浮动/眨眼类；正常动效下挂', () => {
    mockMatchMedia(true);
    const reduced = render(<WelcomeScreen onLogin={() => {}} />);
    expect(reduced.container.querySelector('.hr-oa-mascot-float')).toBeNull();
    expect(reduced.container.querySelector('.hr-oa-mascot-blink')).toBeNull();
    cleanup();

    mockMatchMedia(false);
    const normal = render(<WelcomeScreen onLogin={() => {}} />);
    expect(normal.container.querySelector('.hr-oa-mascot-float')).toBeTruthy();
    expect(normal.container.querySelector('.hr-oa-mascot-blink')).toBeTruthy();
  });
});
