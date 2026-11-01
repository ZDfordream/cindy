/**
 * ModelGatewayForm — 添加 / 编辑模型的三栏弹窗（设计稿 §5.2 / PRD 2026-11-01）。
 *
 * 三栏固定顺序：**接口地址 → 密钥 → 模型**；没有删除按钮（删除在列表行上）；
 * 协议写死 `anthropic-messages`（表单不出协议选项，store 内固定）。
 *
 * 保存门 = **合法性门**：URL `^https?:\/\/\S+$`、密钥非空、模型非空且不与其它条目
 * modelId 重复，三项零错「保存」才可点。默认（设置面）**合法即存、保存不探测**：
 * 点了就 `add`/`update` 落库并关窗，落库后条目恒「未测试」（连通性由列表行「重测」
 * 负责，不拦保存）。`probeOnSave`（S3 / 首页弹窗，Ruling 9）时点击后先真实探测、
 * 通了才落库，探测不过 / 超时零落库——两 PRD「保存是否探测」的分流口径见该 prop
 * 注释与 CHANGES.md §6 挂账。写盘失败弹窗内显示失败原因（Ruling 11：主文案是人话
 * 标签，原始 detail 只进 tooltip / 次要行——它可能是 `AUTH_INVALID` 这类机器码）。
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
 * 任何状态都关——「任何状态」指**非保存在途**：`busyRef` 门闩挡住的是保存中的关闭，
 * 这是有意的（防丢落库半截），不是对 PRD「任何状态可关」的偏离。Esc 用 capture +
 * stopPropagation 抢占（Ruling 16 同批修复）：一次按键只关本弹窗，不级联触发
 * `useSettingsEscape` 再退一层设置。这些关闭路径按 `origin` 分流出出口（S3 合同）：
 * `onboarding` = 跳过（回 `onSkipped`），`home`（默认）= 关闭（回 `onClose`）；
 * 落库成功不受影响，仍走 `onSaved` + `onClose`。
 *
 * 保存成功 toast（PRD）：新建「已添加 {model}」/ 编辑「已保存 {model}」。
 *
 * ⚠️ 有意偏离 DESIGN.md（沿用 `AddModelDialog.tsx` 既有偏离登记 / 设计稿 §7，
 * 不新增）：
 *   1. §4「有 Cancel 的对话框不带右上角 ×」——参考图 × 与「取消」并存；
 *   2. §4「单行输入框用 9999px 胶囊圆角」——PRD 2026-11-01 是 14px 圆角矩形
 *      （按钮同款处理；已登记为 DESIGN.md §5「HRBuddy PRD-family frames」成员
 *      `hrbuddy-model-dialog-panel` / `hrbuddy-prd-control`，CHANGES.md §9.4 同族）。
 * 弹窗壳复用 ConfirmDialog 的结构（DESIGN.md §4：标题 / 滚动内容区 / 底部按钮 +
 * 共享 `.modal-scrim` / `.modal-panel` 类）；校验 / 错误呈现与遮罩 dirty 抖动
 * （PRD，`shake` 类挂 `.modal-panel`，globals.css）不走 `ConfirmDialog` 组件本体。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { readCustomProviderKey } from '@/lib/customProviders';
import { trackHrOaEvent, type HrOaModelDialogOrigin } from '@/lib/hrOaTelemetry';
import { toast } from '@/lib/toast';

import { testModelConnectivity, type ModelConnectivityResult } from './useModelConnectivity';
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
  /**
   * 弹窗来源（S3 合同，login-onboarding Task 5）：`onboarding` = 首登引导（可跳过），
   * 显示「跳过，稍后配置」文字按钮 + 底部提示；`home`（默认，既有调用方不受影响）=
   * 首页补配 / 更多 → 自定义，无跳过 affordance。只分流「跳过 vs 关闭」出口与这两处
   * 显隐，校验 / 落库 / 遮罩 dirty 抖动 / 保存锁一概不随 origin 变。
   */
  origin?: 'onboarding' | 'home';
  /**
   * 保存时真实连通性检测（Ruling 9，login-onboarding PRD FR-MODEL-05 / §7 保存结果）：
   * `true` 时保存 = 探测（「检测连接中…」+ 输入只读）→ 通了才落库 → ✓「已保存」保持
   * 450ms 交棒；探测不过 / 10s 超时出失败条 + 抖动、**零落库**（OQ-6 不允许「仍然
   * 保存」）。`false`（默认）= 设置 → 模型面的「合法即存、保存不探测、存后未测试」
   * （model-provider-settings PRD 的 R14 推翻口径），**不许随本 prop 漂移**——两 PRD
   * 在「保存是否探测」上冲突，按表面分流执行，冲突本身登记在 CHANGES.md §6 待 owner
   * 统一。仅 `OnboardingModelDialog`（S3 / 首页补配，两 origin）打开它。
   */
  probeOnSave?: boolean;
  onClose: () => void;
  /**
   * `origin='onboarding'` 的跳过出口：× / 取消 / Esc / **无输入**点遮罩 = 跳过走它
   * （不再回 `onClose`，宿主才能把「跳过」与「关闭」分开处理）；缺省回落 `onClose`。
   * `origin='home'` 不触发。落库成功仍走既有收尾 `onSaved` + `onClose`。
   */
  onSkipped?: () => void;
  /** 落库成功后回传条目稳定 id（create = 新句柄，edit = 原句柄）。 */
  onSaved: (id: string) => void;
  /**
   * 埋点 origin 维度（PRD §10.2）：打开入口的六值枚举，**只在 onboarding 家族
   * （S3 / 首页补配 / 侧栏自定义）传**——设置 → 模型面的添加/编辑弹窗不传，
   * `model_*` 事件不发（那条面属 model-provider-settings PRD，不在这 14 事件漏斗里）。
   * 与 `origin`（行为分流：onboarding | home）不是一层：同为 home 的两次打开，
   * banner 进来记 home_banner、侧栏「自定义」记 sidebar_custom。
   */
  trackOrigin?: HrOaModelDialogOrigin;
}

/** PRD 2026-11-01 的 14px 圆角矩形（偏离登记：PRD 版式覆盖旧 10px 参考图条目）；其余 Input 样式走 DS 默认。 */
const FIELD_INPUT_CLASS = '!rounded-[14px]';

interface FormFieldErrors {
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
}

/** 表单字段键（与 FormFieldErrors 同域）；PRD §10.2 的 `field` 维度另用 PRD 名。 */
type ModelDialogFieldKey = 'baseUrl' | 'apiKey' | 'modelId';

/** PRD §10.2 `model_field_error.error_type` 枚举。 */
type ModelFieldErrorKind = 'empty' | 'format' | 'duplicate';

/** 表单字段键 → PRD `field` 维度值（url | key | model）。 */
const FIELD_PRD_NAME: Record<ModelDialogFieldKey, 'url' | 'key' | 'model'> = {
  baseUrl: 'url',
  apiKey: 'key',
  modelId: 'model',
};

/** Ruling 9：探测超时（不回包按超时出独立失败条，不空等用户）。 */
const PROBE_TIMEOUT_MS = 10_000;
/** Ruling 9：检测成功后按钮 ✓「已保存」的保持时长，到点才交棒 `onSaved`。 */
const SAVED_FLASH_MS = 450;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 给连通性探测加超时护栏：10s 不回包收敛成 `'timeout'`（超时条独立文案）；
 * 探测原语 `testModelConnectivity` 自身永不 reject（失败也以 `{ok:false}` 回），
 * 这里只裁决「到点还没回」，先回包的一侧作废另一侧。
 */
async function withProbeTimeout(
  probe: Promise<ModelConnectivityResult>,
): Promise<ModelConnectivityResult | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), PROBE_TIMEOUT_MS);
    void probe.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

/**
 * PRD `validate()`：三项合法性 + 模型 ID 重复拦截。零错 = 保存可点。
 * URL 按 PRD 脚本的 `^https?:\/\/\S+$` 判格式；格式过后按 **Ruling 27** 追加拒
 * userinfo——`new URL()` 解析出的 `username`/`password` 非空即拒（`https://user:
 * pass@host` 这类不放行）：baseUrl 会原样写进 `~/.hrbuddy/models.json`，那是
 * 「凭证绝不落盘」红线文件，basic-auth 密码不能进去。判 userinfo 只认 URL 解析
 * 结果，path / query 里的 `@` 不算；解析抛错时按**既有格式错**拒收（Ruling 28：
 * 不空转放行，堵 `user:pass@host:99999` 这类解析失败的 userinfo 旁路）。重复判定
 * 排除 `editId` 自身——编辑回填自身 modelId 不算重复。
 */
function validateFields(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  mode: 'create' | 'edit',
  entries: ModelEntry[],
  editId: string | undefined,
  t: (key: string) => string,
): {
  errors: FormFieldErrors;
  kinds: Partial<Record<ModelDialogFieldKey, ModelFieldErrorKind>>;
} {
  const errors: FormFieldErrors = {};
  const kinds: Partial<Record<ModelDialogFieldKey, ModelFieldErrorKind>> = {};
  const trimmedBase = baseUrl.trim();
  const trimmedKey = apiKey.trim();
  const trimmedModel = modelId.trim();
  if (!trimmedBase) {
    errors.baseUrl = t('settings.providers.modelDialog.baseUrlRequired');
    kinds.baseUrl = 'empty';
  } else if (!/^https?:\/\/\S+$/i.test(trimmedBase)) {
    errors.baseUrl = t('settings.providers.modelDialog.baseUrlInvalid');
    kinds.baseUrl = 'format';
  } else {
    // Ruling 27：格式过后的 userinfo 闸门（判据 = URL 解析结果，非字符串包含）。
    try {
      const parsed = new URL(trimmedBase);
      if (parsed.username || parsed.password) {
        errors.baseUrl = t('settings.providers.modelDialog.urlNoCredentials');
        // PRD error_type 无「凭证」档：Ruling 27 闸门按 format 收口（拒绝的是非法形态 URL）。
        kinds.baseUrl = 'format';
      }
    } catch {
      // Ruling 28：解析失败不空转放行——拿不到解析结果就无法证明没有 userinfo，
      // 按既有格式错拒收（`https://user:pass@host:99999` 这类复合畸形不再绕过
      // 凭证红线，不新增文案 key）；合法 URL 解析必成，行为零变化。
      errors.baseUrl = t('settings.providers.modelDialog.baseUrlInvalid');
      kinds.baseUrl = 'format';
    }
  }
  // 创建必填；编辑留空 = 沿用已存密钥（不回显红线下的「key 非空」等价语义）。
  if (mode === 'create' && !trimmedKey) {
    errors.apiKey = t('settings.providers.modelDialog.apiKeyRequired');
    kinds.apiKey = 'empty';
  }
  if (!trimmedModel) {
    errors.modelId = t('settings.providers.modelDialog.modelIdRequired');
    kinds.modelId = 'empty';
  } else if (entries.some((entry) => entry.modelId === trimmedModel && entry.id !== editId)) {
    errors.modelId = t('settings.providers.modelDialog.modelIdDuplicate');
    kinds.modelId = 'duplicate';
  }
  return { errors, kinds };
}

export function ModelGatewayForm({
  open,
  mode,
  initial,
  origin = 'home',
  probeOnSave = false,
  onClose,
  onSkipped,
  onSaved,
  trackOrigin,
}: ModelGatewayFormProps) {
  const { t } = useTranslation();
  const uid = useId();
  const { add, update, entries } = useModelGateway();

  const editId = initial?.id;
  // S3 分流：onboarding 的关闭路径 = 跳过（onSkipped 缺省回落 onClose 保持可关）。
  const skipExit = origin === 'onboarding' ? (onSkipped ?? onClose) : null;

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
  const [saveError, setSaveError] = useState<{ label: string; detail?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // Ruling 9：检测成功后的 ✓「已保存」保持拍（按钮三态：保存 → 检测连接中… → 已保存）。
  const [justSaved, setJustSaved] = useState(false);
  // 同步重复提交门闩（DS-6：请求期间表单自己挡住二次提交）。
  const busyRef = useRef(false);
  // 打开时的三栏初值：遮罩 dirty 判定（相对初值被改动）钉在它上。
  const initialRef = useRef({ baseUrl: '', apiKey: '', modelId: '' });
  // shake 是命令式类名增删（PRD 重启动画），className 必须保持常量不被 React 改写。
  const panelRef = useRef<HTMLDivElement | null>(null);

  /** dirty = 任一字段相对初值被改动（PRD 遮罩分层 / model_dialog_skip.had_input 的判据）。 */
  const isDirty = () =>
    baseUrl.trim() !== initialRef.current.baseUrl ||
    apiKey.trim() !== initialRef.current.apiKey ||
    modelId.trim() !== initialRef.current.modelId;

  // 关闭请求的唯一出口（×/取消/Esc/无输入遮罩共用）：保存在途一律不响应；
  // onboarding 走跳过出口，home 走 onClose。
  // 埋点（PRD §10.2 model_dialog_skip）：非保存的弹窗结束都在此收口——method
  // 区分关闭方式、had_input 记本次会话是否动过输入。保存成功走 onSaved+onClose
  // 收尾，不经过这里，不发 skip。
  const requestDismiss = useCallback(
    (method: 'close_x' | 'skip_button' | 'cancel' | 'esc' | 'mask') => {
      if (busyRef.current) return;
      if (trackOrigin) {
        trackHrOaEvent('model_dialog_skip', {
          origin: trackOrigin,
          method,
          had_input: isDirty(),
        });
      }
      if (skipExit) skipExit();
      else onClose();
    },
    [trackOrigin, skipExit, onClose, isDirty],
  );

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
    setJustSaved(false);
    busyRef.current = false;
  }, [open, mode, initial?.baseUrl, initial?.modelId]);

  // Ruling 16：关闭即清密钥。组件常驻挂载（关窗只换 open），键入过的 key 不留到
  // 下次打开；卸载随组件销毁。密钥生命周期以此为唯一来源。
  useEffect(() => {
    if (!open) setApiKey('');
  }, [open]);

  // 埋点（PRD §10.2）：添加模型弹窗曝光 = model_dialog_view。trackOrigin 缺省
  // （设置 → 模型面）不发；按 open 翻转计次（常驻挂载、关窗只换 open）。
  useEffect(() => {
    if (!open || !trackOrigin) return;
    trackHrOaEvent('model_dialog_view', { origin: trackOrigin });
  }, [open, trackOrigin]);

  // Esc 关闭（保存中只吞按键不关窗）。capture + preventDefault + stopPropagation
  // 抢占 useSettingsEscape（window 冒泡注册、关闭路径不看 defaultPrevented）：
  // 一次 Esc 只关本弹窗，绝不级联再退一层设置——照 ProviderConnectionDialog 同款。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      requestDismiss('esc');
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, requestDismiss]);

  // 合法性门（PRD）：零错才可保存；keyMissing 是保存时才判出的密钥缺口。
  const { errors: fieldErrors, kinds: fieldKinds } = validateFields(
    baseUrl,
    apiKey,
    modelId,
    mode,
    entries,
    editId,
    (key) => t(key),
  );
  const canSave =
    Object.keys(fieldErrors).length === 0 && !keyMissing && !saving;
  const visibleErrors: FormFieldErrors = {
    baseUrl: touched.baseUrl ? fieldErrors.baseUrl : undefined,
    apiKey:
      (touched.apiKey ? fieldErrors.apiKey : undefined) ??
      (keyMissing ? t('settings.providers.modelDialog.apiKeyRequired') : undefined),
    modelId: touched.modelId ? fieldErrors.modelId : undefined,
  };

  // 失焦 = 校验落地（PRD AC-07 失焦显错）：置 touched + 有错即发 model_field_error
  // （kind 取本次渲染的校验结果；合法字段不发）。trackOrigin 缺省整族 model_* 不发。
  const markTouched = (field: ModelDialogFieldKey) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
    const kind = fieldKinds[field];
    if (trackOrigin && kind) {
      trackHrOaEvent('model_field_error', { field: FIELD_PRD_NAME[field], error_type: kind });
    }
  };

  // PRD 同款重启动画：摘类 → 强制 reflow → 加类。面板类名表由 React 管、shake 由
  // 这里命令式增删——className 保持常量，React 重渲染不会盖掉它。
  const shakePanel = () => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.classList.remove('shake');
    void panel.offsetWidth;
    panel.classList.add('shake');
  };

  // 遮罩语义分层（PRD 2026-11-01）：dirty 不关只抖；clean 才关（onboarding = 跳过）。
  const handleScrimClick = () => {
    if (busyRef.current) return;
    if (isDirty()) shakePanel();
    else requestDismiss('mask');
  };

  const handleSave = useCallback(async () => {
    if (busyRef.current) return;
    // 保存 = submit（PRD）：touched 全开。保存钮禁用时走不到这里，这里是兜底。
    setTouched({ baseUrl: true, apiKey: true, modelId: true });
    // 埋点（PRD §10.2）：点击「保存」= model_save_submit。url_host 传原始接口地址，
    // emitter 侧收窄成 host（采集边界第二道闸；哨兵测试钉死）。trackOrigin 缺省
    // （设置 → 模型面）整族 model_* 事件不发（那条面不在本漏斗）。
    if (trackOrigin) {
      trackHrOaEvent('model_save_submit', {
        origin: trackOrigin,
        url_host: baseUrl,
        model_id: modelId.trim(),
      });
    }
    const { errors: currentErrors, kinds: currentKinds } = validateFields(
      baseUrl,
      apiKey,
      modelId,
      mode,
      entries,
      editId,
      (key) => t(key),
    );
    if (Object.keys(currentErrors).length > 0) {
      // 兜底校验出错（竞态改表等）：补发 model_field_error（正常路径在失焦处发）。
      if (trackOrigin) {
        for (const [field, kind] of Object.entries(currentKinds)) {
          trackHrOaEvent('model_field_error', {
            field: FIELD_PRD_NAME[field as ModelDialogFieldKey],
            error_type: kind,
          });
        }
      }
      return;
    }

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
        // 埋点：「未填密钥」按 PRD 空值档收口（error_type 无独立「读不到」档）。
        if (trackOrigin) {
          trackHrOaEvent('model_field_error', { field: 'key', error_type: 'empty' });
        }
        return;
      }

      const input: ModelGatewayInput = {
        baseUrl: trimmedBase,
        apiKey: effectiveKey,
        modelId: trimmedModel,
      };

      // Ruling 9（probeOnSave）：S3 / 首页弹窗保存 = 真实连通性检测，探测不过**零落库**
      // （OQ-6：不允许「仍然保存」），10s 不回包按超时。设置页（不传 probeOnSave）保持
      // 「合法即存、保存不探测、存后未测试」（model-provider-settings PRD R14 推翻口径）。
      if (probeOnSave) {
        const probeStartedAt = Date.now();
        const probe = await withProbeTimeout(testModelConnectivity(input));
        // 埋点（PRD §10.2）：model_save_result = 连通性检测返回（触发点就是探测回包，
        // 不是落库结果——探测成功后磁盘落库失败的稀有路径不改写本事件）。
        if (trackOrigin) {
          trackHrOaEvent('model_save_result', {
            origin: trackOrigin,
            result: probe === 'timeout' ? 'timeout' : probe.ok ? 'success' : 'fail',
            duration_ms: Date.now() - probeStartedAt,
          });
        }
        if (probe === 'timeout') {
          setSaveError({ label: t('settings.providers.modelDialog.probeTimeout') });
          shakePanel();
          return;
        }
        if (!probe.ok) {
          // Finding 3 key 分流：探测失败 = 连接失败条（probeFailed）；落盘失败走
          // `saveFailed`（保存失败）——磁盘错不得说成「连接失败，请检查接口地址…」。
          setSaveError({
            label: t('settings.providers.modelDialog.probeFailed'),
            detail: probe.detail,
          });
          shakePanel();
          return;
        }
      }

      // PRD（设置面）：合法即存（保存门 = 合法性门），保存不探测——落库后恒「未测试」，
      // 点状态文字才重测。probeOnSave 路径已在上方真实探测，这里复用同一落库。
      let savedId: string;
      if (mode === 'create') {
        savedId = await add(input);
        if (!probeOnSave) {
          toast.success(t('settings.providers.modelDialog.addedToast', { model: trimmedModel }));
        }
      } else {
        await update(editId!, input);
        if (!probeOnSave) {
          toast.success(t('settings.providers.modelDialog.savedToast', { model: trimmedModel }));
        }
        savedId = editId!;
      }
      if (probeOnSave) {
        // Ruling 9 保存结果：按钮 ✓「已保存」保持 450ms 再交棒（成功反馈在按钮态，
        // 不再叠加 toast）。
        setJustSaved(true);
        await delay(SAVED_FLASH_MS);
      }
      onSaved(savedId);
      onClose();
    } catch (error) {
      setSaveError({
        label: t('settings.providers.modelDialog.saveFailed'),
        detail: error instanceof Error ? error.message : String(error),
      });
      // 失败抖动是 S3（probeOnSave）合同：输入原样保留，可改后直接重试。设置面
      // （无 probeOnSave）沿用旧「只出失败条、不抖」（Ruling 9 评审 Finding 1）。
      if (probeOnSave) shakePanel();
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
    probeOnSave,
    t,
    trackOrigin,
    update,
  ]);

  // 编辑流钉在稳定句柄上（update 钉在它上）；缺了是调用方编程错误，
  // 放在 hooks 之后抛（抛出前不得改变 hook 调用次数）。
  if (open && mode === 'edit' && !editId) {
    throw new Error("ModelGatewayForm: mode='edit' requires initial.id");
  }

  if (!open) return null;

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
        className="modal-panel !rounded-[22px] relative flex max-h-[min(680px,90vh)] w-full flex-col"
        style={{ maxWidth: 'min(460px, 100vw - 32px)' }}
      >
        {/* 标题栏：× 与「取消」并存（偏离登记 1）。
            面板 22px 圆角 = DESIGN.md §5 `hrbuddy-model-dialog-panel`（PRD 2026-11-01
            版式；2026-11-01 起已登记，覆盖共享 modal-panel 的 12px）。 */}
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
            onClick={() => requestDismiss('close_x')}
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
                readOnly={probeOnSave && saving}
                onChange={(v) => {
                  setBaseUrl(v);
                  // FR-MODEL-08（Ruling 9 重申）：失败条在任意字段再次输入后消失——
                  // 仅 probeOnSave（S3）弹窗；设置面保持旧「留到下次保存 / 重开」
                  // （Ruling 9 评审 Finding 2）。
                  if (probeOnSave) setSaveError(null);
                }}
                onBlur={() => markTouched('baseUrl')}
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
                  readOnly={probeOnSave && saving}
                  onChange={(v) => {
                    setApiKey(v);
                    setKeyMissing(false);
                    // FR-MODEL-08：失败条在任意字段再次输入后消失（仅 probeOnSave）。
                    if (probeOnSave) setSaveError(null);
                  }}
                  onBlur={() => markTouched('apiKey')}
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
                  readOnly={probeOnSave && saving}
                  onChange={(v) => {
                    setModelId(v);
                    // FR-MODEL-08：失败条在任意字段再次输入后消失（仅 probeOnSave）。
                    if (probeOnSave) setSaveError(null);
                  }}
                  onBlur={() => markTouched('modelId')}
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
              className="mt-1 rounded-xl border border-[var(--error-border)] px-3 py-2"
            >
              {/* Ruling 11：主文案人话标签；原始 detail（可能是机器码）只在次要行
                  （超时这类没有机器 detail 的失败只有主文案一行）。 */}
              <p className="text-13 text-[var(--error-fg)]">{saveError.label}</p>
              {saveError.detail ? (
                <p className="mt-1 text-12 text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                  {saveError.detail}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div
          className={`flex items-center justify-end gap-3 px-6 pt-3 ${origin === 'onboarding' ? 'pb-2' : 'pb-5'}`}
        >
          {origin === 'onboarding' ? (
            /* 「跳过，稍后配置」文字按钮（S3 合同）：非提交动作，左侧安置（DESIGN.md §4
               向导「← 上一步」同款位置口径——非提交动作不得挤进右侧药丸组）；静音档
               文字按钮（tone=quiet 静止无底、`--text-secondary`），保存锁定期禁用。
               圆角 14px = §5 `hrbuddy-prd-control`（S3 动作钮家族，hover 底同族几何）。 */
            <Button
              variant="secondary"
              tone="quiet"
              size="lg"
              type="button"
              disabled={saving}
              onClick={() => requestDismiss('skip_button')}
              className="mr-auto !rounded-[14px] px-4"
            >
              {t('settings.providers.modelDialog.skip')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="lg"
            type="button"
            disabled={saving}
            onClick={() => requestDismiss('cancel')}
            className="!rounded-[14px] px-6"
          >
            {t('settings.providers.custom.cancel')}
          </Button>
          {/* primary 深色填充（PRD `.btn.primary`）：palette=confirmation 走
              confirm-btn-primary-bg（light 深 / dark 浅的反转实底），两模式同源。
              probeOnSave（Ruling 9）三态：保存 → 「检测连接中…」+转圈 → ✓「已保存」
              保持 450ms；不探测的设置面保持原「保存 + loading 转圈」。 */}
          <Button
            variant="primary"
            palette="confirmation"
            size="lg"
            type="button"
            disabled={!canSave}
            loading={saving && !probeOnSave}
            aria-busy={probeOnSave && saving ? true : undefined}
            onClick={() => void handleSave()}
            className="!rounded-[14px] px-6"
          >
            {probeOnSave && justSaved ? (
              <>
                <Check size={14} aria-hidden="true" />
                {t('settings.providers.modelDialog.saved')}
              </>
            ) : probeOnSave && saving ? (
              <>
                <Spinner size={14} />
                {t('settings.providers.modelDialog.probing')}
              </>
            ) : (
              t('settings.providers.custom.save')
            )}
          </Button>
        </div>
        {origin === 'onboarding' ? (
          /* 底部提示（S3 合同）：补充说明跳过后去哪配置，只在 onboarding 出。 */
          <p className="px-6 pb-5 text-12 text-[var(--text-tertiary)]">{t('settings.providers.modelDialog.skipHint')}</p>
        ) : null}
      </div>
    </div>
  );
}
