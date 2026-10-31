/**
 * AddModelDialog — 对齐 WorkBuddy 的「添加模型」弹窗（HRBuddy 2026-10-29 需求 6）。
 *
 * 与需求 4 的 `AddGatewayDialog` 的关系：需求 6 明确要求「参考和对齐 workbuddy，
 * 只支持：供应商（仅支持 OpenAI 兼容协议 API），包括 UI」，故本弹窗**取代**
 * 三输入框版本，协议固定 OpenAI 兼容。
 *
 * 布局照 owner 提供的 WorkBuddy 截图逐行对齐：
 *   添加模型                                        ×
 *   供应商（仅支持 OpenAI 兼容协议 API）
 *   [ ✧ 自定义                                 ▾ ]
 *   接口地址
 *   [ https://api.example.com/v1/chat/completions ]
 *   API Key
 *   [ 输入你的 API Key                        👁 ] [测试连接]
 *   模型名称
 *   [ 输入模型参数值，例如 gpt-4o 或 openai/gpt-4o ]
 *                                          [取消] [保存]
 *
 * owner 后续裁决（2026-10-29）：
 *   - 不要「查看文档 ↗」；
 *   - 不要「高级配置」四个勾选，**模型能力默认全开**。
 *
 * ⚠️ 有意偏离 DESIGN.md（两处，均因需求要求「包括 UI」对齐 WorkBuddy）：
 *   1. §4「有 Cancel 的对话框不带右上角 ×」——参考图 × 与「取消」并存；
 *   2. §4「单行输入框用 9999px 胶囊圆角」——参考图是 10px 圆角矩形；
 *   3. §4「点遮罩不得关闭弹窗」——owner 要求点 × 与点空白都能关闭，对齐 WorkBuddy。
 *
 * 凭证去向：API key 经 per-runtime key 提交，落系统 keychain/safeStorage，
 * 不进 custom_providers 表，也绝不进仓库。
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { createCustomProvider } from '@/lib/customProviders';
import { uniqueCustomProviderId } from '@/lib/customProviderId';
import type { CustomProviderConfig } from '@cindy/model-providers';

export interface AddModelDialogProps {
  open: boolean;
  onClose: () => void;
  /** 配置落库后回传新供应商 id（供左栏选中）。 */
  onSaved: (providerId: string) => void;
  /** 用于生成唯一 id（custom provider id 同账号内唯一）。 */
  existingIds: readonly string[];
}

/** 需求 6：仅 OpenAI 兼容协议。`openai-chat` 即 chat/completions。 */
const OPENAI_COMPAT_PROTOCOL = 'openai-chat';
const AGENT = 'claude-code';

/** WorkBuddy 截图的输入框是 10px 圆角矩形（非 DESIGN.md 的胶囊）。 */
const FIELD_STYLE = {
  borderColor: 'var(--border-default)',
  background: 'var(--surface-elevated)',
  borderRadius: '10px',
} as const;

/** 输入框统一高度/圆角/字号，照参考图。 */
const FIELD_INPUT_CLASS = '!rounded-[10px] !h-[46px] !text-[15px]';

type FieldKey = 'baseUrl' | 'apiKey' | 'model';

function displayNameFromUrl(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname;
    return host ? `网关 · ${host}` : '自定义供应商';
  } catch {
    return '自定义供应商';
  }
}

function validateBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'required';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'protocol';
    if (url.username || url.password) return 'protocol';
  } catch {
    return 'invalid';
  }
  return null;
}

export function AddModelDialog({ open, onClose, onSaved, existingIds }: AddModelDialogProps) {
  const { t } = useTranslation();
  const uid = useId();

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null);
  const [testDetail, setTestDetail] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBaseUrl('');
    setApiKey('');
    setModel('');
    setErrors({});
    setSubmitting(false);
    setTesting(false);
    setTestResult(null);
    setTestDetail(null);
    setSubmitError(null);
  }, [open]);

  const fieldId = useCallback((key: string) => `${uid}-${key}`, [uid]);

  /**
   * 测试连接：**真实连通**——向网关发一次最小协议探测，验证端点 / 密钥 / 模型都通。
   * 复用 `maker:provider:test-connection`（与 ProviderConnectionDialog 的「测试连接」
   * 同一能力），不再只做本地字段校验。
   */
  const handleTest = useCallback(async () => {
    const baseError = validateBaseUrl(baseUrl);
    if (baseError || !apiKey.trim() || !model.trim()) {
      setErrors({
        ...(baseError ? { baseUrl: baseError } : {}),
        ...(!apiKey.trim() ? { apiKey: 'required' } : {}),
        ...(!model.trim() ? { model: 'required' } : {}),
      });
      setTestResult('fail');
      setTestDetail(t('settings.providers.modelDialog.testInvalid'));
      return;
    }
    setErrors({});
    setTesting(true);
    setTestResult(null);
    setTestDetail(null);
    try {
      const result = await window.electronAPI.maker.testProviderConnection({
        kind: 'adhoc',
        requestId: `add-model-${Date.now()}`,
        spec: {
          agent: AGENT,
          baseUrl: baseUrl.trim(),
          modelId: model.trim(),
          authMethod: 'apiKey',
          wireProtocol: OPENAI_COMPAT_PROTOCOL,
          apiKey: apiKey.trim(),
        },
      });
      if (result?.ok) {
        setTestResult('ok');
        setTestDetail(
          t('settings.providers.modelDialog.testOkWithLatency', {
            ms: Math.round(result.latencyMs ?? 0),
          }),
        );
      } else {
        setTestResult('fail');
        setTestDetail(
          result?.detail || t('settings.providers.modelDialog.testFail'),
        );
      }
    } catch (error) {
      setTestResult('fail');
      setTestDetail(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }, [baseUrl, apiKey, model, t]);

  const handleConfirm = useCallback(async () => {
    const next: Partial<Record<FieldKey, string>> = {};
    const baseError = validateBaseUrl(baseUrl);
    if (baseError) next.baseUrl = baseError;
    if (!apiKey.trim()) next.apiKey = 'required';
    if (!model.trim()) next.model = 'required';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const trimmedBase = baseUrl.trim();
    // 需求 2026-10-29：不要「高级配置」勾选，模型能力默认全开。
    // 注：reasoningRequired 语义是「思考不可关闭」(移除 off 档)，不是「支持思考」。
    const config: CustomProviderConfig = {
      id: uniqueCustomProviderId(displayNameFromUrl(trimmedBase), new Set(existingIds)),
      name: displayNameFromUrl(trimmedBase),
      auth: { method: 'apiKey' },
      runtimes: {
        [AGENT]: {
          wireProtocol: OPENAI_COMPAT_PROTOCOL,
          baseUrl: trimmedBase,
          models: [
            {
              id: model.trim(),
              name: model.trim(),
              supportsToolCalls: true,
              supportsImageInput: true,
              reasoningRequired: true,
            },
          ],
        },
      },
    };

    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await createCustomProvider(config, { [AGENT]: apiKey.trim() });
      if (result?.ok === false) {
        setSubmitError(t('settings.providers.gateway.saveFailed'));
        setSubmitting(false);
        return;
      }
      onSaved(config.id);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'failed');
      setSubmitting(false);
    }
  }, [baseUrl, apiKey, model, existingIds, onSaved, t]);

  // 组件常驻挂载(由父级 `open` 控制),关闭时必须整棵卸载,否则点 × 只改 state 而 DOM 仍在。
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.providers.modelDialog.title')}
    >
      {/* 遮罩：点空白处关闭（owner 2026-10-29：对齐 WorkBuddy；有意偏离 DESIGN.md
          §4「点遮罩不得关闭弹窗」）。保存中不响应，避免误触丢掉已填内容。 */}
      <div
        className="modal-scrim absolute inset-0"
        onClick={() => {
          if (!submitting) onClose();
        }}
      />

      <div
        className="modal-panel relative flex max-h-[min(680px,90vh)] w-full flex-col"
        style={{ maxWidth: 'min(520px, 100vw - 32px)' }}
      >
        {/* 标题栏：WorkBuddy 参考图带 ×（有意偏离 DESIGN.md，见文件头） */}
        <div className="flex items-start justify-between gap-4 px-8 pt-7">
          <h2 className="text-[22px] font-semibold leading-tight text-[var(--confirm-title)]">
            {t('settings.providers.modelDialog.title')}
          </h2>
          <button
            type="button"
            aria-label={t('settings.providers.modelDialog.close')}
            className="mt-1 rounded-full p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            onClick={() => {
              if (!submitting) onClose();
            }}
            disabled={submitting}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M5 5l8 8M13 5l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 pb-2 pt-6">
          {/* 供应商（仅支持 OpenAI 兼容协议 API）—— 独立一行，无「查看文档」 */}
          <p className="mb-2.5 text-[15px] text-[var(--confirm-desc)]">
            {t('settings.providers.modelDialog.provider')}
          </p>

          {/* 下拉：当前只提供「自定义」一项（owner 裁决 2026-10-29） */}
          <div className="flex items-center gap-2.5 px-4 py-3" style={FIELD_STYLE}>
            <Sparkles size={17} className="text-[var(--text-secondary)]" />
            <span className="flex-1 text-[15px] text-[var(--text-primary)]">
              {t('settings.providers.modelDialog.custom')}
            </span>
            <ChevronDown size={17} className="text-[var(--text-secondary)]" />
          </div>

          {submitError ? (
            <p className="mt-4 text-13 text-[var(--error-fg)]" role="alert">
              {submitError}
            </p>
          ) : null}

          {/* 接口地址 */}
          <div className="mt-7">
            <label
              htmlFor={fieldId('baseUrl')}
              className="mb-2.5 block text-[15px] font-medium text-[var(--text-primary)]"
            >
              {t('settings.providers.modelDialog.endpoint')}
            </label>
            <Input
              id={fieldId('baseUrl')}
              value={baseUrl}
              onChange={setBaseUrl}
              placeholder="https://api.example.com/v1/chat/completions"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.baseUrl ? true : undefined}
              error={Boolean(errors.baseUrl)}
              inputClassName={FIELD_INPUT_CLASS}
            />
            {errors.baseUrl ? (
              <p className="mt-1.5 text-12 text-[var(--error-fg)]">
                {t('settings.providers.gateway.invalidUrl')}
              </p>
            ) : null}
          </div>

          {/* API Key：输入框与「测试连接」并排（照参考图） */}
          <div className="mt-7">
            <label
              htmlFor={fieldId('apiKey')}
              className="mb-2.5 block text-[15px] font-medium text-[var(--text-primary)]"
            >
              {t('settings.providers.modelDialog.apiKey')}
            </label>
            <div className="flex items-center gap-2.5">
              <div className="min-w-0 flex-1">
                <Input
                  id={fieldId('apiKey')}
                  secret
                  mono
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={t('settings.providers.modelDialog.apiKeyPlaceholder')}
                  autoComplete="off"
                  secretTipContentClassName="z-[10001]"
                  aria-invalid={errors.apiKey ? true : undefined}
                  error={Boolean(errors.apiKey)}
                  inputClassName={FIELD_INPUT_CLASS}
                />
              </div>
              <Button
                variant="secondary"
                size="lg"
                type="button"
                onClick={() => void handleTest()}
                disabled={testing}
                className="shrink-0 !rounded-[10px] !h-[46px] px-4"
              >
                {testing ? <Spinner /> : null}
                {t('settings.providers.modelDialog.testConnection')}
              </Button>
            </div>
            {errors.apiKey ? (
              <p className="mt-1.5 text-12 text-[var(--error-fg)]">
                {t('settings.providers.gateway.required')}
              </p>
            ) : testDetail ? (
              <p
                className={`mt-1.5 text-12 ${testResult === 'ok' ? 'text-[var(--text-secondary)]' : 'text-[var(--error-fg)]'}`}
              >
                {testDetail}
              </p>
            ) : null}
          </div>

          {/* 模型名称 */}
          <div className="mt-7">
            <label
              htmlFor={fieldId('model')}
              className="mb-2.5 block text-[15px] font-medium text-[var(--text-primary)]"
            >
              {t('settings.providers.modelDialog.modelName')}
            </label>
            <Input
              id={fieldId('model')}
              value={model}
              onChange={setModel}
              placeholder={t('settings.providers.modelDialog.modelPlaceholder')}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={errors.model ? true : undefined}
              error={Boolean(errors.model)}
              inputClassName={FIELD_INPUT_CLASS}
            />
            {errors.model ? (
              <p className="mt-1.5 text-12 text-[var(--error-fg)]">
                {t('settings.providers.gateway.required')}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 px-8 pb-7 pt-3">
          <Button
            variant="secondary"
            size="lg"
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="!rounded-[10px] px-6"
          >
            {t('settings.providers.custom.cancel')}
          </Button>
          <Button
            variant="primary"
            size="lg"
            type="button"
            disabled={submitting}
            onClick={() => void handleConfirm()}
            className="!rounded-[10px] px-6"
          >
            {submitting ? <Spinner /> : null}
            {t('settings.providers.custom.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
