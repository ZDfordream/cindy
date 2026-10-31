/**
 * ModelGatewayForm — 添加 / 编辑模型的三栏弹窗（设计稿 §5.2）。
 *
 * 三栏固定顺序：**接口地址 → 密钥 → 模型**；没有删除按钮（删除在列表行上）。
 * 保存以连通测试通过为前提（owner 裁决 2026-10-31）：点保存先跑真实探测
 * `testModelConnectivity`；**通过**才 `add`/`update` 落库并关窗；**不通**不落库、
 * 不关窗，弹窗内显示失败原因（Ruling 11：主文案是人话标签，原始 detail 只进
 * tooltip / 次要行——它可能是 `AUTH_INVALID` 这类机器码）。
 *
 * 密钥栏 `Input secret`（内置显隐）。编辑态密钥**不回显**：显示「保持不变」占位，
 * 留空 = 沿用已存（`readCustomProviderKey` 现读，只作为本次探测/落库的 IPC 入参，
 * 不进 React state、不落任何 JSON）。
 *
 * Ruling 14：保存即测试——保存门的探测结果就是条目此刻的连通状态（设计稿 §5.2
 * 「通过 → 写入延迟」）。create / edit 成功都把本次探测结果 `setStatus` 落到条目上，
 * 不做「改后置 untested」；正常路径下列表不出现「未测试」行。
 *
 * ⚠️ 有意偏离 DESIGN.md（沿用 `AddModelDialog.tsx` 既有偏离登记 / 设计稿 §7，
 * 不新增）：
 *   1. §4「有 Cancel 的对话框不带右上角 ×」——参考图 × 与「取消」并存；
 *   2. §4「单行输入框用 9999px 胶囊圆角」——参考图是 10px 圆角矩形（按钮同款处理）；
 *   3. §4「点遮罩不得关闭弹窗」——owner 要求点 × 与点空白都能关闭，对齐 WorkBuddy。
 * 弹窗壳复用 ConfirmDialog 的结构（DESIGN.md §4：标题 / 滚动内容区 / 底部按钮 +
 * 共享 `.modal-scrim` / `.modal-panel` 类），因偏离 3（遮罩可关）与保存门（探测
 * 失败不得关窗）不走 `ConfirmDialog` 组件本体。
 *
 * 协议写死 `anthropic-messages`（表单不出协议选项，`testModelConnectivity` 内固定）。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { readCustomProviderKey } from '@/lib/customProviders';

import { useModelGateway } from './ModelGatewayStore';
import { testModelConnectivity } from './useModelConnectivity';
import type { ModelGatewayInput } from './types';

export interface ModelGatewayFormProps {
  open: boolean;
  mode: 'create' | 'edit';
  /**
   * 预填值（接口地址 / 模型）。`mode='edit'` 必带 `id`（稳定句柄，update/setStatus
   * 都钉在它上）。`apiKey` 只作密钥留空时的兜底探测入参，**绝不回显**。
   */
  initial?: { id?: string; baseUrl: string; apiKey?: string; modelId: string };
  onClose: () => void;
  /** 落库成功后回传条目稳定 id（create = 新句柄，edit = 原句柄）。 */
  onSaved: (id: string) => void;
}

/** 参考图的 10px 圆角矩形（偏离登记 2）；其余 Input 样式走 DS 默认。 */
const FIELD_INPUT_CLASS = '!rounded-[10px]';

function validateBaseUrl(value: string): 'required' | 'invalid' | null {
  const trimmed = value.trim();
  if (!trimmed) return 'required';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid';
    if (url.username || url.password) return 'invalid';
  } catch {
    return 'invalid';
  }
  return null;
}

export function ModelGatewayForm({ open, mode, initial, onClose, onSaved }: ModelGatewayFormProps) {
  const { t } = useTranslation();
  const uid = useId();
  const { add, update, setStatus } = useModelGateway();

  const editId = initial?.id;

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    baseUrl?: string;
    apiKey?: string;
    modelId?: string;
  }>({});
  const [saveError, setSaveError] = useState<{ label: string; detail: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // 同步重复提交门闩（DS-6：请求期间表单自己挡住二次提交）。
  const busyRef = useRef(false);

  // 每次打开按模式复位：create 全空；edit 预填接口地址/模型，密钥永不回显。
  useEffect(() => {
    if (!open) return;
    setBaseUrl(mode === 'edit' ? (initial?.baseUrl ?? '') : '');
    setApiKey('');
    setModelId(mode === 'edit' ? (initial?.modelId ?? '') : '');
    setFieldErrors({});
    setSaveError(null);
    setSaving(false);
    busyRef.current = false;
  }, [open, mode, initial?.baseUrl, initial?.modelId]);

  // Esc 关闭（保存中不响应；DESIGN.md §4 关闭路径之一）。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const handleSave = useCallback(async () => {
    if (busyRef.current) return;
    const trimmedBase = baseUrl.trim();
    const trimmedModel = modelId.trim();
    const typedKey = apiKey.trim();

    const errors: { baseUrl?: string; apiKey?: string; modelId?: string } = {};
    const baseError = validateBaseUrl(trimmedBase);
    if (baseError) {
      errors.baseUrl =
        baseError === 'required'
          ? t('settings.providers.gateway.required')
          : t('settings.providers.gateway.invalidUrl');
    }
    if (!trimmedModel) errors.modelId = t('settings.providers.gateway.required');
    // 密钥：创建必填；编辑留空 = 沿用已存（下方 keychain 现读）。
    if (mode === 'create' && !typedKey) errors.apiKey = t('settings.providers.gateway.required');
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    busyRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      // 有效密钥：显式输入 > 调用方兜底 > keychain 现读（只作本次 IPC 入参，不进 state）。
      let effectiveKey = typedKey;
      if (!effectiveKey && mode === 'edit') {
        if (initial?.apiKey) effectiveKey = initial.apiKey;
        else if (editId) effectiveKey = (await readCustomProviderKey(editId, 'claude-code')) ?? '';
      }
      if (!effectiveKey) {
        setFieldErrors({ apiKey: t('settings.providers.gateway.required') });
        return;
      }

      const probeInput: ModelGatewayInput = {
        baseUrl: trimmedBase,
        apiKey: effectiveKey,
        modelId: trimmedModel,
      };
      const probe = await testModelConnectivity(probeInput);
      if (!probe.ok) {
        // 保存门：不通不落库、不关窗。Ruling 11——主文案人话标签，原始 detail
        // 只进次要行 + tooltip。
        setSaveError({
          label: t('settings.providers.modelDialog.saveProbeFailed'),
          detail: probe.detail,
        });
        return;
      }

      // Ruling 14：保存即测试。探测刚验过这组 baseUrl/密钥/模型，结果就是最新
      // 状态——create/edit 都写入，覆盖 add() 的初始 untested，也不留陈旧「已连通」。
      if (mode === 'create') {
        const id = await add(probeInput);
        setStatus(id, probe);
        onSaved(id);
      } else {
        await update(editId!, probeInput);
        setStatus(editId!, probe);
        onSaved(editId!);
      }
      onClose();
    } catch (error) {
      setSaveError({
        label: t('settings.providers.gateway.saveFailed'),
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }, [
    add,
    apiKey,
    baseUrl,
    editId,
    initial?.apiKey,
    mode,
    modelId,
    onClose,
    onSaved,
    setStatus,
    t,
    update,
  ]);

  // 编辑流钉在稳定句柄上（update / setStatus 都要它）；缺了是调用方编程错误，
  // 放在 hooks 之后抛（抛出前不得改变 hook 调用次数）。
  if (open && mode === 'edit' && !editId) {
    throw new Error("ModelGatewayForm: mode='edit' requires initial.id");
  }

  if (!open) return null;

  const dismiss = () => {
    if (busyRef.current) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={
        mode === 'edit'
          ? t('settings.providers.modelDialog.editTitle')
          : t('settings.providers.modelDialog.title')
      }
    >
      {/* 遮罩：点空白处关闭（偏离登记 3）。保存中不响应，避免误触丢掉已填内容。 */}
      <div className="modal-scrim absolute inset-0" onClick={dismiss} />

      <div
        className="modal-panel relative flex max-h-[min(680px,90vh)] w-full flex-col"
        style={{ maxWidth: 'min(460px, 100vw - 32px)' }}
      >
        {/* 标题栏：× 与「取消」并存（偏离登记 1）。 */}
        <div className="flex items-start justify-between gap-4 px-6 pt-5">
          <h2 className="text-lg font-semibold leading-tight text-[var(--confirm-title)]">
            {mode === 'edit'
              ? t('settings.providers.modelDialog.editTitle')
              : t('settings.providers.modelDialog.title')}
          </h2>
          <button
            type="button"
            aria-label={t('settings.providers.modelDialog.close')}
            className="mt-0.5 rounded-full p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-60"
            onClick={dismiss}
            disabled={saving}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path
                d="M5 5l8 8M13 5l-8 8"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-2 pt-4">
          {/* 三栏固定顺序：接口地址 → 密钥 → 模型（设计稿 §5.2）。 */}
          <FormField
            id={`${uid}-baseUrl`}
            label={t('settings.providers.modelDialog.endpoint')}
            error={fieldErrors.baseUrl}
            reserveFeedback
          >
            {(control) => (
              <Input
                {...control}
                value={baseUrl}
                onChange={setBaseUrl}
                placeholder={t('settings.providers.modelDialog.baseUrlPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                inputClassName={FIELD_INPUT_CLASS}
              />
            )}
          </FormField>

          <div className="mt-4">
            <FormField
              id={`${uid}-apiKey`}
              label={t('settings.providers.modelDialog.key')}
              error={fieldErrors.apiKey}
              reserveFeedback
            >
              {(control) => (
                <Input
                  {...control}
                  secret
                  mono
                  value={apiKey}
                  onChange={setApiKey}
                  placeholder={
                    mode === 'edit'
                      ? t('settings.providers.custom.fields.apiKeyEditPlaceholder')
                      : t('settings.providers.modelDialog.apiKeyPlaceholder')
                  }
                  autoComplete="off"
                  secretTipContentClassName="z-[10001]"
                  inputClassName={FIELD_INPUT_CLASS}
                />
              )}
            </FormField>
          </div>

          <div className="mt-4">
            <FormField
              id={`${uid}-modelId`}
              label={t('settings.providers.modelDialog.model')}
              hint={t('settings.providers.gateway.modelHint')}
              error={fieldErrors.modelId}
              reserveFeedback
            >
              {(control) => (
                <Input
                  {...control}
                  value={modelId}
                  onChange={setModelId}
                  placeholder={t('settings.providers.modelDialog.modelIdPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                  inputClassName={FIELD_INPUT_CLASS}
                />
              )}
            </FormField>
          </div>

          {saveError ? (
            <div
              role="alert"
              title={saveError.detail}
              className="mt-1 rounded-[10px] border border-[var(--error-border)] px-3 py-2"
            >
              {/* Ruling 11：主文案人话标签；原始 detail（可能是机器码）只在次要行。 */}
              <p className="text-13 text-[var(--error-fg)]">{saveError.label}</p>
              <p className="mt-1 text-12 text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                {saveError.detail}
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 pb-5 pt-3">
          <Button
            variant="secondary"
            size="lg"
            type="button"
            disabled={saving}
            onClick={dismiss}
            className="!rounded-[10px] px-6"
          >
            {t('settings.providers.custom.cancel')}
          </Button>
          <Button
            variant="primary"
            size="lg"
            type="button"
            disabled={saving}
            loading={saving}
            onClick={() => void handleSave()}
            className="!rounded-[10px] px-6"
          >
            {t('settings.providers.custom.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
