/**
 * OnboardingModelDialog — S3 添加模型引导弹窗 / 首页补配入口（PRD 2026-11-01）。
 *
 * 复用 `ModelGatewayForm` 的三栏表单（字段、校验、Ruling 27/28、重复拦截、dirty 遮罩
 * 抖动、保存锁、keychain 密钥契约一概不动），只按 `origin` 分流「跳过 vs 关闭」两个
 * 出口与两处跳过 affordance（详见 `ModelGatewayFormProps.origin` / `onSkipped`）。
 *
 * 事件合同（宿主只依赖这三个回调，`open` 受控）：
 * - `origin='onboarding'`（S3，首登后）：显示「跳过，稍后配置」文字按钮 + 底部提示；
 *   × / 取消 / 跳过 / Esc / **无输入时**点遮罩 = 跳过 → **只**回 `onSkipped()`。
 * - `origin='home'`（更多 → 自定义 / 补配）：无跳过按钮、无底部提示；
 *   × / 取消 / Esc / 无输入点遮罩 = 关闭 → **只**回 `onClose()`（`onSkipped` 不触发）。
 * - 保存 = 真实连通性检测（Ruling 9，两 origin 同）：「检测连接中…」+ 输入只读 +
 *   关闭类动作禁用；检测成功 → 按钮 ✓「已保存」保持 450ms → `onSaved(id)`（随后沿用
 *   表单既有收尾再回 `onClose()`，宿主在 `onSaved` 关窗即可）；检测失败 / 10s 超时 →
 *   失败条 + 面板抖动 + 输入保留 + **零落库**（OQ-6 不允许「仍然保存」），三个回调
 *   都不触发。设置 → 模型面直接挂 `ModelGatewayForm`（不传 `probeOnSave`）保持
 *   「保存不探测」，两 PRD 冲突登记在 CHANGES.md §6 待 owner 统一。
 */
import { ModelGatewayForm } from './ModelGatewayForm';

export interface OnboardingModelDialogProps {
  open: boolean;
  /** 弹窗来源：`onboarding` = S3 首登引导（可跳过）；`home` = 首页补配 / 更多 → 自定义。 */
  origin: 'onboarding' | 'home';
  /** `origin='onboarding'` 的跳过出口（× / 取消 / 跳过 / Esc / 无输入遮罩）。 */
  onSkipped: () => void;
  /** 落库成功后回传新条目稳定 id。 */
  onSaved: (id: string) => void;
  /** `origin='home'` 的关闭出口（保存成功的收尾关闭两 origin 都会回调）。 */
  onClose: () => void;
}

export function OnboardingModelDialog({ open, origin, onSkipped, onSaved, onClose }: OnboardingModelDialogProps) {
  return (
    <ModelGatewayForm
      open={open}
      mode="create"
      origin={origin}
      probeOnSave
      onSkipped={onSkipped}
      onSaved={onSaved}
      onClose={onClose}
    />
  );
}
