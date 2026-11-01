/**
 * hrOaTelemetry — HR OA 登录漏斗埋点的**跨进程类型合同**（login-onboarding PRD §10）。
 *
 * 只放 main（组装/脱敏/sink）与 renderer（触发点）都要用的纯类型：
 * - `HrOaEventName`：PRD §10.2 的 14 个事件名（`main/hr-oa/telemetry.ts` 的
 *   `HR_OA_EVENT_PROPS` 白名单以它为键域；renderer 触发点以它收窄事件名）。
 * - `HrOaModelDialogOrigin`：`model_*` 事件的 `origin` 维度六值枚举。
 *
 * 放 shared 的原因：renderer 不得 import main（进程边界；`hrOaTelemetry` 的 renderer
 * 转发器与 `ModelGatewayForm` 等触发点都要用这两个联合类型）。main 侧
 * `main/hr-oa/telemetry.ts` re-export 本文件类型，保持既有导入路径稳定。
 */

/** PRD §10.2 的 14 个事件名。 */
export type HrOaEventName =
  | 'welcome_view'
  | 'login_click'
  | 'login_view'
  | 'login_submit'
  | 'login_result'
  | 'model_dialog_view'
  | 'model_field_error'
  | 'model_save_submit'
  | 'model_save_result'
  | 'model_dialog_skip'
  | 'home_view'
  | 'home_gate_trigger'
  | 'message_send'
  | 'logout';

/**
 * `model_*` 事件的 `origin` 维度（PRD §10.2）：S3 引导 / 首页四个补配入口 /
 * 侧栏「更多 → 自定义」。与弹窗自身的 `origin`（onboarding | home）不是一层：
 * 这里记录的是**打开入口**，home 四值对应 `HomeGateTrigger` 的映射
 * （banner→home_banner、selector→home_selector、suggestion→home_suggestion、
 * send→home_send、customize→sidebar_custom）。
 */
export type HrOaModelDialogOrigin =
  | 'onboarding'
  | 'home_banner'
  | 'home_selector'
  | 'home_suggestion'
  | 'home_send'
  | 'sidebar_custom';
