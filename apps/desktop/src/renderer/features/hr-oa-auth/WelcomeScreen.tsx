/**
 * WelcomeScreen —— S1 欢迎门禁（login-onboarding PRD §6.1 FR-WELCOME-01~03）。
 *
 * 页面上除吉祥物、标题、「登录」按钮外没有其他内容（G1：未登录不得出现任何
 * 进首页入口）。「登录」是唯一可操作入口（深色胶囊 CTA，两模式同源反转），
 * 页面加载后默认获焦；Enter/Space 经原生 button 激活触发 onLogin。转场锁定
 * 由持路由的门禁层负责（onLogin 只上报一次意图），本屏不做路由。
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';

import { Mascot } from './Mascot';

export function WelcomeScreen(props: { onLogin: () => void }): React.JSX.Element {
  const { onLogin } = props;
  const { t } = useTranslation();
  const loginRef = useRef<HTMLButtonElement>(null);

  // FR-WELCOME-02：页面加载后「登录」默认获得焦点。
  useEffect(() => {
    loginRef.current?.focus();
  }, []);

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 bg-[var(--surface)] px-4">
      <Mascot variant="hero" />
      {/* PRD hero 标题 28px/600（= DS-8 标题档 28 + 字重梯 600，逐档对齐）。 */}
      <h1 className="text-center text-28 font-semibold leading-normal tracking-[0.5px] text-[var(--text-primary)]">
        {t('hrOa.welcome.title')}
      </h1>
      {/* FR-WELCOME-02：深色全圆角胶囊（palette=confirmation 走 confirm-btn-primary-bg
          反转实底，两模式同源），高 44px、左右 44px 对齐 PRD pill-login。 */}
      <Button
        ref={loginRef}
        variant="primary"
        palette="confirmation"
        size="lg"
        className="h-11 px-11"
        onClick={onLogin}
      >
        {t('hrOa.welcome.login')}
      </Button>
    </div>
  );
}
