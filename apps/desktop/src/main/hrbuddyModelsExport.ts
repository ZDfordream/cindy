/**
 * hrbuddyModelsExport — 把已配置的模型镜像写到本地 `~/.hrbuddy/models.json`。
 *
 * 需求 7（2026-10-29）：「模型添加后会自动写入到本地 ~/.workbuddy/models.json 文件中」
 * —— 那是 WorkBuddy 的路径。本产品是 HRBuddy，写进 `~/.hrbuddy/` 而不是
 * `~/.workbuddy/`，避免与用户机器上真正的 WorkBuddy 互相覆盖。
 *
 * ⚠️ 安全边界：**只写模型元数据**（供应商名、上游 base URL、模型 id / 能力）。
 * API key 等凭证只进系统 keychain/safeStorage，**绝不落这个 JSON**，也绝不进仓库。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from './logger.js';

const log = createLogger('hrbuddy-models-export');

/** 镜像文件里单个模型的形状（刻意不含任何凭证字段）。 */
export interface ExportedModel {
  /** 上游模型 id，原样发给网关。 */
  id: string;
  /** 展示名。 */
  name: string;
  /** 来源供应商展示名。 */
  provider: string;
  /** 上游兼容端点（不含密钥）。 */
  baseUrl: string;
  /** wire protocol；HRBuddy 当前只接 OpenAI 兼容。 */
  wireProtocol?: string;
  supportsToolCalls?: boolean;
  supportsImageInput?: boolean;
  reasoningRequired?: boolean;
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

/**
 * 幂等写入：按 `provider + id` 去重合并，重复调用结果相同。
 * 失败只告警，不阻断主流程（镜像是便利性产物，不是权威存储）。
 */
export function exportModels(models: ExportedModel[]): void {
  try {
    const file = modelsJsonPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });

    let existing: ExportedModel[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ModelsJson>;
      if (Array.isArray(parsed.models)) existing = parsed.models;
    } catch {
      // 文件不存在 / 尚未是合法 JSON → 从空开始重建
    }

    const merged = new Map<string, ExportedModel>();
    for (const m of existing) {
      if (m && typeof m.id === 'string' && typeof m.provider === 'string') {
        merged.set(m.provider + ' ' + m.id, m);
      }
    }
    for (const m of models) merged.set(m.provider + ' ' + m.id, m);

    const payload: ModelsJson = {
      schema: 1,
      updatedAt: new Date().toISOString(),
      models: [...merged.values()],
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    log.info('models exported', { file, count: payload.models.length });
  } catch (error) {
    log.warn('models export failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
