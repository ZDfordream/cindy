/**
 * ProfileCard — 个人弹层身份卡（FR-PROFILE-03/05/06，只读不可点击）。
 *
 * 结构（PRD FR-PROFILE-03 / §8 字段展示规则）：44px 头像 + 姓名（15px / 600，最多
 * 2 行）+「部门 · 岗位」（一项为空只显示另一项，都空隐藏）+ `登录名` 行 +
 * `邮箱` 行（空隐藏）。**「登录名」不是「工号」**（集成设计 §4.1 OQ-3 裁决：`login_name`
 * 是 OA 登录名，实测如 `YLS`）；`mobile` / `sex` / 证件号一律不展示（PRD §7.2）。
 * 截断（§8.2）：姓名 / 部门 / 邮箱单行省略号，姓名悬停 title 显示全文（SC-7）+ 2 行
 * clamp；读屏全文经 `aria-describedby`（§8.2）。
 *
 * 状态面（FR-PROFILE-04/05）：`loading` 4 条骨架 + 读屏「正在获取个人信息」；
 * `refresh-error` 缓存资料 + 「信息更新失败 · 重试」；`error`「未获取到信息 /
 * 个人信息获取失败，请稍后重试 / 重试」。重试请求中按钮「重试中…」（FR-PROFILE-05）：
 * `onRetry` 回传 Promise 则以其 settle 收口，同步实现以 props 变化收口。
 */

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { PersonProfile } from '../../../main/hr-oa/profile';
import { ProfileAvatar } from './ProfileAvatar';
import type { ProfileState } from './useHrOaProfile';

export function ProfileCard(props: {
  profile: PersonProfile | null;
  state: ProfileState;
  /** 重试（FR-PROFILE-05）；回传 Promise 时按钮「重试中…」保持到 settle。 */
  onRetry: () => void | Promise<void>;
  /** 头像 blob URL（`useHrOaProfile().avatarUrl`）；缺省渲染首字/人形兜底。 */
  avatarUrl?: string | null;
}) {
  const { profile, state, onRetry, avatarUrl } = props;
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);

  // 落定信号（资料身份或状态面变化）→ 按钮回「重试」；同态失败的收口走 onRetry 的
  // Promise settle（见 handleRetry），两路合起来保证按钮不卡在「重试中…」。
  useEffect(() => {
    setRetrying(false);
  }, [profile, state]);

  const handleRetry = (): void => {
    if (retrying) return;
    setRetrying(true);
    let settled: Promise<unknown>;
    try {
      settled = Promise.resolve(onRetry());
    } catch {
      setRetrying(false);
      return;
    }
    void settled.then(
      () => setRetrying(false),
      () => setRetrying(false),
    );
  };

  const loading = state === 'loading';
  const failed = state === 'error';
  const name = (profile?.name ?? '').trim();
  const dept = (profile?.dept ?? '').trim();
  const title = (profile?.title ?? '').trim();
  const sub = [dept, title].filter(Boolean).join(' · ');
  const loginName = (profile?.loginName ?? '').trim();
  const email = (profile?.email ?? '').trim();
  const nameDescId = useId();

  return (
    <div role="group" aria-label={t('hrOa.profile.cardAriaLabel')} aria-busy={loading || undefined}>
      <div className="px-2.5 pb-2.5 pt-3">
        {failed ? (
          /* FR-PROFILE-05 无缓存失败面：未获取到信息 / 提示 / 重试（初始焦点在重试）。 */
          <div className="flex flex-col items-center gap-1 py-1 text-center">
            <CircleAlert aria-hidden="true" size={16} className="mb-0.5 text-[var(--text-secondary)]" />
            <p className="text-14 font-semibold leading-5 text-[var(--text-primary)]">
              {t('hrOa.profile.notFetched')}
            </p>
            <p className="text-12 leading-[1.5] text-[var(--text-secondary)]">
              {t('hrOa.profile.errorHint')}
            </p>
            <button
              type="button"
              // 失败面「重试」是弹层焦点环的第 1 个可用项（FR-MENU-07；原型 #pfRetry
              // 同为 role=menuitem，进 `popItems` 的 ↑↓ 循环）。
              role="menuitem"
              onClick={handleRetry}
              aria-disabled={retrying || undefined}
              className={cn(
                'mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--border-default)] px-3.5',
                'text-12 text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
              )}
            >
              {retrying ? t('hrOa.profile.retrying') : t('hrOa.profile.retry')}
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[44px_1fr] items-start gap-3">
              {loading ? (
                <span
                  aria-hidden="true"
                  className="h-11 w-11 animate-pulse rounded-full bg-[var(--hr-oa-skeleton)]"
                />
              ) : (
                <ProfileAvatar size={44} profile={profile} src={avatarUrl} />              )}
              <div className="min-w-0">
                {loading ? (
                  <>
                    {/* FR-PROFILE-04：身份卡骨架 4 条（96×12 / 140×10 / 120×10 / 160×10）。 */}
                    <span
                      data-testid="profile-card-skeleton-bar"
                      aria-hidden="true"
                      className="block h-3 w-[96px] animate-pulse rounded-full bg-[var(--hr-oa-skeleton)]"
                    />
                    <span
                      data-testid="profile-card-skeleton-bar"
                      aria-hidden="true"
                      className="mt-2 block h-2.5 w-[140px] animate-pulse rounded-full bg-[var(--hr-oa-skeleton)]"
                    />
                    <span
                      data-testid="profile-card-skeleton-bar"
                      aria-hidden="true"
                      className="mt-2 block h-2.5 w-[120px] animate-pulse rounded-full bg-[var(--hr-oa-skeleton)]"
                    />
                    <span
                      data-testid="profile-card-skeleton-bar"
                      aria-hidden="true"
                      className="mt-2 block h-2.5 w-[160px] animate-pulse rounded-full bg-[var(--hr-oa-skeleton)]"
                    />
                    <span className="sr-only">{t('hrOa.profile.busy')}</span>
                  </>
                ) : (
                  <>
                    {/* §8.2：姓名最多 2 行后省略；读屏全文经 aria-describedby。 */}
                    <p
                      title={name || undefined}
                      aria-describedby={name ? nameDescId : undefined}
                      className="line-clamp-2 break-all text-15 font-semibold leading-[1.47] text-[var(--text-primary)]"
                    >
                      {name}
                    </p>
                    {name ? (
                      <span id={nameDescId} className="sr-only">
                        {name}
                      </span>
                    ) : null}
                    {/* 部门 · 岗位：单项省略连接符；都空隐藏（FR-PROFILE-03）。 */}
                    {sub ? (
                      <p className="mt-0.5 truncate text-12 leading-[1.5] text-[var(--text-secondary)]">
                        {sub}
                      </p>
                    ) : null}
                    {(loginName || email) && (
                      <dl className="mt-2 grid gap-0.5 text-12 leading-[1.5]">
                        {loginName ? (
                          <div className="flex min-w-0 gap-2">
                            {/* Review Focus #4：标签是「登录名」，不是「工号」。 */}
                            <dt className="w-7 shrink-0 text-[var(--text-secondary)]">
                              {t('hrOa.profile.loginNameLabel')}
                            </dt>
                            <dd
                              className="min-w-0 truncate text-[var(--text-primary)]"
                              title={loginName}
                            >
                              {loginName}
                            </dd>
                          </div>
                        ) : null}
                        {email ? (
                          <div className="flex min-w-0 gap-2">
                            <dt className="w-7 shrink-0 text-[var(--text-secondary)]">
                              {t('hrOa.profile.emailLabel')}
                            </dt>
                            <dd className="min-w-0 truncate text-[var(--text-primary)]" title={email}>
                              {email}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    )}
                  </>
                )}
              </div>
            </div>
            {/* refresh-error（FR-PROFILE-05）：缓存资料 +「信息更新失败 · 重试」。 */}
            {state === 'refresh-error' ? (
              <div className="mt-2.5 flex items-center gap-1.5 text-12 leading-[1.5] text-[var(--hr-oa-warn-text)]">
                <CircleAlert aria-hidden="true" size={12} />
                <span>{t('hrOa.profile.refreshFailed')}</span>
                <button
                  type="button"
                  // 更新失败面的「重试」同进弹层焦点环（原型 #pfStaleRetry / popItems）。
                  role="menuitem"
                  onClick={handleRetry}
                  aria-disabled={retrying || undefined}
                  className={cn(
                    'ml-auto inline-flex h-[22px] items-center rounded-lg px-2',
                    'text-12 font-medium text-[var(--text-link)] transition-colors hover:bg-[var(--surface-hover)]',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                  )}
                >
                  {retrying ? t('hrOa.profile.retrying') : t('hrOa.profile.retry')}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
