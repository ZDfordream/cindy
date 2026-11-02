// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`OnboardingHomeBanner`（S4b 未配置横幅，profile-menu PRD §6.7
 *   FR-HOME-BANNER-01~05 改版后的卡片）与 `ThemeBrandLockup`（品牌行，FR-HOME-REMOVE-02）。
 *   断言用户可观察合同：标题/副文案/「去配置」+ 右箭头与无关闭钮（BANNER-01）、浅品牌色卡
 *   片样式契约（14px 圆角 / 32×32 渐变图标块 / 同宽 w-full / 12px 底距，BANNER-01 规格表）、
 *   「去配置」回调 + 焦点环（BANNER-02）、收起后 `hidden` + `inert` 且可聚焦元素不残留
 *   （BANNER-03 / Review Focus #6）、窄容器 < 520px 按钮换行撑满（BANNER-04）、无
 *   `role="status"` 且图标块 aria-hidden（BANNER-05）、收起/出现动效挂登记 token、
 *   品牌行只保留标识且无「对话」下拉（REMOVE-02）。
 * - Bug／规则依据：profile-menu PRD FR-HOME-BANNER-01~05 / FR-HOME-REMOVE-02 与 §6.7 规格表；
 *   集成设计 §4.7/§4.8（色板/字号登记、双模式、动效走 token）；DESIGN.md §5
 *   `hrbuddy-home-banner`（14px 容器）/ `hrbuddy-home-banner-tile`（10px 图标块）。
 * - 现有覆盖缺口：既有 `homeOnboardingGate.test.tsx` / `sessionRules.test.tsx` 只按门禁两态
 *   查横幅文案有无，不覆盖改版后的卡片规格、收起 `hidden`+`inert`、窄容器布局与品牌行合同。
 * - 最小失败输入：无标题/副文案即失败；出现关闭钮即失败；收起后 wrapper 缺 `hidden` 或
 *   `inert` 即失败；520px 阈值下按钮不换行/不撑满即失败；横幅挂 `role="status"` 即失败；
 *   品牌行内出现 button/下拉即失败。
 * - tier：unit（jsdom + RTL；i18n 走真实 zh-CN；ResizeObserver 文件内桩；无真实等待）。
 * - 实测耗时：单文件 vitest Duration 97ms（9 例，文件墙钟 ~1.1s）。
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import zhCN from '@/i18n/locales/zh-CN/common.json';
import { OnboardingHomeBanner } from '../OnboardingHomeBanner';
import { ThemeBrandLockup } from '@/components/branding/ThemeBrandLockup';

const COPY = zhCN.onboarding.homeBanner as { title: string; sub: string; action: string };

/** jsdom 无 ResizeObserver：文件内桩，测试用 fireWidth 驱动容器宽度。 */
const resizeObservers = new Set<(entries: { contentRect: { width: number } }[]) => void>();
class ResizeObserverStub {
  constructor(private readonly cb: (entries: { contentRect: { width: number } }[]) => void) {
    resizeObservers.add(this.cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    resizeObservers.delete(this.cb);
  }
}
function fireWidth(width: number) {
  act(() => {
    for (const cb of resizeObservers) cb([{ contentRect: { width } }]);
  });
}

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() => {
  // 每例重打桩：afterEach 的 unstubAllGlobals 会摘掉全局，beforeAll 只装一次不够。
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  resizeObservers.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function card(): HTMLElement {
  return screen.getByTestId('home-onboarding-banner').querySelector('[data-banner-card]')!;
}
function wrapper(): HTMLElement {
  return screen.getByTestId('home-onboarding-banner');
}
function action(): HTMLButtonElement {
  return screen.getByTestId('home-onboarding-banner-action') as HTMLButtonElement;
}

describe('FR-HOME-BANNER-01 横幅卡片规格（profile-menu PRD §6.7 规格表）', () => {
  it('渲染标题/副文案/「去配置」+ 右箭头，图标块 aria-hidden，无关闭钮', () => {
    render(<OnboardingHomeBanner visible onConfigure={() => {}} />);
    expect(screen.getByText(COPY.title)).toBeTruthy();
    expect(screen.getByText(COPY.sub)).toBeTruthy();
    expect(screen.getByRole('button', { name: COPY.action })).toBeTruthy();
    // 图标块 aria-hidden（BANNER-05）；「去配置」旁右箭头 14px 由 render 传递，不入可访问名。
    expect(wrapper().querySelector('[data-banner-tile]')?.getAttribute('aria-hidden')).toBe('true');
    // 无关闭（×）按钮：横幅是开始对话的门禁，只在保存模型后消失（BANNER-01）。
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(action().textContent).toContain(COPY.action);
    // 副文案不重复选择器上的「未配置模型」。
    expect(screen.queryByText('未配置模型')).toBeNull();
  });

  it('卡片样式契约：同宽 w-full、14px 圆角、浅品牌色底/边、12px 底距、内边距与间距 12px', () => {
    render(<OnboardingHomeBanner visible onConfigure={() => {}} />);
    // 与输入卡片同宽（左右边缘对齐）：宿主列内 w-full（BANNER-01 位置与宽度）。
    expect(wrapper().className).toContain('w-full');
    const classes = card().className;
    expect(classes).toContain('rounded-[14px]'); // DESIGN.md §5 `hrbuddy-home-banner`
    expect(classes).toContain('bg-[var(--hr-oa-banner-bg)]');
    expect(classes).toContain('border-[var(--hr-oa-banner-line)]');
    expect(classes).toContain('hover:border-[var(--hr-oa-banner-line-hover)]');
    expect(classes).toContain('gap-3'); // 元素间距 12px
    expect(classes).toContain('mb-3'); // 距输入卡片 12px
    // 内边距 12px 12px 12px 14px（规格表：右上左上=12、左=14）。
    expect(classes).toContain('pt-3');
    expect(classes).toContain('pr-3');
    expect(classes).toContain('pb-3');
    expect(classes).toContain('pl-[14px]');
    // 无阴影（规格表「无阴影」）。
    expect(classes).not.toContain('shadow');
  });

  it('图标块 32×32 圆角 10px 品牌蓝渐变 + 白色 16px 线性图标；标题/副文案/按钮字号字色', () => {
    render(<OnboardingHomeBanner visible onConfigure={() => {}} />);
    const tile = wrapper().querySelector('[data-banner-tile]')!;
    expect(tile.className).toContain('h-8'); // 32px
    expect(tile.className).toContain('w-8');
    expect(tile.className).toContain('rounded-[10px]'); // §5 `hrbuddy-home-banner-tile`
    expect(tile.className).toContain('var(--hr-oa-banner-tile-from)');
    expect(tile.className).toContain('var(--hr-oa-banner-tile-to)');
    // 标题 13.5px/600 --ink；副文案 12.5px/400 --muted 位（BANNER-01 规格表）。
    const title = screen.getByText(COPY.title);
    expect(title.className).toContain('text-[13.5px]');
    expect(title.className).toContain('font-semibold');
    expect(title.className).toContain('text-[var(--hr-oa-banner-ink)]');
    const sub = screen.getByText(COPY.sub);
    expect(sub.className).toContain('text-[12.5px]');
    expect(sub.className).toContain('text-[var(--hr-oa-banner-sub)]');
    // 按钮 32px 高胶囊、深色底白字 13px/500 + 右箭头 14px。
    const button = action();
    expect(button.className).toContain('h-8');
    expect(button.className).toContain('rounded-full');
    expect(button.className).toContain('bg-[var(--hr-oa-banner-cta-bg)]');
    expect(button.className).toContain('text-[var(--hr-oa-banner-cta-fg)]');
    // 13px 走白名单 token 类 text-13（DESIGN.md §3 禁任意值写法）。
    expect(button.className).toContain('text-13');
    expect(button.className).toContain('font-medium');
    const arrow = button.querySelector('svg');
    expect(arrow?.getAttribute('width')).toBe('14');
    expect(arrow?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('FR-HOME-BANNER-02/05 交互与无障碍', () => {
  it('「去配置」触发 onConfigure（宿主接补配门禁）；按钮带 2px 蓝焦点环', () => {
    const onConfigure = vi.fn();
    render(<OnboardingHomeBanner visible onConfigure={onConfigure} />);
    fireEvent.click(action());
    expect(onConfigure).toHaveBeenCalledOnce();
    expect(action().className).toContain('focus-visible:outline-2');
    expect(action().className).toContain('var(--focus-ring)');
  });

  it('普通容器（无 role="status"），唯一可聚焦元素是「去配置」', () => {
    render(<OnboardingHomeBanner visible onConfigure={() => {}} />);
    expect(wrapper().getAttribute('role')).toBeNull();
    // 全卡只有 action 一个 button；tabbable 元素只有它（BANNER-05）。
    const tabbables = wrapper().querySelectorAll('button, [href], input, select, textarea, [tabindex]');
    expect(tabbables).toHaveLength(1);
    expect(tabbables[0]).toBe(action());
  });
});

describe('FR-HOME-BANNER-03 收起（保存模型成功后）', () => {
  it('收起后 wrapper `hidden` + `inert`、内容卸载、无残留可聚焦元素（Review Focus #6）', async () => {
    const view = render(<OnboardingHomeBanner visible onConfigure={() => {}} />);
    expect(wrapper().hasAttribute('hidden')).toBe(false);
    view.rerender(<OnboardingHomeBanner visible={false} onConfigure={() => {}} />);
    // jsdom 无 motion token → 收起窗口 0ms：立即卸载内容并打 hidden + inert。
    await waitFor(() => {
      expect(wrapper().hasAttribute('hidden')).toBe(true);
      expect(wrapper().hasAttribute('inert')).toBe(true);
    });
    expect(screen.queryByText(COPY.title)).toBeNull();
    expect(screen.queryByTestId('home-onboarding-banner-action')).toBeNull();
    expect(wrapper().querySelectorAll('button, [tabindex]')).toHaveLength(0);
  });

  it('显示中不带 hidden；出现走淡入 + 上移（登记 token），收起挂收起 token 与延迟', () => {
    const view = render(<OnboardingHomeBanner visible onConfigure={() => {}} />);
    // 出现：wrapper 高度+透明度走 enter 语义 token，卡片挂登记入场类（上移 8px 归位）。
    expect(wrapper().className).toContain('duration-[var(--motion-home-banner-enter)]');
    expect(wrapper().className).toContain('ease-[var(--motion-ease-out)]');
    expect(card().className).toContain('hr-banner-rise');
    view.rerender(<OnboardingHomeBanner visible={false} onConfigure={() => {}} />);
    // 收起：240ms ease-in-out（--motion-ease-move 语义）+ 折叠侧 120ms 延迟。
    expect(wrapper().className).toContain('duration-[var(--motion-home-banner-collapse)]');
    expect(wrapper().className).toContain('ease-[var(--motion-ease-move)]');
    expect(wrapper().className).toContain('delay-[var(--motion-home-banner-collapse-delay)]');
  });
});

describe('FR-HOME-BANNER-04 窄容器（主区内容宽度 < 520px）', () => {
  it('按钮换到文字下方并撑满卡片；宽容器恢复同排', async () => {
    render(<OnboardingHomeBanner visible onConfigure={() => {}} />);
    fireWidth(480);
    await waitFor(() => expect(card().className).toContain('flex-wrap'));
    expect(action().className).toContain('w-full');
    fireWidth(800);
    await waitFor(() => expect(card().className).not.toContain('flex-wrap'));
    expect(action().className).not.toContain('w-full');
  });
});

describe('FR-HOME-REMOVE-02 品牌行只保留标识', () => {
  it('品牌行无「对话」下拉：只有头像/峰形标/字标，左对齐、无任何可交互下拉', () => {
    render(<ThemeBrandLockup theme={null} testId="brand-row" />);
    const row = screen.getByTestId('brand-row');
    expect(row.className).toContain('items-center');
    // 只保留标识：icon + logo 两件资产槽。
    expect(screen.getByTestId('brand-row-icon')).toBeTruthy();
    expect(screen.getByTestId('brand-row-logo')).toBeTruthy();
    // 无「对话」按钮 / 下拉触发 / chevron：品牌行是纯标识行（PRD FR-HOME-04 已变更）。
    expect(row.querySelectorAll('button, [role="button"], [aria-haspopup]')).toHaveLength(0);
    expect(row.querySelector('svg.lucide-chevron-down')).toBeNull();
  });
});
