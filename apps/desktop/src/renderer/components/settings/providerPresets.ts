/**
 * providerPresets — 官方 API 接入的预设资料（供应商端点 + 推荐模型兜底）。
 *
 * 原先住在 AddProviderWizard 内；2026-10-29 需求 4 把「添加供应商」收敛成
 * Anthropic 网关三输入框、移除多供应商向导后，这份数据仍被
 * ProviderConnectionDialog（既有供应商的连接表单）使用，故独立成模块。
 */
import type { ProviderPreset } from '@cindy/model-providers';

/**
 * bespoke OAuth 渠道的官方 API 预设——授权步「改用 API Key 接入」的替代路径
 * (API 用户没有订阅,OAuth 授权对其是错误路径)。
 *
 * 不能复用 OAuth routing 的 upstream:那是订阅专用端点(openai 是 chatgpt
 * backend)。此处声明官方 API 端点,模型清单以 Step 3 列模型接口实拉为准
 * (缺省由 baseUrl 推导 …/v1/models,见 provider-model-fetch);同时内置少量
 * 推荐模型兜底——拉取因网络/限流失败时降级为「仅推荐模型」仍可完成创建,
 * 不把用户堵死(与目录预设同语义;Greptile P1 反馈 2026-07-24)。
 * 每个 runtime 都独立声明 wire protocol：Anthropic API 同时提供 Claude Code 的
 * Messages 与 Codex 桥接所需的 Messages 端点；openai/xai 声明 Codex 与 Pi 原生协议
 * runtime(两家无 Anthropic 兼容端点),表单会自动展示实际支持的 runtime。
 */
const ANTHROPIC_API_MODELS = [
  { id: 'claude-opus-5', defaultEnabled: true, name: 'Claude Opus 5', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5', defaultEnabled: true, name: 'Claude Sonnet 5', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5', defaultEnabled: true, name: 'Claude Haiku 4.5', contextWindow: 200_000 },
];
const OPENAI_API_MODELS = [
  { id: 'gpt-5.5', defaultEnabled: true, name: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', defaultEnabled: true, name: 'GPT-5.4 mini' },
];
const XAI_API_MODELS = [
  { id: 'grok-4.6', defaultEnabled: true, name: 'Grok 4.6', contextWindow: 500_000 },
  { id: 'grok-4.5', defaultEnabled: true, name: 'Grok 4.5', contextWindow: 500_000 },
  { id: 'grok-4.3', defaultEnabled: true, name: 'Grok 4.3', contextWindow: 1_000_000 },
];

export const OFFICIAL_API_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    id: 'anthropic-api',
    name: 'Anthropic API',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    runtimes: {
      'claude-code': {
        baseUrl: 'https://api.anthropic.com',
        // contextWindow 必须与目录(providers.json)一致:保存时它是窗口的唯一来源
        // (拉取的模型列表不带窗口),缺省会落 200k 默认 → toSdkModelString 剥掉
        // 1M 模型的 [1m] 路由,用户拿到 1/5 窗口。
        models: ANTHROPIC_API_MODELS,
      },
      // Codex 通过 Responses → Anthropic Messages 本地桥接访问同一官方 API。
      // 这不是 Claude.ai OAuth 路由：API key 由该 runtime 独立存储，出站只使用
      // x-api-key，Codex 自带的 OpenAI Authorization 永不透传到 Anthropic。
      codex: {
        wireProtocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        models: ANTHROPIC_API_MODELS,
      },
      pi: {
        wireProtocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        models: ANTHROPIC_API_MODELS,
      },
    },
  },
  openai: {
    id: 'openai-api',
    name: 'OpenAI API',
    docsUrl: 'https://platform.openai.com/api-keys',
    runtimes: {
      codex: {
        baseUrl: 'https://api.openai.com/v1',
        models: OPENAI_API_MODELS,
      },
      pi: {
        baseUrl: 'https://api.openai.com/v1',
        wireProtocol: 'openai-responses',
        models: OPENAI_API_MODELS,
      },
    },
  },
  xai: {
    id: 'xai-api',
    name: 'xAI API',
    docsUrl: 'https://console.x.ai',
    runtimes: {
      codex: {
        baseUrl: 'https://api.x.ai/v1',
        wireProtocol: 'openai-chat',
        // contextWindow 必须与目录一致:拉取失败时 handleFinish 只读预设窗口,
        // 缺省会落 toCatalogModel 的 200k 默认。
        models: XAI_API_MODELS,
      },
      pi: {
        baseUrl: 'https://api.x.ai/v1',
        wireProtocol: 'openai-chat',
        models: XAI_API_MODELS,
      },
    },
  },
};
