/**
 * ModelGatewayList — 设置右栏的模型列表（PRD model-provider-settings 2026-11-01）：
 * 头部「模型 (n)」与右对齐「+ 添加模型」，下方单卡列表（插入序；新条目追加末尾），
 * 空态虚线框「还没有添加任何模型」+ 「添加模型」。
 *
 * 自己不持配置状态：条目来自 `useModelGateway()`，增删改与启停都直接走 store。
 * `onAdd`/`onEdit`（打开添加 / 编辑弹窗）由调用方注入，列表只负责转发。
 *
 * 删除 + 撤销（PRD）：点「删除」→ `remove(id)` 立即出行 + toast「已删除 {model}」
 * 带「撤销」，toast 5 秒自动消失（与 store 删除窗口同步）；点「撤销」→ `undo()`
 * 按原索引插回并 flash 高亮（PRD `.row.flash`）。undo 句柄天然防双击（store 的
 * done 标记），双击撤销只恢复一份。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';

import { ModelGatewayRow } from './ModelGatewayRow';
import { useModelGateway } from './ModelGatewayStore';
import type { ModelEntry } from './types';

export interface ModelGatewayListProps {
  /** 打开「添加模型」弹窗。 */
  onAdd: () => void;
  /** 打开「编辑模型」弹窗，携带被编辑条目（回填入口）。 */
  onEdit: (entry: ModelEntry) => void;
}

/** PRD flash 高亮动画时长（`.row.flash { animation: flash 1.4s ease-out }`）。 */
const FLASH_MS = 1400;

export function ModelGatewayList({ onAdd, onEdit }: ModelGatewayListProps) {
  const { t } = useTranslation();
  const { entries, hydrated, remove } = useModelGateway();
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const handleDelete = useCallback(
    async (entry: ModelEntry) => {
      const undoHandle = await remove(entry.id);
      toast.success(
        t('settings.providers.modelGateway.deletedToast', { model: entry.modelId }),
        {
          // 与删除撤销窗口同长：toast 消失即不可撤销（PRD 脚本 5000ms）。
          duration: 5000,
          action: {
            label: t('settings.providers.modelGateway.undo'),
            onClick: () => {
              undoHandle.undo();
              setFlashId(entry.id);
              if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
              flashTimerRef.current = setTimeout(() => setFlashId(null), FLASH_MS);
            },
          },
        },
      );
    },
    [remove, t],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex items-baseline gap-1.5">
          <h3 className="text-13 font-medium" style={{ color: 'var(--settings-section-title)' }}>
            {t('settings.providers.modelGateway.title')}
          </h3>
          <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
            ({entries.length})
          </span>
        </div>
        <Button size="xs" variant="secondary" compact onClick={onAdd}>
          <Plus size={13} />
          {t('settings.providers.modelGateway.add')}
        </Button>
      </div>
      {entries.length > 0 ? (
        /* PRD `.list`：单卡 1px 边 + 圆角 16（偏离登记）+ 行间分隔线。 */
        <ul
          className="flex flex-col overflow-hidden rounded-2xl border"
          style={{
            borderColor: 'var(--settings-theme-card-border)',
            backgroundColor: 'var(--settings-theme-card-bg)',
          }}
        >
          {entries.map((entry) => (
            <ModelGatewayRow
              key={entry.id}
              entry={entry}
              onEdit={onEdit}
              onDelete={handleDelete}
              flash={flashId === entry.id}
            />
          ))}
        </ul>
      ) : hydrated ? (
        /* PRD `.empty`：虚线框空态。`hydrated` 前不展示——加载窗口里的 []
           只是「还没读到」，不是「没有可用模型」。 */
        <div
          className="flex flex-col items-center rounded-2xl border border-dashed px-5 py-11 text-center"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
        >
          <p className="mb-4 text-13">{t('settings.providers.modelGateway.empty')}</p>
          <Button size="xs" variant="secondary" compact onClick={onAdd}>
            <Plus size={13} />
            {t('settings.providers.modelGateway.add')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
