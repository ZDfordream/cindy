/**
 * LoginScreen —— S2 账号密码登录（login-onboarding PRD §6.2 FR-LOGIN-01~06）。
 *
 * 几何按 PRD §6.2：卡片 400px / 圆角 24px、输入高 44px / 圆角 14px、主操作高
 * 44px——均已登记为 `DESIGN.md §5`「HRBuddy PRD-family frames」成员（
 * `hrbuddy-login-card` 24px / `hrbuddy-prd-control` 14px，44px 高为同族高度例外，
 * 见 decision log 2026-11-01）。文字走 DESIGN.md §3 字号字重梯（PRD 标题 22/700
 * 收敛为 20/600，其余逐档对上）；颜色一律语义 token，双模式同源。
 *
 * 口令只进受控 state 与 `useHrOaAuth().login` 入参：不进日志、不进错误文案、
 * `autoComplete="off"` 阻止写入任何持久自动填充存储。
 */

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, CircleAlert, Eye, EyeOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { Mascot } from './Mascot';
import { useHrOaAuth, type OaLoginFailure } from './hrOaAuthStore';

type Phase = 'idle' | 'submitting' | 'success';

/** PRD §6.2 几何：44px 高、14px 圆角（§5 `hrbuddy-prd-control` + 同族高度例外）；文字 15px 在 DS-8 字号白名单内。 */
const FIELD_INPUT_CLASS = '!h-11 !rounded-[14px] text-15';

/** PRD `.btn`（S2 操作钮）14px 圆角 = §5 `hrbuddy-prd-control`；S1 胶囊钮保持组件默认全圆角。 */
const CARD_ACTION_CLASS = '!rounded-[14px] px-6';

const ERROR_COPY: Record<OaLoginFailure, string> = {
  wrong_credentials: 'hrOa.login.error.credentials',
  locked: 'hrOa.login.error.locked',
  network_error: 'hrOa.login.error.network',
  timeout: 'hrOa.login.error.timeout',
};

export function LoginScreen(props: { onBack: () => void; onSuccess: () => void }): React.JSX.Element {
  const { onBack, onSuccess } = props;
  const { t } = useTranslation();
  const { login } = useHrOaAuth();
  const uid = useId();

  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<OaLoginFailure | null>(null);

  const accountRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLFormElement>(null);
  const successTimerRef = useRef<number | null>(null);
  const submittingRef = useRef(false);

  const busy = phase === 'submitting';
  const succeeded = phase === 'success';
  const locked = busy || succeeded;
  const canSubmit = account.trim().length > 0 && password.length > 0 && phase === 'idle';

  // FR-LOGIN-02：进入 S2 自动聚焦账号框。
  useEffect(() => {
    accountRef.current?.focus();
    return () => {
      if (successTimerRef.current !== null) window.clearTimeout(successTimerRef.current);
    };
  }, []);

  const clearError = (): void => {
    setError(null);
  };

  /** FR-LOGIN-05：出错卡片水平抖动一次；重播走「摘类 → reflow → 加类」。 */
  const shakeCard = (): void => {
    const card = cardRef.current;
    if (!card) return;
    card.classList.remove('shake');
    void card.offsetHeight;
    card.classList.add('shake');
  };

  const handleSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    // 防重入锁（PRD FR-LOGIN-04）：进行中/成功停留期的重复提交一律忽略。
    if (submittingRef.current || phase !== 'idle') return;
    if (!canSubmit) return;
    submittingRef.current = true;
    setPhase('submitting');
    setError(null);
    // 桥/handler 拒绝（非 { error } 合同内的失败）按网络异常收口，避免卡在登录中。
    let result: Awaited<ReturnType<typeof login>>;
    try {
      result = await login(account.trim(), password);
    } catch {
      result = { error: 'network_error' };
    }
    submittingRef.current = false;
    if ('error' in result) {
      setPhase('idle');
      setError(result.error);
      shakeCard();
      if (result.error === 'wrong_credentials') {
        // FR-LOGIN-05：清空密码并聚焦密码框（账号保留，便于直接改密重试）。
        setPassword('');
        passwordRef.current?.focus();
      } else if (result.error === 'locked') {
        // FR-LOGIN-05：聚焦并选中账号框，让用户看清是哪个账号被锁。
        const input = accountRef.current;
        input?.focus();
        input?.select();
      } else {
        // network / timeout：输入保留，焦点回登录按钮。
        submitRef.current?.focus();
      }
      return;
    }
    setPhase('success');
    successTimerRef.current = window.setTimeout(() => {
      onSuccess();
    }, 500);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    // FR-LOGIN-01：Esc 同「返回」；登录中与成功停留期忽略（FR-LOGIN-04）。
    if (event.key === 'Escape' && !locked) {
      event.preventDefault();
      onBack();
    }
  };

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-[var(--surface)] px-4">
      <form
        ref={cardRef}
        aria-labelledby={`${uid}-title`}
        className={cn(
          'hr-oa-login-card relative flex w-[400px] max-w-full flex-col rounded-[24px]',
          'border border-[var(--border-default)] bg-[var(--surface-elevated)] px-8 pb-7 pt-7',
        )}
        onSubmit={(event) => void handleSubmit(event)}
        onKeyDown={handleKeyDown}
      >
        <button
          type="button"
          className={cn(
            'absolute left-4 top-4 inline-flex h-8 items-center gap-1 rounded-lg px-2 text-13',
            'text-[var(--text-secondary)] transition-colors',
            'enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
          disabled={locked}
          onClick={onBack}
        >
          <ArrowLeft size={15} aria-hidden />
          {t('hrOa.login.back')}
        </button>

        <div className="flex justify-center pt-2">
          <Mascot variant="card" />
        </div>

        <h2
          id={`${uid}-title`}
          className="mt-2 text-center text-20 font-semibold leading-normal text-[var(--text-primary)]"
        >
          {t('hrOa.login.title')}
        </h2>
        <p className="mt-1.5 text-center text-13 leading-normal text-[var(--text-tertiary)]">
          {t('hrOa.login.subtitle')}
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <FormField id={`${uid}-account`} label={t('hrOa.login.account')}>
            {(control) => (
              <Input
                {...control}
                inputRef={accountRef}
                error={error === 'wrong_credentials' || error === 'locked'}
                value={account}
                onChange={(value) => {
                  setAccount(value);
                  clearError();
                }}
                placeholder={t('hrOa.login.accountPlaceholder')}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                readOnly={locked}
                inputClassName={FIELD_INPUT_CLASS}
              />
            )}
          </FormField>

          <FormField id={`${uid}-password`} label={t('hrOa.login.password')}>
            {(control) => (
              <Input
                {...control}
                inputRef={passwordRef}
                error={error === 'wrong_credentials'}
                type={passwordVisible ? 'text' : 'password'}
                value={password}
                onChange={(value) => {
                  setPassword(value);
                  clearError();
                }}
                placeholder={t('hrOa.login.passwordPlaceholder')}
                // 口令不进任何持久存储：关自动填充、关拼写与自动大写。
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                readOnly={locked}
                inputClassName={cn(FIELD_INPUT_CLASS, 'pr-12')}
                trailing={
                  <button
                    type="button"
                    disabled={locked}
                    aria-pressed={passwordVisible}
                    aria-label={
                      passwordVisible ? t('hrOa.login.hidePassword') : t('hrOa.login.showPassword')
                    }
                    onClick={() => setPasswordVisible((visible) => !visible)}
                    className={cn(
                      'absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg',
                      'text-[var(--text-tertiary)] transition-colors',
                      'enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-secondary)]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                  >
                    {passwordVisible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
                  </button>
                }
              />
            )}
          </FormField>
        </div>

        {/* FR-LOGIN-05：卡片内单行错误区，常驻占位 20px（PRD 占位高度）。 */}
        <div
          role="alert"
          aria-live="assertive"
          className="mt-1.5 flex min-h-[20px] items-start gap-1.5 text-13 leading-normal text-[var(--error-fg)]"
        >
          {error ? (
            <>
              <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span>{t(ERROR_COPY[error])}</span>
            </>
          ) : null}
        </div>

        <Button
          ref={submitRef}
          type="submit"
          variant="primary"
          palette="confirmation"
          size="lg"
          className={cn('mt-2 h-11 w-full', CARD_ACTION_CLASS, succeeded && 'disabled:opacity-100')}
          disabled={!canSubmit}
          aria-busy={busy || undefined}
        >
          {succeeded ? (
            <span className="inline-flex items-center gap-1.5">
              <Check size={16} className="hr-oa-success-check" aria-hidden />
              {t('hrOa.login.success')}
            </span>
          ) : busy ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner size={14} />
              {t('hrOa.login.submitting')}
            </span>
          ) : (
            t('hrOa.login.submit')
          )}
        </Button>

        <p
          aria-disabled="true"
          className="mt-3 cursor-default select-none text-center text-12 leading-normal text-[var(--text-tertiary)]"
        >
          {t('hrOa.login.forgot')}
        </p>
      </form>
    </div>
  );
}
