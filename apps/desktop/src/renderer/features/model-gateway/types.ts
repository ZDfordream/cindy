/**
 * model-gateway —— 模型条目数据层的公共类型。
 *
 * 形状对齐设计稿 §6.1「模型条目」，按 Ruling 4 调整 id 语义：
 * `id` 是**稳定句柄**（= 自定义供应商 id，编辑 modelId 不换 id，Task 3 编辑流与
 * Task 6 当前模型指针都钉在它上面）；`modelId` 是上游模型 id（原样发给网关）；
 * `name` 是展示名（首版 = modelId 本身）；协议恒 `anthropic-messages`
 * （写死，不出现在条目里）。
 */

/** 连通状态：未测试 / 已连通（带延迟）/ 连不上（带原因）。 */
export type ModelStatus =
  | 'untested'
  | { ok: true; latencyMs: number }
  | { ok: false; detail: string };

/** 列表与聊天下拉消费的模型条目（不含密钥——凭证只走 keychain / safeStorage）。 */
export interface ModelEntry {
  /** 稳定句柄（= 自定义供应商 id）；永不因编辑 modelId 而改变。 */
  id: string;
  /** 上游模型 id，原样发给网关。 */
  modelId: string;
  /** 展示名（首版 = modelId 本身）。 */
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

/**
 * `remove` 返回的撤销句柄（PRD：删除后 5 秒可撤销）。
 * `undo()` 取消延迟删除并把条目按**原索引**插回（id / enabled / 密钥都不变）。
 */
export type UndoHandle = { undo: () => void };

/** `useModelGateway()` 暴露的 store API。 */
export interface ModelGatewayApi {
  /** 新表单条目（旧配置不出现），保持**插入序**：加载顺序 = listProviders 返回序，add 追加末尾。 */
  entries: ModelEntry[];
  /**
   * 条目表是否已完成首次加载。加载窗口内 `entries` 的 `[]` 只是「还没读到」，
   * 不是「没有可用模型」——当前模型的回落 / 写回必须等它为 true（review：
   * 否则每次重启 / remount 都会把已持久化的当前模型抹掉）。
   */
  hydrated: boolean;
  /** 新建条目并返回其稳定 id（= 自定义供应商 id）；追加末尾，status 恒 `untested`。 */
  add(input: ModelGatewayInput): Promise<string>;
  /**
   * 按稳定 id 编辑条目；可改 baseUrl / modelId / 密钥，id 不变。
   * baseUrl / modelId / 密钥任一变化时 status 重置为 `untested`（旧探测结果作废），
   * 全都没变则保留原 status。
   */
  update(id: string, input: ModelGatewayInput): Promise<void>;
  /**
   * 立即从 `entries` 摘除并返回撤销句柄；真正的 `deleteCustomProvider`（含 keychain
   * 密钥）延迟 5000ms。窗口内 `undo()` 把条目按原索引插回。
   */
  remove(id: string): Promise<UndoHandle>;
  /** 只翻转 enabled，条目与配置都保留。 */
  toggle(id: string, enabled: boolean): Promise<void>;
  /** 回写连通测试结果（列表行的「重测」与演示规则调用）。 */
  setStatus(id: string, status: ModelStatus): Promise<void>;
}
