// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`LoginBrandStage`（品牌立绘层唯一渲染者）与 `HrOaGate`
 *   （HR OA 登录门禁）的组合可观察结果。`SHOW_CINDY_ACCOUNT_UI === false`（藏不删
 *   默认收起）时，Cindy 登录视觉层（`login-stage-root` / `login-brand-hero`）不得
 *   出现在文档里，S1 欢迎页（标题「HRBuddy，我帮你」+「登录」按钮）必须可见——
 *   真机验收缺陷：立绘层盖在 S1 上，登录按钮被遮住；恢复开关打开时品牌层照常
 *   渲染（藏不删的恢复半边）。
 * - Bug／规则依据：login-onboarding PRD FR-WELCOME-03（S1 只有吉祥物/标题/登录）；
 *   真机验收缺陷（2026-11-01，`LoginBrandStage` 盖住 HR 门禁）；CHANGES.md §6
 *   品牌债登记；`legacyVisibility.ts` 藏不删合同（与 Cindy 登录页同开关）。
 * - 现有覆盖缺口：`LoginPage.harness` / `LoginHandoffContext` 渲染品牌层的夹具
 *   都钉在 Cindy 账号层恢复面（开关 true），只测「渲染时的几何/动画」；`hrOaGate`
 *   测试钉在真实 `legacyVisibility` 模块（默认 false）不渲染品牌层。两侧都没有
 *   「开关决定品牌层是否进文档 + S1 不被盖」的跨界断言。不能并入上述文件的原因：
 *   本文件需要可切换的 `legacyVisibility` mock（同一文件内跑 false/true 两态），
 *   而 `hrOaGate.test.tsx` 必须继续消费真实模块以钉生产默认值（mock 会把它的
 *   `SHOW_CINDY_ACCOUNT_UI` 守卫变成自证），另两个文件的夹具则固定在 true 面。
 * - 最小失败输入：开关 false + 渲染 `LoginBrandStage` → `login-stage-root` 出现
 *   即失败（当前缺陷形态）；开关 true + 不渲染品牌层即失败（藏不删恢复断链）。
 * - tier：unit（进程内 RTL 组件测试，IPC 以 window.electronAPI 桩注入，无网络）。
 * - 实测耗时：单文件墙钟约 2.2s（vitest Duration 2.1s，2 例）
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { LoginBrandStage } from '@/components/login/LoginBrandStage';
import { HrOaGate } from '../HrOaGate';
import { __testing as hrOaStoreTesting } from '../hrOaAuthStore';

/** 同文件内两态切换（藏 / 恢复），mock 只认这个开关读数。 */
const visibility = vi.hoisted(() => ({ cindyAccountUi: false }));

vi.mock('@/features/hr-oa-auth/legacyVisibility', () => ({
  SHOW_CINDY_ACCOUNT_UI: false,
  isCindyAccountUiVisible: () => visibility.cindyAccountUi,
}));

const bridge = vi.hoisted(() => ({
  getState: vi.fn(),
  listeners: new Set<(payload: unknown) => void>(),
}));

function installBridge(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      hrOa: {
        login: vi.fn(),
        logout: vi.fn(),
        getState: bridge.getState,
        networkRecovered: vi.fn(),
      },
      onAuthStateChange: (cb: (payload: unknown) => void) => {
        bridge.listeners.add(cb);
        return () => bridge.listeners.delete(cb);
      },
      uiMockData: false,
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

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  hrOaStoreTesting.resetHrOaGateMemory();
  visibility.cindyAccountUi = false;
  bridge.listeners.clear();
  bridge.getState.mockReset();
  bridge.getState.mockResolvedValue({ status: 'signed-out' });
  mockMatchMedia();
  installBridge();
});

afterEach(() => {
  cleanup();
});

describe('LoginBrandStage 随 Cindy 账号层开关藏不删（真机缺陷：立绘盖住 S1）', () => {
  it('开关收起（默认）：品牌立绘层不进文档，S1 标题与「登录」按钮可见', async () => {
    // App 主窗组合的最小重现：品牌层与 HR 门禁同树挂载（品牌层是 overlay，
    // S1 在其下方渲染——缺陷形态即「S1 在但被盖住」）。
    render(
      <>
        <LoginBrandStage />
        <HrOaGate>
          <div data-testid="children-marker">main-app</div>
        </HrOaGate>
      </>,
    );
    await act(async () => {});

    // 缺陷断言：立绘层（整层 + 立绘资产）不得在文档里盖住门禁。
    expect(screen.queryByTestId('login-stage-root')).toBeNull();
    expect(screen.queryByTestId('login-brand-hero')).toBeNull();
    // S1 三件套可见（FR-WELCOME-03 的标题与登录入口）。
    expect(screen.queryByText('HRBuddy，我帮你')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('恢复开关打开：品牌立绘层照常渲染（藏不删的恢复半边）', async () => {
    visibility.cindyAccountUi = true;
    render(<LoginBrandStage />);

    expect(screen.getByTestId('login-stage-root')).toBeTruthy();
    expect(screen.getByTestId('login-brand-hero')).toBeTruthy();
  });
});
