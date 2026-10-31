/**
 * model-gateway —— 模型条目数据层的公共类型。
 *
 * 形状对齐设计稿 §6.1「模型条目」：`id` 是上游模型 id（原样发给网关），`name` 是展示名
 * （首版 = id 本身），协议恒 `anthropic-messages`（写死，不出现在条目里）。
 */

/** 连通状态：未测试 / 已连通（带延迟）/ 连不上（带原因）。 */
export type ModelStatus =
  | 'untested'
  | { ok: true; latencyMs: number }
  | { ok: false; detail: string };

/** 列表与聊天下拉消费的模型条目（不含密钥——凭证只走 keychain / safeStorage）。 */
export interface ModelEntry {
  /** 上游模型 id，原样发给网关。 */
  id: string;
  /** 展示名（首版 = id 本身）。 */
  name: string;
  baseUrl: string;
  /** 是否出现在聊天的模型菜单；关闭不丢配置。 */
  enabled: boolean;
  status: ModelStatus;
  lastTestedAt?: string;
}

/** 添加 / 编辑弹窗的三栏输入（接口地址 / 密钥 / 模型）。 */
export interface ModelGatewayInput {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

/** `useModelGateway()` 暴露的 store API。 */
export interface ModelGatewayApi {
  /** 按 `id` 字母升序排列的新表单条目（旧配置不出现）。 */
  entries: ModelEntry[];
  /** 新建条目并返回其 id（= 上游模型 id）。 */
  add(input: ModelGatewayInput): Promise<string>;
  /** 编辑既有条目（按 id 找），写穿 baseUrl / modelId / 密钥。 */
  update(id: string, input: ModelGatewayInput): Promise<void>;
  remove(id: string): Promise<void>;
  /** 只翻转 enabled，条目与配置都保留。 */
  toggle(id: string, enabled: boolean): Promise<void>;
  /** 回写连通测试结果（Task 2 的探测经 Task 3 的「重测」调用）。 */
  setStatus(id: string, status: ModelStatus): void;
}
