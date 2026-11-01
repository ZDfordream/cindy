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
 * **重挂载合同**（review Important 2026-11-01）：`OwnerScopedRouter` 以
 * `${dataOwnerId}:${ownerGeneration}` 作 RouterProvider 的 key，每次 hr 落定都会
 * 整树重挂载本组件（登录 commit 冻结账号键 / 登出 commit null）。因此「登录在途 /
 * 登录成功拍（FR-LOGIN-04）」与「曾有会话（FR-SESSION-02 失效 toast）」两种记忆**不得
 * 放组件 state**——它们恰好只在重挂载的那两次转移上被需要。记忆在 `hrOaAuthStore`
 * 的模块级门禁记忆里（跨重挂载存活）：
 *   - `holding`（登录在途 + 500ms 成功拍）压住 children，拍面由 LoginScreen 续上；
 *   - had-session → signed-out 的落差由 `consumeHrOaExpiryNotice` 消费后弹
 *     「登录已过期，请重新登录」（冷启动无凭证的初始 signed-out 不弹）。
 *
 * mock 旁路：`XDT_UI_MOCK=1`（`window.electronAPI.uiMockData`）的评审通道整体跳过
 * 门禁直出 children（见 docs/dev-rules/ui-mock-data.md）。`SHOW_CINDY_ACCOUNT_UI`
 * 为 true 时门禁同样让位——那是 Cindy 账号层的整块恢复开关（藏不删）。
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';

import {
  consumeHrOaExpiryNotice,
  getHrOaGateMemorySnapshot,
  subscribeHrOaGateMemory,
  useHrOaAuth,
} from './hrOaAuthStore';
import { isCindyAccountUiVisible } from './legacyVisibility';
import { LoginScreen } from './LoginScreen';
import { WelcomeScreen } from './WelcomeScreen';

export function HrOaGate(props: { children: ReactNode }): React.JSX.Element | null {
  const { children } = props;
  const { t } = useTranslation();
  const { state } = useHrOaAuth();
  const [flow, setFlow] = useState<'welcome' | 'login'>('welcome');
  const memory = useSyncExternalStore(subscribeHrOaGateMemory, getHrOaGateMemorySnapshot);

  // 登录态失效通知（模块级，跨 ownerKey 重挂载存活）：消费一次弹一次。
  useEffect(() => {
    if (!consumeHrOaExpiryNotice()) return;
    setFlow('welcome');
    toast.error(t('hrOa.session.expired'));
  });

  // mock 评审通道与 Cindy 账号层恢复开关：门禁整体让位（children 直出）。
  if (window.electronAPI?.uiMockData === true || isCindyAccountUiVisible()) {
    return <>{children}</>;
  }

  // 登录在途 / 「登录成功」拍：压住 children（记忆在模块级，重挂载不丢）。
  if (memory.loginInFlight || memory.successBeatActive) {
    return (
      <LoginScreen onBack={() => setFlow('welcome')} onSuccess={() => setFlow('welcome')} />
    );
  }

  // 静默重登落定前不判决（防 S1 冷启动闪现 / 防主界面空壳先行）。
  if (state === null) return null;

  const sessionActive = state.status === 'signed-in' || state.status === 'offline';
  if (sessionActive) return <>{children}</>;

  if (flow === 'login') {
    return (
      <LoginScreen onBack={() => setFlow('welcome')} onSuccess={() => setFlow('welcome')} />
    );
  }
  return <WelcomeScreen onLogin={() => setFlow('login')} />;
}
