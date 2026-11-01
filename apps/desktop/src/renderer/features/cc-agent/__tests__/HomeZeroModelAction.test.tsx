// @vitest-environment jsdom

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

function renderCard(authMode: 'signed-out' | 'local' | 'cloud') {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <HomeZeroModelAction authMode={authMode} narrow={false} />
              <LocationProbe />
            </>
          }
        />
        <Route path="/settings" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  signInMock.mockReset();
});

describe('HomeZeroModelAction', () => {
  it('signed-out: 不渲染 Cindy 登录 CTA（账号层收起），保留 own API 链接', () => {
    renderCard('signed-out');
    expect(screen.getByText('onboarding.homeZeroModel.title')).toBeTruthy();
    expect(screen.queryByText('onboarding.connectProvider.title')).toBeNull();
    // HR 登录门禁裁决：非 cloud 的「登录 HRBuddy」CTA 通向 Cindy 账号层，
    // SHOW_CINDY_ACCOUNT_UI=false（藏不删）时不再渲染，sign-in 通路整块静默。
    expect(screen.queryByTestId('home-zero-model-cta')).toBeNull();
    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('home-zero-model-own-api')).toBeTruthy();
  });

  it('cloud: opens Cindy AI provider connect, not the provider list', () => {
    renderCard('cloud');
    // CTA 的视觉合同（确认色实底）随 CTA 迁到 cloud 分支继续钉住。
    expect(screen.getByTestId('home-zero-model-cta').className).toContain(
      '[--button-face-bg:var(--accent-cta-bg-pure)]',
    );
    expect(screen.getByTestId('home-zero-model-cta').className).toContain(
      'text-[var(--accent-pure-cta-fg)]',
    );
    expect(screen.getByTestId('home-zero-model-cta').className).not.toContain('send-btn-fg');
    fireEvent.click(screen.getByTestId('home-zero-model-cta'));
    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('loc').textContent).toBe('/settings?tab=providers&connect=xd');
  });

  it('own API link opens the provider wizard', () => {
    renderCard('signed-out');
    fireEvent.click(screen.getByTestId('home-zero-model-own-api'));
    expect(screen.getByTestId('loc').textContent).toBe('/settings?tab=providers&wizard=1');
  });
});
