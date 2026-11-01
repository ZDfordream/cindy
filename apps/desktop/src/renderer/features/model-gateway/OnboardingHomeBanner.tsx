/**
 * OnboardingHomeBanner — S4b 未配置横幅（login-onboarding PRD FR-HOME-08）。
 *
 * 仅 S4b 显示；「去配置」由宿主接到补配门禁（`HomeGateSurface.gate('banner')`）。
 * 保存成功后以高度 + 透明度折叠消失（T5/T8）：`grid-template-rows 1fr→0fr` 同时
 * `opacity 1→0`，240ms、折叠侧延迟 120ms（§9.3 横幅折叠；`grid-template-rows` 是
 * PRD §9.4 transform/opacity 红线的唯一例外）。时长 / 延迟走登记的 foundations
 * token（`--motion-home-banner-collapse*`，PRD §9.2 逐值登记，reduce 全档归零 =
 * `--m: 0`），组件里不写裸时长。折叠动画结束后卸载内容（`aria-hidden` 折叠层与
 * 文本都不留在可交互树里）。
 *
 * 圆角 14px = DESIGN.md §5 `hrbuddy-home-banner`（HRBuddy PRD-family frames）。
 * 颜色全部语义 token：`--surface-chip` 面 / `--border-default` 线 / `--warning-fg`
 * 暖色提示图标（PRD 深金菊色收敛到既有警示前景 token）/ `--text-secondary` 正文。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * 折叠动画的总窗口（时长 + 折叠侧延迟），从 foundations token 读出——reduce 下
 * token 归零即立即卸载（§9.5「状态瞬时切换」）；jsdom 无 token 时同样取 0。
 */
function collapseWindowMs(): number {
  if (typeof window === 'undefined') return 0;
  const style = window.getComputedStyle(document.documentElement);
  const duration = parseFloat(style.getPropertyValue('--motion-home-banner-collapse')) || 0;
  const delay = parseFloat(style.getPropertyValue('--motion-home-banner-collapse-delay')) || 0;
  return duration + delay;
}

export function OnboardingHomeBanner(props: { onConfigure: () => void; visible: boolean }) {
  const { onConfigure, visible } = props;
  const { t } = useTranslation();
  // 折叠动画期间内容保持挂载（否则没有「折叠」只有消失）；动画窗口走完即卸载。
  const [rendered, setRendered] = useState(visible);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      return;
    }
    if (!rendered) return;
    const timer = window.setTimeout(() => setRendered(false), collapseWindowMs());
    return () => window.clearTimeout(timer);
  }, [visible, rendered]);

  return (
    <div
      data-testid="home-onboarding-banner"
      aria-hidden={!visible || undefined}
      className={cn(
        'grid transition-[grid-template-rows,opacity]',
        'duration-[var(--motion-home-banner-collapse)] ease-[var(--motion-ease-move)]',
        visible
          ? 'grid-rows-[1fr] opacity-100'
          : 'grid-rows-[0fr] opacity-0 delay-[var(--motion-home-banner-collapse-delay)]',
      )}
    >
      {rendered && (
        <div className="min-h-0 overflow-hidden">
          <div
            className={cn(
              'mb-2.5 flex h-11 items-center gap-2.5 rounded-[14px] border border-[var(--border-default)]',
              'bg-[var(--surface-chip)] py-0 pr-2 pl-3.5',
            )}
          >
            <Info size={18} className="shrink-0 text-[var(--warning-fg)]" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-13 text-[var(--text-secondary)]">
              {t('onboarding.homeBanner.text')}
            </span>
            <Button
              type="button"
              variant="cta"
              size="sm"
              compact
              data-testid="home-onboarding-banner-action"
              onClick={onConfigure}
            >
              {t('onboarding.homeBanner.action')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
