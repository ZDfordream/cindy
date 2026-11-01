/**
 * errors.ts — HR OA 门户登录失败的类别与错误类型。
 *
 * 失败种类是封闭集合（Task 2 的失败分流表按此分流凭证去留）：凭证类
 * （wrong_credentials / locked）才允许清钥匙串；网络类（network_error / timeout）
 * 必须保留凭证。会话恢复失败复用 network_error（不新增种类）。
 */

export type OaLoginFailure = 'wrong_credentials' | 'locked' | 'network_error' | 'timeout';

/**
 * 登录/会话恢复的抛错形态。消息为固定文案或已脱敏文本，绝不含口令明文。
 */
export class OaLoginError extends Error {
  readonly kind: OaLoginFailure;

  constructor(kind: OaLoginFailure, message?: string) {
    super(message ?? `OA login failed: ${kind}`);
    this.name = 'OaLoginError';
    this.kind = kind;
  }
}

export type OaLoginOutcome = { ok: true } | { ok: false; kind: OaLoginFailure };
