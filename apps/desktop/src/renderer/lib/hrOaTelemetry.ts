/**
 * hrOaTelemetry.ts — HR OA 埋点的 renderer 侧转发器（login-onboarding PRD §10）。
 *
 * 事件**组装、属性白名单与采集边界脱敏**都在 main 的 `main/hr-oa/telemetry.ts`
 * `trackHrOaEvent` 一处收口（哨兵测试钉死：口令 / API Key / 明文账号 / 完整接口地址
 * 绝不进载荷）；这里只负责把触发事实送过桥，并提供首页到达的一次性记账：
 *
 * - `trackHrOaEvent(name, props)` → `window.electronAPI.hrOa.trackEvent`（fire-and-forget）。
 *   埋点绝不抛错、绝不阻塞业务：桥缺失（测试桩未装）时静默无操作。
 * - 首页曝光（`home_view`）的「到达原因」记账：到达与曝光之间隔着水合/弹窗落定
 *   （冷启动 arm→首页水合 flush；S3 结束则当场 fire），用 arm/flush 一次性账本
 *   保证一次到达只发一条、跨路由重挂载不重发。
 */
import type { HrOaEventName, HrOaModelDialogOrigin } from '../../shared/hrOaTelemetry';

export type { HrOaEventName, HrOaModelDialogOrigin };

export type HrOaHomeViewEntry = 'login' | 'launch' | 'skip' | 'save';

/**
 * 发一个埋点事件（PRD §10）。只送触发事实——属性键/值在这里不校验、不组装，
 * main 的 `trackHrOaEvent` 按事件白名单裁剪并脱敏。
 */
export function trackHrOaEvent(name: HrOaEventName, props: Record<string, unknown>): void {
  try {
    window.electronAPI?.hrOa?.trackEvent?.(name, props);
  } catch {
    // 埋点失败静默：不得影响业务路径。
  }
}

// ── home_view 到达账本 ────────────────────────────────────────────────────────
// 一次「到达首页」= 一条 home_view。到达原因（entry）在到达时刻记下，曝光落定
// （首页水合 + S3 不再悬挂）时消费；S3 结束 / 补配保存这类当场落定的场合直接
// arm+flush。模块级账本跨路由重挂载存活（ownerKey 变更会重建整棵路由树）。
let pendingHomeEntry: HrOaHomeViewEntry | null = null;

/** 记下一次首页到达的原因（重复调用以最后一次为准）。 */
export function noteHrOaHomeArrival(entry: HrOaHomeViewEntry): void {
  pendingHomeEntry = entry;
}

/**
 * 首页落定时消费一次到达账本：有账就发 `home_view`（model_state = 当前两态），
 * 无账（重导航 / 已发过）静默返回。arm/flush 分离的原因：登录与首页曝光之间
 * 隔着水合与 S3 决策，不能在 arm 处就发。
 */
export function flushHrOaHomeArrival(modelState: 'configured' | 'unconfigured'): void {
  if (pendingHomeEntry === null) return;
  const entry = pendingHomeEntry;
  pendingHomeEntry = null;
  trackHrOaEvent('home_view', { model_state: modelState, entry });
}

/** 测试 / 登出清理用：丢弃未消费的到达账。 */
export function clearHrOaHomeArrival(): void {
  pendingHomeEntry = null;
}

/** home 门禁触发 → `model_dialog_*` 的 origin 维度（PRD §10.2 六值枚举）。 */
export function modelDialogOriginForGateTrigger(
  trigger: 'send' | 'selector' | 'suggestion' | 'banner' | 'customize',
): HrOaModelDialogOrigin {
  switch (trigger) {
    case 'banner':
      return 'home_banner';
    case 'selector':
      return 'home_selector';
    case 'suggestion':
      return 'home_suggestion';
    case 'send':
      return 'home_send';
    case 'customize':
      return 'sidebar_custom';
  }
}

// ── message_send.source 记账 ─────────────────────────────────────────────────
// PRD §10.2：source = typed | suggestion。本实现里建议（推荐问题 / 插件建议）只
// **填入**输入框不直接发送（AC-11），所以「来源」按发出内容判定：发送时文本仍等于
// 最近一次建议填入的原文 → suggestion，否则 typed（用户改动过即视为手输）。
let lastSuggestionFill: string | null = null;

/** 建议填入输入框时记下原文（fillComposerWithSuggestion 调用）。 */
export function noteHrOaSuggestionFill(prompt: string): void {
  lastSuggestionFill = prompt;
}

/**
 * 发送时判定消息来源并清账：文本与最近一次建议填入一致（trim 后）→ suggestion，
 * 否则 typed。一次发送只判一次，判完即清。
 */
export function consumeHrOaMessageSource(text: string): 'typed' | 'suggestion' {
  const fill = lastSuggestionFill;
  lastSuggestionFill = null;
  return fill !== null && text.trim() === fill.trim() ? 'suggestion' : 'typed';
}
