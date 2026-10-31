/**
 * 旧多供应商详情 UI 的**单一恢复点**。
 *
 * Owner 裁决（2026-10-31）：旧功能「藏起来以后再说」——**保留代码、隐藏入口**，
 * 不做破坏性删除。右栏旧详情块（供应商身份行/断开/「···」菜单、账户资产模块、
 * 允许被远程调用 + 远程与分享入口、供应商预设 / 多协议 / 「获取模型列表」相关入口）
 * 整体收在 `isLegacyProviderUiVisible()` 后面（spec §6.3；先例见
 * `docs/dev-rules/hrbuddy-migration/CHANGELOG.md` 2026-10-29 条目 12 的
 * `SHOW_PROVIDER_DETAIL`）。
 *
 * 恢复方式：把下面的 `false` 改成 `true`，**一处即整块恢复**。不要再引入第二个
 * 开关、环境变量或设置项——「单一恢复点」是本模块存在的全部理由。
 */

// 单一恢复点：false = 隐藏旧多供应商详情（默认）；true = 整块恢复。
export const SHOW_LEGACY_PROVIDER_UI = false;

export function isLegacyProviderUiVisible(): boolean {
  return SHOW_LEGACY_PROVIDER_UI;
}
