/**
 * 腾讯 SkillHub 来源的错误分类。
 *
 * message 是给红字「加载失败：…」直接显示的中文原因（方案 §7.1 文案表）；`code`
 * 是稳定错误码，skillhubIpcError 与 agentTools 用 isTencentSkillhubError 识别它。
 *
 * 不继承 ServerApiError：那是 Cindy 服务端协议的错误类型，大量单测会整体 mock
 * serverApiClient，继承会让这些测试在模块加载期失败。
 */

export type TencentErrorKind =
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'WAF_BLOCKED'
  | 'BAD_RESPONSE'
  | 'CIRCUIT_OPEN'
  | 'DISABLED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'URL_POLICY'
  | 'SUPERSEDED';

const MESSAGES: Record<TencentErrorKind, (status: number) => string> = {
  NETWORK_ERROR: () => '无法连接腾讯 SkillHub，请检查网络后重试',
  RATE_LIMITED: () => '请求过于频繁，请稍后再试',
  INTERNAL_ERROR: (status) => `腾讯 SkillHub 暂时不可用（HTTP ${status}）`,
  WAF_BLOCKED: () => '请求被安全策略拦截，请换个搜索词',
  BAD_RESPONSE: () => '返回的数据格式无法识别，请更新 HRBuddy',
  CIRCUIT_OPEN: () => '腾讯 SkillHub 连续失败，已暂停访问，稍后自动恢复',
  DISABLED: () => '腾讯 SkillHub 已暂时关闭',
  NOT_FOUND: () => '技能不存在或已下架',
  BAD_REQUEST: (status) => `腾讯 SkillHub 拒绝了请求（HTTP ${status}）`,
  URL_POLICY: () => '下载地址不在允许范围内，已拒绝',
  // 渲染层对被取代的搜索有 stale-guard，这条不会显示给用户。
  SUPERSEDED: () => '搜索已被新的输入取代',
};

/** Tencent adapter failure with a user-readable Chinese message and a stable code. */
export class TencentSkillhubError extends Error {
  /** 与 ServerApiError.code 同名同义，供错误码透传使用。 */
  public readonly code: TencentErrorKind;

  constructor(
    public readonly kind: TencentErrorKind,
    public readonly statusCode = 0,
    /** 只进日志的细节（如 x-request-id），不进红字。 */
    public readonly detail?: string,
    /** 有 Retry-After 时以它为准安排退避。 */
    public readonly retryAfterMs?: number,
  ) {
    super(MESSAGES[kind](statusCode));
    this.name = 'TencentSkillhubError';
    this.code = kind;
  }
}

export function isTencentSkillhubError(err: unknown): err is TencentSkillhubError {
  return err instanceof TencentSkillhubError;
}

/** 这些失败说明服务端或链路有问题，计入熔断与退避；4xx 业务错误不计入。 */
export function isTencentTransientFailure(err: unknown): boolean {
  if (!(err instanceof TencentSkillhubError)) return true;
  return ['NETWORK_ERROR', 'RATE_LIMITED', 'INTERNAL_ERROR', 'WAF_BLOCKED', 'BAD_RESPONSE'].includes(err.kind);
}
