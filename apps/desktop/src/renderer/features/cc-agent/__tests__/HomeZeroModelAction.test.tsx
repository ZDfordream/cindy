// @vitest-environment jsdom

/**
 * HomeZeroModelAction — 首页零可用来源单行动卡。
 *
 * 测试价值
 * - 生产入口与可观察结果：卡面文案与 CTA 行为——非 cloud 的 CTA 是「去配置」
 *   （点击回调 `onConfigure`，直连补配弹窗），**不再**是 Cindy 登录死端；cloud 分支
 *   保留官方服务开通口径（确认色实底 CTA → 设置 connect=xd）；own API 链接进设置向导。
 * - Bug／规则依据：Task 4 deferred minor（2026-11-01）——旧文案「登录 HRBuddy」+
 *   隐藏 CTA 是死端卡；login-onboarding PRD §6.4 未配置引导改配置模型口径。
 * - 现有覆盖缺口：原用例钉的是「CTA 不渲染」（藏不删的旧裁决），文案改写后需要钉
 *   新合同（CTA 渲染且走 onConfigure、sign-in 通路保持静默）。
 * - 最小失败输入：改写后若 CTA 仍隐藏 / 仍走 signInToCindy，第一条即红。
 * - tier：unit（jsdom 组件渲染，路由边界打桩）。
 * - 实测耗时：<1s（`pnpm --dir apps/desktop exec vitest run
 *   src/renderer/features/cc-agent/__tests__/HomeZeroModelAction.test.tsx`，3 用例）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const signInMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useSignInToCindy', () => ({
  useSignInToCindy: () => signInMock,
}));

import { HomeZeroModelAction } from '../HomeZeroModelAction';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderCard(authMode: 'signed-out' | 'local' | 'cloud' | 'hr', onConfigure = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <HomeZeroModelAction authMode={authMode} narrow={false} onConfigure={onConfigure} />
              <LocationProbe />
            </>
          }
        />
        <Route path="/settings" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return { onConfigure };
}

afterEach(() => {
  cleanup();
  signInMock.mockReset();
});

describe('HomeZeroModelAction', () => {
  it('signed-out: 「去配置」CTA 走 onConfigure（补配弹窗），Cindy 登录通路保持静默', () => {
    const { onConfigure } = renderCard('signed-out');
    expect(screen.getByText('onboarding.homeZeroModel.title')).toBeTruthy();
    expect(screen.queryByText('onboarding.connectProvider.title')).toBeNull();
    // 死端卡修复（Task 4 minor → Task 6）：CTA 渲染且直连配置入口，不再隐藏、不走
    // Cindy 账号层（SHOW_CINDY_ACCOUNT_UI=false 藏不删，sign-in 通路整块静默）。
    fireEvent.click(screen.getByTestId('home-zero-model-cta'));
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('home-zero-model-own-api')).toBeTruthy();
  });

  it('cloud: opens Cindy AI provider connect, not the provider list', () => {
    const { onConfigure } = renderCard('cloud');
    // CTA 的视觉合同（确认色实底）随 CTA 迁到 cloud 分支继续钉住。
    expect(screen.getByTestId('home-zero-model-cta').className).toContain(
      '[--button-face-bg:var(--accent-cta-bg-pure)]',
    );
    expect(screen.getByTestId('home-zero-model-cta').className).toContain(
      'text-[var(--accent-pure-cta-fg)]',
    );
    expect(screen.getByTestId('home-zero-model-cta').className).not.toContain('send-btn-fg');
    fireEvent.click(screen.getByTestId('home-zero-model-cta'));
    expect(onConfigure).not.toHaveBeenCalled();
    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('loc').textContent).toBe('/settings?tab=providers&connect=xd');
  });

  it('own API link opens the provider wizard', () => {
    renderCard('signed-out');
    fireEvent.click(screen.getByTestId('home-zero-model-own-api'));
    expect(screen.getByTestId('loc').textContent).toBe('/settings?tab=providers&wizard=1');
  });
});
