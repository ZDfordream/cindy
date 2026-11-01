/**
 * useSignInToCindy — 从应用内发起 Cindy 登录的唯一正确通路。
 *
 * local 模式下直接 navigate('/login') 会被 GuestRoute 弹回首页(它对
 * mode==='local' 一律 redirect),必须先 exitLocalMode() 把会话切回 signed-out
 * 再进登录页——与 settings/UserProfileCard 的既有做法同通路(2026-07-24 实踩:
 * 引导卡/banner/供应商页三处直跳 /login 全部无效)。
 *
 * 数据语义:exitLocalMode 不删除 local 命名空间(local-v1)的任何数据;登录后
 * data owner 切到账号命名空间,local 数据保留在盘上但不合并、不可见(再次进入
 * 本地模式可找回)。
 *
 * 本 hook 是「从应用内发起 Cindy 登录」的唯一通路——Cindy 账号层收起
 * (`SHOW_CINDY_ACCOUNT_UI=false`,HR 登录门禁)时在此整块静默,恢复开关一开即回。
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';
import { isCindyAccountUiVisible } from '@/features/hr-oa-auth/legacyVisibility';

export function useSignInToCindy(returnTo?: string): () => Promise<void> {
  const { mode, exitLocalMode } = useAuth();
  const navigate = useNavigate();

  return useCallback(async () => {
    // 藏不删：Cindy 账号层整体收起时（SHOW_CINDY_ACCOUNT_UI=false），应用内不得
    // 发起任何 Cindy 登录（含 SSO / 社交 / 邮箱）。本 hook 是该通路的唯一入口
    // （见文件头），在此一处收口；恢复开关一开即整块恢复。
    if (!isCindyAccountUiVisible()) return;
    if (mode === 'local') {
      try {
        await exitLocalMode();
      } catch {
        // The login route is also the recovery surface when the durable owner
        // transition is pending. Do not leave the sign-in action as a no-op.
      }
    }
    navigate('/login', returnTo ? { state: { returnTo } } : undefined);
  }, [mode, exitLocalMode, navigate, returnTo]);
}
