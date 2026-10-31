/**
 * ModelGatewayList — 设置右栏的模型列表（设计稿 §5.1）：头部「模型 + 数量」与
 * 右对齐「+ 添加模型」，下方按 modelId 升序一列可启停行（`ModelGatewayRow`）。
 *
 * 自己不持状态：条目来自 `useModelGateway()`（Task 1 store，已按 modelId 排序），
 * 增删改与启停都直接走 store。`onAdd`/`onEdit`（打开 Task 4 弹窗）由调用方注入，
 * 列表只负责转发。
 */
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { ModelGatewayRow } from './ModelGatewayRow';
import { useModelGateway } from './ModelGatewayStore';
import type { ModelEntry } from './types';

export interface ModelGatewayListProps {
  /** 打开「添加模型」弹窗（Task 4）。 */
  onAdd: () => void;
  /** 打开「编辑模型」弹窗（Task 4），携带被编辑条目。 */
  onEdit: (entry: ModelEntry) => void;
}

export function ModelGatewayList({ onAdd, onEdit }: ModelGatewayListProps) {
  const { t } = useTranslation();
  const { entries } = useModelGateway();

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
      <ul
        className="flex flex-col overflow-hidden rounded-xl border"
        style={{
          borderColor: 'var(--settings-theme-card-border)',
          backgroundColor: 'var(--settings-theme-card-bg)',
        }}
      >
        {entries.map((entry) => (
          <ModelGatewayRow key={entry.id} entry={entry} onEdit={onEdit} />
        ))}
      </ul>
    </div>
  );
}
