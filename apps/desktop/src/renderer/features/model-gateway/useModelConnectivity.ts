/**
 * useModelConnectivity —— 模型网关条目的连通探测原语（Task 2）。
 *
 * 包一层既有的 `window.electronAPI.maker.testProviderConnection`（adhoc 变体，与设置页
 * 「测试连接」同一 main 侧探测能力），把 `ProviderConnectionTestResult` 归一到
 * `ModelStatus` 的已测分支：成功带延迟、失败带原因，失败原因优先原样透传服务端
 * `detail`。任何失败（含 IPC 抛错）都收敛成 `{ ok: false, detail }`，**永不向上抛**——
 * 调用方（Task 3 重测 / Task 4 保存门）拿到结果直接喂 `setStatus(id, status)`。
 *
 * 凭证契约：API key 只搭这一趟 IPC 入参（key 仅内存透传，main 侧即时探测），
 * 不进 React state、不落任何 JSON / localStorage。协议写死 `anthropic-messages`。
 */
import type { ModelGatewayInput, ModelStatus } from './types';

/** 探测结果 = `ModelStatus` 去掉 `'untested'`，可直接作为 `setStatus` 的入参。 */
export type ModelConnectivityResult = Exclude<ModelStatus, 'untested'>;

/** IPC 抛错且拿不到错误文案时的兜底失败原因（保证 detail 恒非空）。 */
const GENERIC_FAILURE_DETAIL = 'connection test failed';

/**
 * 向网关发一次最小协议探测，验证 baseUrl / 密钥 / 模型都通。
 *
 * 输入即添加 / 编辑弹窗的三栏值（`ModelGatewayInput`）；返回形状见
 * `ModelConnectivityResult`。
 */
export async function testModelConnectivity(
  input: ModelGatewayInput,
): Promise<ModelConnectivityResult> {
  try {
    const result = await window.electronAPI.maker.testProviderConnection({
      kind: 'adhoc',
      requestId: `model-gateway-${Date.now()}`,
      spec: {
        agent: 'claude-code',
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        authMethod: 'apiKey',
        wireProtocol: 'anthropic-messages',
        apiKey: input.apiKey,
      },
    });
    if (result.ok) return { ok: true, latencyMs: result.latencyMs };
    return {
      ok: false,
      detail: result.detail || result.code || GENERIC_FAILURE_DETAIL,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: detail || GENERIC_FAILURE_DETAIL };
  }
}
