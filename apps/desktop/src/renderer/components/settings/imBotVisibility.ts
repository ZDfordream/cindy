/** 「IM 机器人」官方分栏的可见性。个人机器人在所有构建与账号中均可配置。 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

/** 设置搜索仍使用完整身份快照；官方分栏只取登录模式。 */
export interface ImBotIdentity {
  region: CindyRegion;
  mode: 'signed-out' | 'local' | 'cloud' | 'hr';
  membershipKind: 'personal' | 'org' | null;
}

/**
 * 本地模式与 HR OA 会话不提供官方分栏；未登录时仍可看到入口和登录引导。
 * `hr` 同 local 排除：官方分栏的登录引导通向 Cindy 账号层（HR 会话已关闭该层，
 * 见 hr-oa-auth/legacyVisibility.ts），且官方机器人绑定的是 Cindy 账号。
 */
export function showCindyGroup(identity: Pick<ImBotIdentity, 'mode'>): boolean {
  return identity.mode !== 'local' && identity.mode !== 'hr';
}
