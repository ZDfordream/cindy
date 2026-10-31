/**
 * hrbuddyModelsExport — 把已配置的模型镜像写到本地 `~/.hrbuddy/models.json`。
 *
 * 需求 7（2026-10-29）：「模型添加后会自动写入到本地 ~/.workbuddy/models.json 文件中」
 * —— 那是 WorkBuddy 的路径。本产品是 HRBuddy，写进 `~/.hrbuddy/` 而不是
 * `~/.workbuddy/`，避免与用户机器上真正的 WorkBuddy 互相覆盖。
 *
 * ⚠️ 安全边界：**只写模型元数据**（稳定句柄、上游模型 id、供应商名、base URL、能力）。
 * API key 等凭证只进系统 keychain/safeStorage，**绝不落这个 JSON**，也绝不进仓库。
 * 写盘按字段白名单组装行（`toMirrorRow`），多余字段（尤其 `apiKey`）一律丢弃——
 * 即使调用方 spread 进了密钥也不会落盘（Review Focus #1 红线）。
 *
 * 镜像语义（Ruling 17）：**store 的 1:1 投影，不是增量日志**。`exportModels` 整组替换
 * `models` 数组，调用方每次送全量当前条目——同 modelId 多条目并存、删除即消失、
 * 同输入 → 同文件（幂等）。唯一写入方是 `hrbuddy-models:export`（model-gateway store
 * 在增删改 / 开关 / 状态变化后的全量推送）；providerHandlers 的 create 钩子不再写镜像
 * （其局部推送会在整组替换下覆盖别人的行，且它不知道 enabled/status 元数据）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from './logger.js';
import { throwIpcError } from './utils/ipcValidate.js';
import { MAKER_INVOKE } from './maker-ipc/channels.js';
import type { IpcHandlerRegistry } from './maker-ipc/ipcHandlerRegistry.js';

const log = createLogger('hrbuddy-models-export');

/** 连通状态（与 renderer 的 ModelStatus 同构，JSON 可序列化）。 */
export type ExportedModelStatus =
  | 'untested'
  | { ok: true; latencyMs: number }
  | { ok: false; detail: string };

/** 镜像文件里单个模型的形状（刻意不含任何凭证字段）。 */
export interface ExportedModel {
  /** 稳定句柄（= 自定义供应商 id，与 ModelEntry.id 一致）；镜像行的唯一身份。 */
  id: string;
  /** 上游模型 id，原样发给网关。 */
  modelId: string;
  /** 展示名。 */
  name: string;
  /** 来源供应商展示名。 */
  provider: string;
  /** 上游兼容端点（不含密钥）。 */
  baseUrl: string;
  /** wire protocol；取实际值（本产品恒 anthropic-messages）。 */
  wireProtocol?: string;
  supportsToolCalls?: boolean;
  supportsImageInput?: boolean;
  reasoningRequired?: boolean;
  /** 是否出现在聊天的模型菜单；关闭不丢配置（Ruling 5 元数据）。 */
  enabled?: boolean;
  /** 最近一次连通测试结果（untested / ok / failed）。 */
  status?: ExportedModelStatus;
  /** 最近一次连通测试时间（ISO 8601）。 */
  lastTestedAt?: string;
}

export interface ModelsJson {
  /** 镜像格式版本，便于日后演进。 */
  schema: 1;
  updatedAt: string;
  models: ExportedModel[];
}

export function modelsJsonPath(): string {
  return path.join(os.homedir(), '.hrbuddy', 'models.json');
}

function sanitizeStatus(raw: unknown): ExportedModelStatus | undefined {
  if (raw === 'untested') return 'untested';
  if (raw && typeof raw === 'object') {
    const s = raw as Record<string, unknown>;
    if (s.ok === true && typeof s.latencyMs === 'number') {
      return { ok: true, latencyMs: s.latencyMs };
    }
    if (s.ok === false) {
      return { ok: false, detail: typeof s.detail === 'string' ? s.detail : '' };
    }
  }
  return undefined;
}

/**
 * 按白名单组装镜像行：只保留契约字段，其余（尤其 `apiKey`）一律丢弃。
 * 身份字段 `id`（稳定句柄）与 `modelId`（上游模型 id）必需，缺失整行跳过。
 */
function toMirrorRow(raw: unknown): ExportedModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string') return null;
  if (typeof m.modelId !== 'string') return null;
  if (typeof m.provider !== 'string') return null;
  const row: ExportedModel = {
    id: m.id,
    modelId: m.modelId,
    name: typeof m.name === 'string' ? m.name : m.modelId,
    provider: m.provider,
    baseUrl: typeof m.baseUrl === 'string' ? m.baseUrl : '',
  };
  if (typeof m.wireProtocol === 'string') row.wireProtocol = m.wireProtocol;
  if (typeof m.supportsToolCalls === 'boolean') row.supportsToolCalls = m.supportsToolCalls;
  if (typeof m.supportsImageInput === 'boolean') row.supportsImageInput = m.supportsImageInput;
  if (typeof m.reasoningRequired === 'boolean') row.reasoningRequired = m.reasoningRequired;
  if (typeof m.enabled === 'boolean') row.enabled = m.enabled;
  const status = sanitizeStatus(m.status);
  if (status !== undefined) row.status = status;
  if (typeof m.lastTestedAt === 'string') row.lastTestedAt = m.lastTestedAt;
  return row;
}

/**
 * 整组替换写入（Ruling 17）：`models` 数组 = 本次入参经白名单组装后的全部行，
 * 旧内容（含历史泄漏的密钥）随替换整体消失。同输入 → 同文件，满足设计稿的幂等语义。
 * 失败只告警，不阻断主流程（镜像是便利性产物，不是权威存储）。
 */
export function exportModels(models: ExportedModel[]): void {
  try {
    const file = modelsJsonPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const rows: ExportedModel[] = [];
    for (const raw of models) {
      const row = toMirrorRow(raw);
      if (row) rows.push(row);
    }

    const payload: ModelsJson = {
      schema: 1,
      updatedAt: new Date().toISOString(),
      models: rows,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    log.info('models exported', { file, count: rows.length });
  } catch (error) {
    log.warn('models export failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface HrbuddyModelsExportDeps {
  /** 只接受本机可信 Renderer 发起（防止其它 webview 污染镜像）。 */
  assertTrustedSender: (event: unknown) => void;
}

/**
 * `hrbuddy-models:export` 的 handler：model-gateway store 在增删改 / 开关 /
 * 状态变化后推送全量不含密钥的元数据，main 调 `exportModels` 整组替换写盘（Ruling 2/17）。
 * 载荷必须是数组（否则 INVALID_PARAMS）；行级过滤与密钥剥离在 `toMirrorRow`。
 */
export function registerHrbuddyModelsExportIpc(
  registry: IpcHandlerRegistry,
  deps: HrbuddyModelsExportDeps,
): void {
  registry.handle(MAKER_INVOKE.HRBUDDY_MODELS_EXPORT, (event, payload: unknown) => {
    deps.assertTrustedSender(event);
    if (!Array.isArray(payload)) {
      throwIpcError('INVALID_PARAMS', 'models must be an array');
    }
    exportModels(payload as ExportedModel[]);
  });
}
