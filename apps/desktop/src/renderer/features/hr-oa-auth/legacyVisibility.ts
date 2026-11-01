/**
 * Cindy 账号层的**单一恢复点**（登录门禁 Task 4）。
 *
 * Owner 裁决（login-onboarding）：HRBuddy 的登录门禁是 HR OA（S1/S2），Cindy 云端
 * 账号层（LoginPage / 账号切换 / local 免登录 / SSO 与社交登录）整体「藏起来以后
 * 再说」——**保留代码、隐藏入口**，不做破坏性删除（口径同
 * `features/model-gateway/legacyVisibility.ts` 的 `SHOW_LEGACY_PROVIDER_UI`）。
 *
 * `false`（默认）时：
 *   - `HrOaGate` 生效，未登录只出 S1/S2；`/login` 映射到门禁流而非 LoginPage；
 *   - 应用内发起 Cindy 登录的唯一通路 `useSignInToCindy` 变 no-op，
 *     账号切换 / 免登录 / SSO 入口不再渲染。
 * `true` 时：门禁整体让位（children 直出），`/login` 回到 LoginPage，一切回到
 * HRBuddy 之前的 Cindy 账号层体验。
 *
 * 恢复方式：把下面的 `false` 改成 `true`，**一处即整块恢复**。不要再引入第二个
 * 开关、环境变量或设置项——「单一恢复点」是本模块存在的全部理由。
 */

// 单一恢复点：false = 隐藏 Cindy 账号层、启用 HR 登录门禁（默认）；true = 整块恢复。
export const SHOW_CINDY_ACCOUNT_UI = false;

export function isCindyAccountUiVisible(): boolean {
  return SHOW_CINDY_ACCOUNT_UI;
}
