import { Button } from '@/components/ui/button';
import { ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/**
 * 首页零可用来源单行动卡：提示配置模型，CTA「去配置」直达补配弹窗（S4b 由
 * `OnboardingHomeBanner` 承担未配置引导，本卡只在其余零来源态出现——见
 * NewMakerDraftRoute 的挂载条件）。文案自 2026-11-01 起从「登录 HRBuddy」改写为
 * 配置模型口径（Task 4 deferred minor：旧文案配隐藏 CTA 是死端）；cloud 分支保留
 * Cindy 官方服务开通口径（藏不删的恢复面）。
 */
export function HomeZeroModelAction({
  authMode,
  narrow,
  onConfigure,
}: {
  authMode: 'signed-out' | 'local' | 'cloud' | 'hr';
  narrow: boolean;
  /** 「去配置」：打开添加模型弹窗（补配门禁 openDialog）；未接线时回落设置页。 */
  onConfigure?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cloud = authMode === 'cloud';

  return (
    <div data-testid="home-zero-model" className="mt-4 w-full">
      <div
        className={cn(
          'flex w-full items-center gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-[18px] py-4',
          narrow && 'flex-col items-stretch',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-15 font-medium leading-snug text-[var(--text-primary)]">
            {t(cloud ? 'onboarding.homeZeroModel.cloudTitle' : 'onboarding.homeZeroModel.title')}
          </p>
          <p className="text-13 leading-relaxed text-[var(--text-secondary)]">
            {t(cloud ? 'onboarding.homeZeroModel.cloudDesc' : 'onboarding.homeZeroModel.desc')}
          </p>
        </div>
        <Button
          variant="cta"
          size="lg"
          compact
          type="button"
          data-testid="home-zero-model-cta"
          onClick={() => {
            if (cloud) {
              navigate('/settings?tab=providers&connect=xd');
              return;
            }
            onConfigure?.();
          }}
          className={cn(narrow && 'self-end')}
        >
          {t(cloud ? 'onboarding.homeZeroModel.cloudCta' : 'onboarding.homeZeroModel.cta')}
        </Button>
      </div>
      <button
        type="button"
        data-testid="home-zero-model-own-api"
        onClick={() => navigate('/settings?tab=providers&wizard=1')}
        className="mt-2 ml-2 inline-flex items-center gap-0.5 rounded-lg px-2 py-1 text-12 font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
      >
        {t('onboarding.homeZeroModel.ownApi')}
        <ChevronRight size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
