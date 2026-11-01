// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`isLegacyProviderUiVisible()`（ProvidersSection 右栏旧详情块的
 *   唯一可见性判据）。默认用户在「模型供应商」页**看不到**旧多供应商详情（身份/断开、
 *   允许被远程调用、账户资产、供应商预设/多协议/获取模型列表入口），只看到模型网关列表。
 * - Bug／规则依据：owner 2026-10-31「旧功能藏起来以后再说」——保留代码、隐藏入口，
 *   恢复点必须**单一**；spec §6.3「恢复点集中一处（单一 flag / 常量）」。
 *   另见 CHANGELOG 2026-10-29 条目 12（`SHOW_PROVIDER_DETAIL` 单开关先例，后被回退）。
 * - 现有覆盖缺口：此前无任何用例约束「默认隐藏」与「单点恢复」这条交付契约。
 * - 最小失败输入：模块未实现时 `isLegacyProviderUiVisible()` 不存在（import 即失败）；
 *   若 getter 里夹带第二个条件或另立开关，「改一处即整块恢复」即失效。
 * - tier：unit（纯模块契约；右栏接线的生产行为见 providersSectionAssetModule 的
 *   「默认隐藏 / 单开关恢复」两例）。
 * - 实测耗时：<1s（见 PR）。
 */

import { describe, expect, it } from 'vitest';

import { SHOW_LEGACY_PROVIDER_UI, isLegacyProviderUiVisible } from '../legacyVisibility';

describe('legacyVisibility — 旧多供应商 UI 单一恢复点', () => {
  it('hides legacy provider UI by default', () => {
    // 默认面必须是「藏起来」：右栏只留模型网关列表（owner 简单三栏形态）。
    expect(isLegacyProviderUiVisible()).toBe(false);
  });

  it('the flag is a single toggle that restores the legacy block', () => {
    // 协议：SHOW_LEGACY_PROVIDER_UI 是唯一恢复点（owner「藏起来以后再说」）。
    // getter 必须与常量同源——若出现第二个开关，或 getter 里夹带别的条件，
    // 「改一处即整块恢复」不再成立，恢复会漏块或藏不干净。
    // 失效后果：恢复旧功能时要人肉找多个开关，违背单一恢复点裁决。
    // 注：PRD 2026-11-01 平铺后 provider 轨整卡不再挂载（ProvidersSection
    // `PROVIDER_TRACK_RENDERED`）——翻本 flag 不再有可见效果，恢复需先重新接线
    // provider 轨；flag 本身仍是轨内旧详情块的单一可见性判据。
    expect(SHOW_LEGACY_PROVIDER_UI).toBe(false);
    expect(isLegacyProviderUiVisible()).toBe(SHOW_LEGACY_PROVIDER_UI);
  });
});
