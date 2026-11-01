/**
 * telemetry.ts — HR OA 登录漏斗埋点（login-onboarding PRD §10）。
 *
 * 14 个事件（§10.2）从各 UI 触发点经 `trackHrOaEvent(name, props)` 发出；本模块负责
 * 组装**通用属性**（§10.1：app_version / os_version / session_id / account_hash / ts）、
 * 按事件白名单裁剪属性、执行**采集边界**脱敏，再交给可替换 sink。
 *
 * 采集边界（PRD §10.1 / S-1 安全红线，test 用哨兵密钥钉死）：
 *   - 口令、API Key、token 等秘密键**直接丢弃**（键名命中即弃，值不看）；
 *   - 明文账号只以 `account_hash`（SHA-256 前 8 位 hex）出现，`account` 输入键被消费后
 *     **不再外发**；
 *   - 接口地址只以 `url_host`（URL 的 host 段，含端口、不含 userinfo/path/query）出现——
 *     调用方误传完整 URL（或带凭证 URL）时在本模块收窄，不靠调用点自觉。
 *
 * sink 可替换（`registerHrOaTelemetrySink`）：默认落**结构化日志**（logger 侧带
 * `hr-oa.telemetry` scope），暂不接第三方统计后端——HRBuddy 部署形态（内网、
 * SHOW_CINDY_ACCOUNT_UI 收起的独立安装）没有可用的既有上报通道，正式后端接入时
 * 只换 sink 注册，不动 14 个调用点。注册 `null` 回落默认日志 sink。
 *
 * 本模块无 electron 依赖（app/os 版本经 `setHrOaTelemetryContext` 注入），main 侧
 * bootstrap 初始化上下文；renderer 侧的 14 个触发点走 `hrOa.trackEvent` 桥（IPC）调进来。
 */

import { createHash } from 'node:crypto';

import { type HrOaEventName } from '../../shared/hrOaTelemetry.js';
import { createLogger } from '../logger.js';

// 联合类型合同在 shared（renderer 侧触发点也要用，不得从 renderer import main）；
// 此处 re-export 保持 main 既有导入路径（telemetry.js 出口）稳定。
export type { HrOaEventName, HrOaModelDialogOrigin } from '../../shared/hrOaTelemetry.js';

export interface HrOaEventPayload {
  name: HrOaEventName;
  /** 事件属性 + 通用属性（§10.1），已过白名单与脱敏。 */
  properties: Record<string, unknown>;
}

export type HrOaTelemetrySink = (payload: HrOaEventPayload) => void;

/**
 * 每个事件的**属性白名单**（PRD §10.2 表）：只放行列内列出的事件属性键。
 * 通用属性由 `trackHrOaEvent` 统一追加，不进白名单。白名单外的键一律丢弃——
 * 采集边界的第二道闸（第一道是 `account`/`url_host` 的收窄转换）。
 */
export const HR_OA_EVENT_PROPS: Record<HrOaEventName, readonly string[]> = {
  welcome_view: ['from'],
  login_click: [],
  login_view: [],
  login_submit: ['account_type'],
  login_result: ['result', 'duration_ms', 'attempt_no'],
  model_dialog_view: ['origin'],
  model_field_error: ['field', 'error_type'],
  model_save_submit: ['origin', 'url_host', 'model_id'],
  model_save_result: ['origin', 'result', 'duration_ms'],
  model_dialog_skip: ['origin', 'method', 'had_input'],
  home_view: ['model_state', 'entry'],
  home_gate_trigger: ['trigger'],
  message_send: ['model_state', 'source', 'is_first_message'],
  logout: ['reason'],
};

/** 通用属性键（§10.1）：每个事件载荷都必须带齐。 */
export const HR_OA_COMMON_PROPS = ['app_version', 'os_version', 'session_id', 'account_hash', 'ts'];

interface HrOaTelemetryContext {
  appVersion: string;
  osVersion: string;
  sessionId: string;
  /** 当前登录账号（明文）；只为算 account_hash，绝不外发。null = 未登录。 */
  account: string | null;
}

let context: HrOaTelemetryContext = {
  appVersion: '',
  osVersion: '',
  sessionId: '',
  account: null,
};

const log = createLogger('hr-oa.telemetry');

/** 默认 sink：结构化日志（一行 JSON），后续接正式后端时由注册点替换。 */
const defaultSink: HrOaTelemetrySink = (payload) => {
  log.info('event', JSON.stringify(payload));
};

let sink: HrOaTelemetrySink = defaultSink;

/**
 * 注册埋点出口。传 `null` 回落默认结构化日志 sink；返回反注册函数（恢复注册前的出口）。
 * 供正式统计后端接入与测试捕获用——调用点只依赖 `trackHrOaEvent`，不感知出口。
 */
export function registerHrOaTelemetrySink(next: HrOaTelemetrySink | null): () => void {
  const previous = sink;
  sink = next ?? defaultSink;
  return () => {
    sink = previous;
  };
}

/** bootstrap 初始化 / 登录态变化时更新；只进哈希与通用属性，不落任何外发载荷。 */
export function setHrOaTelemetryContext(patch: Partial<HrOaTelemetryContext>): void {
  context = {
    ...context,
    ...('appVersion' in patch ? { appVersion: patch.appVersion ?? '' } : {}),
    ...('osVersion' in patch ? { osVersion: patch.osVersion ?? '' } : {}),
    ...('sessionId' in patch ? { sessionId: patch.sessionId ?? '' } : {}),
    ...('account' in patch ? { account: patch.account ?? null } : {}),
  };
}

/** account_hash = SHA-256(账号) 前 8 位 hex（PRD §10.1）。 */
export function hashHrAccount(account: string): string {
  return createHash('sha256').update(account, 'utf8').digest('hex').slice(0, 8);
}

/**
 * 把任意接口地址收窄成 host（含端口）：
 *   `https://user:pass@host:9443/path?key=x` → `host:9443`；裸 `host:port` 原样。
 * 解析不了的值回 `undefined`（宁缺勿泄）。
 */
function toUrlHost(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).host;
  } catch {
    // 裸 host[:port]（无 scheme 的 host 无法进 URL 解析）——只放行 host 形态字符。
    return /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(trimmed) ? trimmed : undefined;
  }
}

/**
 * 发一个埋点事件。属性组装顺序：白名单裁剪 → `account`/`url_host` 收窄 → 通用属性。
 * 未知事件名静默丢弃（埋点绝不抛错、绝不阻塞业务）。
 */
export function trackHrOaEvent(name: string, props: Record<string, unknown>): void {
  try {
    const allow = HR_OA_EVENT_PROPS[name as HrOaEventName];
    if (!allow) return;

    const properties: Record<string, unknown> = {};
    for (const key of allow) {
      const value = props[key];
      if (value === undefined) continue;
      if (key === 'url_host') {
        const host = toUrlHost(value);
        if (host !== undefined) properties[key] = host;
        continue;
      }
      properties[key] = value;
    }

    // 明文账号只进哈希：调用方经 `account` 传入（如登录提交时会话尚未落定），
    // 优先于上下文；两者都无则 account_hash 为空串（事件仍发，键仍在）。
    const account = typeof props.account === 'string' ? props.account : context.account;
    properties.account_hash = account ? hashHrAccount(account) : '';
    properties.app_version = context.appVersion;
    properties.os_version = context.osVersion;
    properties.session_id = context.sessionId;
    properties.ts = Date.now();

    sink({ name: name as HrOaEventName, properties });
  } catch {
    // 埋点失败静默：不得影响业务路径。
  }
}
