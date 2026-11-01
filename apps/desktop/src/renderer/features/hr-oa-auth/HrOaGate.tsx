/**
 * HrOaGate —— HR OA 登录门禁（login-onboarding PRD G1 / FR-WELCOME-03 / FR-SESSION-02）。
 *
 * 挂在 `router.tsx` 路由配置的最根部（ProtectedRoute 外层）：未登录时**任何**路由
 * （含 /settings、/cc-agent、深链、二次窗口、未匹配路径）都只出 S1/S2 流，不渲染
 * children；登录成功（含离线可读的 `offline`）才放行整个路由树。S1↔S2 是门禁内
 * 本地状态，不走路由——快捷键 / 菜单 / URL scheme 触发的入口一律回 S1。
 *
 * 静默重登落定前不判决：`useHrOaAuth().state === null`（main 侧 `hrOa:state` 等
 * `manager.startup()` 落定后才回）时渲染 null——既不闪 S1（冷启动直进首页），也不
 * 露出主界面空壳。落定 `signed-in`/`offline` 直接进 children。
 *
 * 显式登录成功后仍停留 S2 的「登录成功」拍（FR-LOGIN-04，500ms）：`flow === 'login'`
 * 压住放行，等 `LoginScreen.onSuccess` 收尾再进 children；静默重登（flow 停在
 * welcome）不压。登录态失效推送（had-session → signed-out）回 S1 + toast
 * 「登录已过期，请重新登录」（FR-SESSION-02；冷启动无凭证的初始 signed-out 不弹）。
 *
 * mock 旁路：`XDT_UI_MOCK=1`（`window.electronAPI.uiMockData`）的评审通道整体跳过
 * 门禁直出 children（见 docs/dev-rules/ui-mock-data.md）。`SHOW_CINDY_ACCOUNT_UI`
 * 为 true 时门禁同样让位——那是 Cindy 账号层的整块恢复开关（藏不删）。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';

import { useHrOaAuth, type HrOaAuthState } from './hrOaAuthStore';
import { isCindyAccountUiVisible } from './legacyVisibility';
import { LoginScreen } from './LoginScreen';
import { WelcomeScreen } from './WelcomeScreen';

export function HrOaGate(props: { children: ReactNode }): React.JSX.Element | null {
  const { children } = props;
  const { t } = useTranslation();
  const { state } = useHrOaAuth();
  const [flow, setFlow] = useState<'welcome' | 'login'>('welcome');
  const previousStatusRef = useRef<HrOaAuthState['status'] | null>(null);

  useEffect(() => {
    const previous = previousStatusRef.current;
    const current = state?.status ?? null;
    previousStatusRef.current = current;
    if (current === null) return;
    const wasActive = previous === 'signed-in' || previous === 'offline';
    if (wasActive && current === 'signed-out') {
      setFlow('welcome');
      toast.error(t('hrOa.session.expired'));
    }
  }, [state, t]);

  // mock 评审通道与 Cindy 账号层恢复开关：门禁整体让位（children 直出）。
  if (window.electronAPI?.uiMockData === true || isCindyAccountUiVisible()) {
    return <>{children}</>;
  }

  // 静默重登落定前不判决（防 S1 冷启动闪现 / 防主界面空壳先行）。
  if (state === null) return null;

  const sessionActive = state.status === 'signed-in' || state.status === 'offline';
  // `flow === 'login'` 压住放行：显式登录成功后 LoginScreen 还要停留「登录成功」拍，
  // onSuccess 收尾把 flow 拨回 welcome 才进 children（静默重登不经过 S2，不压）。
  if (sessionActive && flow === 'welcome') return <>{children}</>;

  if (flow === 'login') {
    return (
      <LoginScreen onBack={() => setFlow('welcome')} onSuccess={() => setFlow('welcome')} />
    );
  }
  return <WelcomeScreen onLogin={() => setFlow('login')} />;
}
