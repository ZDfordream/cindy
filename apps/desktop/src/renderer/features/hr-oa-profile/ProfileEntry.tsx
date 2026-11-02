/**
 * ProfileEntry — 侧栏底部个人信息入口（FR-PROFILE-01/02/04/05）。
 *
 * 几何（PRD FR-PROFILE-01）：宽撑满（左右 12px 边距，px-3 在本组件容器上）、高 44px
 * （§5 `hrbuddy-profile-entry` 同族高度例外）、头像 28px + 姓名 13.5px / 500
 * （13.5px 走 §3「排版豁免登记表」HRBuddy 个人信息面行）；加载 / 已获取 / 失败三态
 * 尺寸不变（骨架与内容同尺寸，T18 切换不跳动）。
 *
 * 交互（FR-PROFILE-01 / SC-8）：点击 / Enter / Space / ↓ 打开个人弹层（焦点首项）；
 * ↑ 打开并**聚焦最后一项**——弹层初始焦点意图经 `onOpen({ focus })` 交给宿主
 * （Task 4 的 ProfileMenu）。`aria-haspopup="menu"` / `aria-expanded` / 动态
 * `aria-label`（「个人信息与菜单：…」）同 PRD 原型。
 */

import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { ProfileAvatar } from './ProfileAvatar';
import { useHrOaProfile } from './useHrOaProfile';

export function ProfileEntry(props: {
  /** 开层意图：`focus:'last'` = ↑ 打开并聚焦最后一项（PRD FR-PROFILE-01）。 */
  onOpen: (options?: { focus?: 'first' | 'last' }) => void;
  expanded?: boolean;
}) {
  const { onOpen, expanded } = props;
  const { profile, state, avatarUrl } = useHrOaProfile();
  const { t } = useTranslation();

  const loading = state === 'loading';
  const failed = state === 'error';
  const name = profile?.name ?? '';
  const ariaLabel = loading
    ? t('hrOa.profile.entryAriaLoading')
    : failed
      ? t('hrOa.profile.entryAriaError')
      : t('hrOa.profile.entryAriaName', { name });

  const open = (focus: 'first' | 'last'): void => {
    onOpen({ focus });
  };

  return (
    <div className="mt-auto w-full px-3 pb-3">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={expanded === true}
        aria-label={ariaLabel}
        aria-busy={loading || undefined}
        onClick={() => open('first')}
        onKeyDown={(event) => {
          // Enter / Space 走 keydown 显式处理（preventDefault 抑制按钮默认 click，
          // 防止 onOpen 双触发）；↓ 开层焦点首项，↑ 开层聚焦最后一项。
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open('first');
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            open('first');
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            open('last');
          }
        }}
        className={cn(
          // FR-PROFILE-01 布局契约：44px 高 / 10px 圆角（§5 `hrbuddy-profile-entry`）/
          // 28px 头像 + 10px 间距 / 姓名 13.5px·500。
          'flex h-11 w-full items-center gap-2.5 rounded-[10px] px-2 text-left',
          'transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]',
          'hover:bg-[var(--sidebar-user-card-bg-hover)]',
          expanded && 'bg-[var(--sidebar-user-card-bg-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        )}
      >
        {loading ? (
          <>
            {/* FR-PROFILE-04：加载骨架 = 28px 圆 + 72×10 条；与内容同尺寸，切换不跳动。 */}
            <span
              aria-hidden="true"
              className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-[var(--hr-oa-skeleton)]"
            />
            <span className="min-w-0 flex-1">
              <span
                aria-hidden="true"
                className="block h-2.5 w-[72px] animate-pulse rounded-full bg-[var(--hr-oa-skeleton)]"
              />
              <span className="sr-only">{t('hrOa.profile.busy')}</span>
            </span>
          </>
        ) : (
          <>
            <ProfileAvatar
              size={28}
              profile={failed ? null : profile}
              src={failed ? null : avatarUrl}
            />
            <span className="min-w-0 flex-1">
              <span
                // §8.2：1 行省略 + 悬停完整姓名提示（SC-7）。
                title={name || undefined}
                className={cn(
                  'block truncate text-[13.5px] leading-5',
                  failed
                    ? 'font-normal text-[var(--text-secondary)]'
                    : 'font-medium text-[var(--text-primary)]',
                )}
              >
                {failed ? t('hrOa.profile.notFetched') : name}
              </span>
            </span>
          </>
        )}
      </button>
    </div>
  );
}
