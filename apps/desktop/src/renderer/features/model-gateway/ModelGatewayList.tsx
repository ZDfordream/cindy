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
import { REMOVE_UNDO_WINDOW_MS, useModelGateway } from './ModelGatewayStore';
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
      // F1：撤销入口与真删窗口同源收口。全局 toast 的自动关闭会被 hover / 键盘
      // focus 暂停，而 store 的 `REMOVE_UNDO_WINDOW_MS` 真删定时器不暂停——所以
      // 这里自持一个**不被暂停**的收口定时器（同一常量），到点强制 dismiss toast
      // 并关死撤销入口。起点在 `await remove()` **之前**：UI 窗口只会略早于 store
      // 窗口关闭（安全方向），不会出现「撤销还在但真删已落」的陷阱。
      let toastId: string | undefined;
      let windowOpen = true;
      const closeTimer = setTimeout(() => {
        windowOpen = false;
        if (toastId !== undefined) toast.dismiss(toastId);
      }, REMOVE_UNDO_WINDOW_MS);
      const undoHandle = await remove(entry.id);
      toastId = toast.success(
        t('settings.providers.modelGateway.deletedToast', { model: entry.modelId }),
        {
          // toast 自身的 5s 自动关闭只作无暂停场景的兜底；同源收口靠 closeTimer。
          duration: REMOVE_UNDO_WINDOW_MS,
          action: {
            label: t('settings.providers.modelGateway.undo'),
            onClick: () => {
              // 窗口已关时撤销必须是显式 no-op（不再静默半生效）。
              if (!windowOpen) return;
              windowOpen = false;
              clearTimeout(closeTimer);
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
           只是「还没读到」，不是「没有可用模型」。
           空态文案字号：PRD `.empty p` 13.5px 不在字号白名单（禁小数），
           取整 14（与 name 的 14.5→14 同规则），见 CHANGES.md §9.4 表 14。 */
        <div
          className="flex flex-col items-center rounded-2xl border border-dashed px-5 py-11 text-center"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
        >
          <p className="mb-4 text-14">{t('settings.providers.modelGateway.empty')}</p>
          <Button size="xs" variant="secondary" compact onClick={onAdd}>
            <Plus size={13} />
            {t('settings.providers.modelGateway.add')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
