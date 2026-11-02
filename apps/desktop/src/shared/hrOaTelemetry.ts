/**
 * hrOaTelemetry — HR OA 埋点的**跨进程类型合同**（login-onboarding PRD §10 +
 * profile-menu PRD §11）。
 *
 * 只放 main（组装/脱敏/sink）与 renderer（触发点）都要用的纯类型：
 * - `HrOaEventName`：PRD §10.2 的 14 个事件名 + profile-menu PRD §11 的 10 个新事件名
 *   （`main/hr-oa/telemetry.ts` 的 `HR_OA_EVENT_PROPS` 白名单以它为键域；renderer 触发点
 *   以它收窄事件名）。`logout` 两 PRD 共用（§11 为其增 `entry` 维度）。
 * - `HrOaModelDialogOrigin`：`model_*` 事件的 `origin` 维度六值枚举。
 *
 * 放 shared 的原因：renderer 不得 import main（进程边界；`hrOaTelemetry` 的 renderer
 * 转发器与 `ModelGatewayForm` 等触发点都要用这两个联合类型）。main 侧
 * `main/hr-oa/telemetry.ts` re-export 本文件类型，保持既有导入路径稳定。
 */

/**
 * 埋点事件名（login-onboarding §10.2 的 14 个 + profile-menu §11 的 10 个）。
 * 采集边界两 PRD 同一条红线：不采集姓名、工号/登录名、邮箱、手机号、头像地址、
 * `person_id` 明文、任何凭证值；不为图标提示埋点。
 */
export type HrOaEventName =
  // 登录与模型添加 PRD §10.2（14）
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
  | 'logout'
  // profile-menu PRD §11（10 新；logout 上面共用）
  | 'profile_fetch'
  | 'profile_avatar_error'
  | 'profile_menu_open'
  | 'profile_menu_click'
  | 'logout_confirm_view'
  | 'logout_confirm_result'
  | 'nav_click'
  | 'plugins_skills_tab'
  | 'token_refresh'
  | 'home_banner_click';

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
