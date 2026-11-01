import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';

export function GuestRoute() {
  const location = useLocation();
  const returnTo = (location.state as { returnTo?: unknown } | null)?.returnTo;
  const destination = typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/login') ? returnTo : '/';
  const { mode, isInitializing } = useAuth();

  if (isInitializing) return null;
  // `hr`（HR OA 会话）同样弹走：否则 HR 已登录用户撞见 Cindy LoginPage
  //（Cindy 账号层已整体收起，见 hr-oa-auth/legacyVisibility.ts）。
  if (mode === 'cloud' || mode === 'local' || mode === 'hr') {
    return <Navigate to={destination} replace />;
  }
  return <Outlet />;
}
