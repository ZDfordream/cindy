/**
 * OnboardingHomeBanner — S4b 未配置横幅（profile-menu PRD §6.7 FR-HOME-BANNER-01~05）。
 *
 * 仅 S4b 显示；「去配置」由宿主接到补配门禁（`HomeGateSurface.gate('banner')`），
 * 门禁语义与四入口合同不变（homeOnboardingGate）。保存成功后以高度 + 透明度折叠消失
 * （BANNER-03）：`grid-template-rows 1fr→0fr` 同时 `opacity 1→0`，收起 240ms、折叠侧
 * 延迟 120ms（`grid-template-rows` 是 PRD §9.4 transform/opacity 红线的唯一例外）。
 * 出现 = 淡入 + 上移 8px（`hr-banner-rise` 挂在卡片上，240ms ease-out）。时长 / 延迟
 * 走登记 token：出现 `--motion-home-banner-enter`，收起 `--motion-home-banner-collapse*`
 * （PRD §10.3 逐值登记；reduce 全档归零 = 瞬时），组件里不写裸时长。折叠动画窗口走完
 * 卸载内容并打 `hidden` + `inert`（BANNER-03：收起后从无障碍树移除、不残留可聚焦元素）。
 *
 * 版式（PRD §6.7 规格表）：与输入卡片同宽（宿主列内 w-full）、圆角 14px =
 * DESIGN.md §5 `hrbuddy-home-banner`、图标块 32×32 圆角 10px = `hrbuddy-home-banner-tile`、
 * 距输入卡片 12px、内边距 12px 12px 12px 14px、元素间距 12px、无阴影、无关闭钮。
 * 窄容器（主区内容宽度 < 520px，BANNER-04）：按钮换到文字下方并撑满卡片。
 * 颜色全走 HRBuddy PRD 系列窄例外登记的 `--hr-oa-banner-*` token（DESIGN.md §5 /
 * decision log 2026-11-02）：底 `--hr-oa-banner-bg`、线 `--hr-oa-banner-line`（hover
 * `-line-hover`）、标题 `--hr-oa-banner-ink`、副文案 `--hr-oa-banner-sub`、图标块渐变
 * `--hr-oa-banner-tile-from/to`（品牌蓝 135°）、按钮 `--hr-oa-banner-cta-bg/fg` 与
 * hover 阴影 `--hr-oa-banner-cta-shadow`。焦点环走既有 `--focus-ring`（2px 蓝）。
 *
 * 无障碍（BANNER-05）：普通容器不加 `role="status"`；唯一可聚焦元素是「去配置」（宿主
 * 渲染在输入卡之前，Tab 顺序紧挨输入框）；图标块 `aria-hidden`。13.5px / 12.5px 是
 * PRD §6.7 逐值产品字号（DESIGN.md §3「HRBuddy 首页未配置横幅」排版豁免）。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Sparkles } from 'lucide-react';

import { cn } from '@/lib/utils';
import { trackHrOaEvent } from '@/lib/hrOaTelemetry';

/** 窄容器阈值（BANNER-04：主区内容宽度 < 520px 按钮换行撑满）。 */
const NARROW_WIDTH_PX = 520;

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
  // 窄容器布局（BANNER-04）：主区内容宽度 = 本卡自身宽度（宿主列内 w-full）。
  const [narrow, setNarrow] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      return;
    }
    if (!rendered) return;
    const timer = window.setTimeout(() => setRendered(false), collapseWindowMs());
    return () => window.clearTimeout(timer);
  }, [visible, rendered]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // 收起期间 display:none 宽度为 0，不翻转布局；复现后由下一次测量决定。
      if (width > 0) setNarrow(width < NARROW_WIDTH_PX);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 窗口走完（含 jsdom / reduce 的 0ms 窗口）才打 hidden + inert：收起后从无障碍树
  // 移除、不残留可聚焦元素（BANNER-03 / Review Focus #6）；收起动画期间先 inert。
  const collapsed = !visible && !rendered;

  return (
    <div
      ref={wrapRef}
      data-testid="home-onboarding-banner"
      hidden={collapsed || undefined}
      inert={!visible || undefined}
      aria-hidden={!visible || undefined}
      className={cn(
        'grid w-full transition-[grid-template-rows,opacity]',
        visible
          ? 'grid-rows-[1fr] opacity-100 duration-[var(--motion-home-banner-enter)] ease-[var(--motion-ease-out)]'
          : 'grid-rows-[0fr] opacity-0 duration-[var(--motion-home-banner-collapse)] ease-[var(--motion-ease-move)] delay-[var(--motion-home-banner-collapse-delay)]',
      )}
    >
      {rendered && (
        <div className="min-h-0 overflow-hidden">
          <div
            data-banner-card
            className={cn(
              'hr-banner-rise mb-3 rounded-[14px] border border-[var(--hr-oa-banner-line)]',
              'flex items-center gap-3 bg-[var(--hr-oa-banner-bg)]',
              'pt-3 pr-3 pb-3 pl-[14px] transition-colors hover:border-[var(--hr-oa-banner-line-hover)]',
              narrow ? 'flex-wrap' : 'flex-nowrap',
            )}
          >
            <span
              data-banner-tile
              aria-hidden
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-white',
                'bg-[linear-gradient(135deg,var(--hr-oa-banner-tile-from),var(--hr-oa-banner-tile-to))]',
              )}
            >
              <Sparkles size={16} strokeWidth={2} aria-hidden />
            </span>
            <div
              className={cn(
                'flex min-w-0 flex-col break-words',
                narrow ? 'flex-[1_0_calc(100%_-_44px)]' : 'flex-1',
              )}
            >
              <span className="text-[13.5px] font-semibold leading-5 text-[var(--hr-oa-banner-ink)]">
                {t('onboarding.homeBanner.title')}
              </span>
              <span className="text-[12.5px] font-normal leading-[18px] text-[var(--hr-oa-banner-sub)]">
                {t('onboarding.homeBanner.sub')}
              </span>
            </div>
            <button
              type="button"
              data-testid="home-onboarding-banner-action"
              onClick={() => {
                // 埋点（profile-menu PRD §11 home_banner_click）：横幅「去配置」点击。
                // 无事件属性；随后门禁记 home_gate_trigger(trigger=banner)，
                // 弹窗打开另有 model_dialog_view(origin=home_banner)。
                trackHrOaEvent('home_banner_click', {});
                onConfigure();
              }}
              className={cn(
                'inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-full pr-3 pl-[14px]',
                'bg-[var(--hr-oa-banner-cta-bg)] text-13 font-medium text-[var(--hr-oa-banner-cta-fg)]',
                'transition-[background-color,transform,box-shadow] duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]',
                'hover:-translate-y-px hover:shadow-[var(--hr-oa-banner-cta-shadow)] active:scale-[0.98]',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
                narrow && 'w-full',
              )}
            >
              {t('onboarding.homeBanner.action')}
              <ArrowRight size={14} strokeWidth={2} aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
