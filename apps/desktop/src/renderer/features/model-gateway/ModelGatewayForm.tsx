/**
 * ModelGatewayForm — 添加 / 编辑模型的三栏弹窗（设计稿 §5.2 / PRD 2026-11-01）。
 *
 * 三栏固定顺序：**接口地址 → 密钥 → 模型**；没有删除按钮（删除在列表行上）；
 * 协议写死 `anthropic-messages`（表单不出协议选项，store 内固定）。
 *
 * 保存门 = **合法性门**（PRD：合法即存、保存不探测）：URL `^https?:\/\/\S+$`、
 * 密钥非空、模型非空且不与其它条目 modelId 重复，三项零错「保存」才可点；点了就
 * `add`/`update` 落库并关窗，落库后条目恒「未测试」（连通性由列表行「重测」负责，
 * 不拦保存）。写盘失败弹窗内显示失败原因（Ruling 11：主文案是人话标签，原始
 * detail 只进 tooltip / 次要行——它可能是 `AUTH_INVALID` 这类机器码）。
 * 密钥非空的编辑例外：编辑态密钥不回显（见下），**留空 = 沿用已存**，与「key
 * 非空」在有效密钥层面等价；留空且 keychain 读不到已存密钥时才按「未填」报错。
 *
 * 行内错**触焦后才显示**（touched）：未触焦只留帮助文案（「模型」=「上游模型 ID，
 * 原样发给网关。」），错误出现时取代帮助文案。文案：`请输入接口地址` /
 * `地址需以 http:// 或 https:// 开头` / `请输入 API Key` / `请输入模型 ID` /
 * `该模型已添加`（重复拦截：与任一其它条目相同即拒；编辑回填自身不算重复）。
 *
 * 密钥栏 `Input secret`（内置显隐，aria 显示密钥 / 隐藏密钥）。编辑态密钥**不回显**：
 * 显示「保持不变」占位，留空 = 沿用已存（`readCustomProviderKey` 现读，只作为本次
 * 落库的 IPC 入参，不进 React state、不落任何 JSON）。键入值是受控输入的短暂 state
 * （Ruling 16 语义），**关闭即清**、卸载即销毁，不留到下次打开。
 *
 * 关闭语义分层（PRD 2026-11-01，**推翻旧「点遮罩可关」偏离登记**）：dirty（任一字段
 * 相对初值被改动）点遮罩 → 不关 + 面板 `shake`；clean 点遮罩 → 关；Esc / 取消 / ✕
 * 任何状态都关。Esc 用 capture + stopPropagation 抢占（Ruling 16 同批修复）：一次
 * 按键只关本弹窗，不级联触发 `useSettingsEscape` 再退一层设置。
 *
 * 保存成功 toast（PRD）：新建「已添加 {model}」/ 编辑「已保存 {model}」。
 *
 * ⚠️ 有意偏离 DESIGN.md（沿用 `AddModelDialog.tsx` 既有偏离登记 / 设计稿 §7，
 * 不新增）：
 *   1. §4「有 Cancel 的对话框不带右上角 ×」——参考图 × 与「取消」并存；
 *   2. §4「单行输入框用 9999px 胶囊圆角」——参考图是 10px 圆角矩形（按钮同款处理）。
 * 弹窗壳复用 ConfirmDialog 的结构（DESIGN.md §4：标题 / 滚动内容区 / 底部按钮 +
 * 共享 `.modal-scrim` / `.modal-panel` 类）；校验 / 错误呈现与遮罩 dirty 抖动
 * （PRD，`shake` 类挂 `.modal-panel`，globals.css）不走 `ConfirmDialog` 组件本体。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { readCustomProviderKey } from '@/lib/customProviders';
import { toast } from '@/lib/toast';

import { useModelGateway } from './ModelGatewayStore';
import type { ModelEntry, ModelGatewayInput } from './types';

export interface ModelGatewayFormProps {
  open: boolean;
  mode: 'create' | 'edit';
  /**
   * 预填值（接口地址 / 模型）。`mode='edit'` 必带 `id`（稳定句柄，update 钉在它上）。
   * `apiKey` 只作密钥留空时的兜底落库入参，**绝不回显**。
   */
  initial?: { id?: string; baseUrl: string; apiKey?: string; modelId: string };
  onClose: () => void;
  /** 落库成功后回传条目稳定 id（create = 新句柄，edit = 原句柄）。 */
  onSaved: (id: string) => void;
}

/** 参考图的 10px 圆角矩形（偏离登记 2）；其余 Input 样式走 DS 默认。 */
const FIELD_INPUT_CLASS = '!rounded-[10px]';

interface FormFieldErrors {
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
}

/**
 * PRD `validate()`：三项合法性 + 模型 ID 重复拦截。零错 = 保存可点。
 * URL 按 PRD 脚本的 `^https?:\/\/\S+$` 判（不做完整 URL 解析）；重复判定排除
 * `editId` 自身——编辑回填自身 modelId 不算重复。
 */
function validateFields(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  mode: 'create' | 'edit',
  entries: ModelEntry[],
  editId: string | undefined,
  t: (key: string) => string,
): FormFieldErrors {
  const errors: FormFieldErrors = {};
  const trimmedBase = baseUrl.trim();
  const trimmedKey = apiKey.trim();
  const trimmedModel = modelId.trim();
  if (!trimmedBase) errors.baseUrl = t('settings.providers.modelDialog.baseUrlRequired');
  else if (!/^https?:\/\/\S+$/i.test(trimmedBase)) {
    errors.baseUrl = t('settings.providers.modelDialog.baseUrlInvalid');
  }
  // 创建必填；编辑留空 = 沿用已存密钥（不回显红线下的「key 非空」等价语义）。
  if (mode === 'create' && !trimmedKey) {
    errors.apiKey = t('settings.providers.modelDialog.apiKeyRequired');
  }
  if (!trimmedModel) errors.modelId = t('settings.providers.modelDialog.modelIdRequired');
  else if (entries.some((entry) => entry.modelId === trimmedModel && entry.id !== editId)) {
    errors.modelId = t('settings.providers.modelDialog.modelIdDuplicate');
  }
  return errors;
}

export function ModelGatewayForm({ open, mode, initial, onClose, onSaved }: ModelGatewayFormProps) {
  const { t } = useTranslation();
  const uid = useId();
  const { add, update, entries } = useModelGateway();

  const editId = initial?.id;

  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState('');
  // 行内错触焦后才显示（PRD touched）：触焦标记 + 保存时全开。
  const [touched, setTouched] = useState<{
    baseUrl?: boolean;
    apiKey?: boolean;
    modelId?: boolean;
  }>({});
  // 编辑留空密钥但 keychain 也读不到已存值：保存时才判得出，用它顶出「请输入 API Key」。
  const [keyMissing, setKeyMissing] = useState(false);
  const [saveError, setSaveError] = useState<{ label: string; detail: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // 同步重复提交门闩（DS-6：请求期间表单自己挡住二次提交）。
  const busyRef = useRef(false);
  // 打开时的三栏初值：遮罩 dirty 判定（相对初值被改动）钉在它上。
  const initialRef = useRef({ baseUrl: '', apiKey: '', modelId: '' });
  // shake 是命令式类名增删（PRD 重启动画），className 必须保持常量不被 React 改写。
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 每次打开按模式复位：create 全空；edit 预填接口地址/模型，密钥永不回显。
  // （密钥的清空不在这里——Ruling 16 把它唯一挂在关闭路径，见下方 effect。）
  useEffect(() => {
    if (!open) return;
    const nextBase = mode === 'edit' ? (initial?.baseUrl ?? '') : '';
    const nextModel = mode === 'edit' ? (initial?.modelId ?? '') : '';
    setBaseUrl(nextBase);
    setModelId(nextModel);
    initialRef.current = { baseUrl: nextBase.trim(), apiKey: '', modelId: nextModel.trim() };
    setTouched({});
    setKeyMissing(false);
    setSaveError(null);
    setSaving(false);
    busyRef.current = false;
  }, [open, mode, initial?.baseUrl, initial?.modelId]);

  // Ruling 16：关闭即清密钥。组件常驻挂载（关窗只换 open），键入过的 key 不留到
  // 下次打开；卸载随组件销毁。密钥生命周期以此为唯一来源。
  useEffect(() => {
    if (!open) setApiKey('');
  }, [open]);

  // Esc 关闭（保存中只吞按键不关窗）。capture + preventDefault + stopPropagation
  // 抢占 useSettingsEscape（window 冒泡注册、关闭路径不看 defaultPrevented）：
  // 一次 Esc 只关本弹窗，绝不级联再退一层设置——照 ProviderConnectionDialog 同款。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      if (!busyRef.current) onClose();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  // 合法性门（PRD）：零错才可保存；keyMissing 是保存时才判出的密钥缺口。
  const fieldErrors = validateFields(baseUrl, apiKey, modelId, mode, entries, editId, (key) => t(key));
  const canSave =
    Object.keys(fieldErrors).length === 0 && !keyMissing && !saving;
  const visibleErrors: FormFieldErrors = {
    baseUrl: touched.baseUrl ? fieldErrors.baseUrl : undefined,
    apiKey:
      (touched.apiKey ? fieldErrors.apiKey : undefined) ??
      (keyMissing ? t('settings.providers.modelDialog.apiKeyRequired') : undefined),
    modelId: touched.modelId ? fieldErrors.modelId : undefined,
  };

  /** dirty = 任一字段相对初值被改动（PRD 遮罩分层的判据）。 */
  const isDirty = () =>
    baseUrl.trim() !== initialRef.current.baseUrl ||
    apiKey.trim() !== initialRef.current.apiKey ||
    modelId.trim() !== initialRef.current.modelId;

  // PRD 同款重启动画：摘类 → 强制 reflow → 加类。面板类名表由 React 管、shake 由
  // 这里命令式增删——className 保持常量，React 重渲染不会盖掉它。
  const shakePanel = () => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.classList.remove('shake');
    void panel.offsetWidth;
    panel.classList.add('shake');
  };

  // 遮罩语义分层（PRD 2026-11-01）：dirty 不关只抖；clean 才关。
  const handleScrimClick = () => {
    if (busyRef.current) return;
    if (isDirty()) shakePanel();
    else onClose();
  };

  const handleSave = useCallback(async () => {
    if (busyRef.current) return;
    // 保存 = submit（PRD）：touched 全开。保存钮禁用时走不到这里，这里是兜底。
    setTouched({ baseUrl: true, apiKey: true, modelId: true });
    const currentErrors = validateFields(
      baseUrl,
      apiKey,
      modelId,
      mode,
      entries,
      editId,
      (key) => t(key),
    );
    if (Object.keys(currentErrors).length > 0) return;

    const trimmedBase = baseUrl.trim();
    const trimmedModel = modelId.trim();
    const typedKey = apiKey.trim();

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
        // 编辑留空且已存密钥读不到：按「未填密钥」报 PRD 文案，不落库。
        setKeyMissing(true);
        return;
      }

      const input: ModelGatewayInput = {
        baseUrl: trimmedBase,
        apiKey: effectiveKey,
        modelId: trimmedModel,
      };

      // PRD：合法即存（保存门 = 合法性门），保存不探测——落库后恒「未测试」，
      // 点状态文字才重测。
      if (mode === 'create') {
        const id = await add(input);
        toast.success(t('settings.providers.modelDialog.addedToast', { model: trimmedModel }));
        onSaved(id);
      } else {
        await update(editId!, input);
        toast.success(t('settings.providers.modelDialog.savedToast', { model: trimmedModel }));
        onSaved(editId!);
      }
      onClose();
    } catch (error) {
      setSaveError({
        label: t('settings.providers.modelDialog.saveFailed'),
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
    entries,
    initial?.apiKey,
    mode,
    modelId,
    onClose,
    onSaved,
    t,
    update,
  ]);

  // 编辑流钉在稳定句柄上（update 钉在它上）；缺了是调用方编程错误，
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
      {/* 遮罩（PRD 2026-11-01 分层）：clean 点空白关；dirty 不关、面板 shake 提示。
          保存中不响应，避免误触丢掉已填内容。 */}
      <div className="modal-scrim absolute inset-0" onClick={handleScrimClick} />

      <div
        ref={panelRef}
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
            error={visibleErrors.baseUrl}
            reserveFeedback
          >
            {(control) => (
              <Input
                {...control}
                value={baseUrl}
                onChange={setBaseUrl}
                onBlur={() => setTouched((prev) => ({ ...prev, baseUrl: true }))}
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
              error={visibleErrors.apiKey}
              reserveFeedback
            >
              {(control) => (
                <Input
                  {...control}
                  secret
                  mono
                  value={apiKey}
                  onChange={(v) => {
                    setApiKey(v);
                    setKeyMissing(false);
                  }}
                  onBlur={() => setTouched((prev) => ({ ...prev, apiKey: true }))}
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
              // PRD：帮助文案只在未出错时显示，错误出现即取代它。
              hint={visibleErrors.modelId ? undefined : t('settings.providers.modelDialog.modelHint')}
              error={visibleErrors.modelId}
              reserveFeedback
            >
              {(control) => (
                <Input
                  {...control}
                  value={modelId}
                  onChange={setModelId}
                  onBlur={() => setTouched((prev) => ({ ...prev, modelId: true }))}
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
            disabled={!canSave}
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
