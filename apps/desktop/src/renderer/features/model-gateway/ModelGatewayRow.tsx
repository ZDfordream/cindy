/**
 * ModelGatewayRow — 模型列表的一行（PRD model-provider-settings 2026-11-01）：
 * 状态点 + 模型名 + 状态文字 + 「编辑」「删除（弱化）」+ 启停开关。
 *
 * 状态点与状态文字同走四态且一一对应：`idle` 空心=未测试 / `ok` 绿=`{n}ms` /
 * `fail` 红=连不上 / `testing` 旋环=测试中…（`data-status` 挂在点与状态文字上，
 * 测试按它对照两处）。状态文字格本身就是重测按钮（Ruling 1：store 无 retest，
 * 行内自己跑探测再回写 `setStatus`）——title 提示「点击测试连通性」，testing
 * 期间禁点。失败原因（原始 detail）不进正文（PRD 短文案），可查 store 元数据。
 *
 * 删除无确认框（PRD）：点「删除」行立即出列表，撤销 toast 由 `ModelGatewayList`
 * 统一弹；本组件只转发 `onDelete`。撤销回原位后的 flash 高亮由列表经 `flash`
 * 下传（PRD `.row.flash`）。
 *
 * 凭证契约：重测时经 `readCustomProviderKey` 从 keychain 现读 API key，只作为
 * 一次探测的 IPC 入参，不进 React state、不落任何 JSON。协议写死
 * `anthropic-messages`（`testModelConnectivity` 内固定）。
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { readCustomProviderKey } from '@/lib/customProviders';
import { cn } from '@/lib/utils';

import { useModelGateway } from './ModelGatewayStore';
import { testModelConnectivity } from './useModelConnectivity';
import type { ModelEntry, ModelStatus } from './types';

/** 状态点/状态文字的公共四态标签（idle / ok / fail / testing）。 */
export type RowStatusKind = 'idle' | 'ok' | 'fail' | 'testing';

function statusKindOf(status: ModelStatus, retesting: boolean): RowStatusKind {
  if (retesting) return 'testing';
  if (status === 'untested') return 'idle';
  return status.ok ? 'ok' : 'fail';
}

/**
 * 状态点四态样式（PRD `.dot`）：空心灰 / 绿 / 红 / 旋环。颜色全走语义 token
 * （`card-status-done` 状态点绿、`error-fg` 红、text 层灰），Light/Dark 同源。
 */
const DOT_CLASS: Record<RowStatusKind, string> = {
  idle: 'border-[1.5px] border-[var(--text-tertiary)] bg-transparent',
  ok: 'border-0 bg-[var(--card-status-done)]',
  fail: 'border-0 bg-[var(--error-fg)]',
  testing:
    'border-2 border-[var(--text-tertiary)] border-t-[var(--text-primary)] animate-spin motion-reduce:animate-none',
};

export function ModelGatewayRow({
  entry,
  onEdit,
  onDelete,
  flash,
}: {
  entry: ModelEntry;
  onEdit: (entry: ModelEntry) => void;
  /** 删除动作上抛给列表（弹撤销 toast + flash 编排在列表层）。 */
  onDelete: (entry: ModelEntry) => void;
  /** 撤销回原位后的 flash 高亮（PRD `.row.flash`）。 */
  flash?: boolean;
}) {
  const { t } = useTranslation();
  const { toggle, setStatus } = useModelGateway();
  const [retesting, setRetesting] = useState(false);

  const handleRetest = useCallback(async () => {
    if (retesting) return;
    setRetesting(true);
    try {
      // 密钥只作为本次探测的 IPC 入参，不进 state。
      const apiKey = (await readCustomProviderKey(entry.id, 'claude-code')) ?? '';
      const result = await testModelConnectivity({
        baseUrl: entry.baseUrl,
        apiKey,
        modelId: entry.modelId,
      });
      setStatus(entry.id, result);
    } finally {
      setRetesting(false);
    }
  }, [entry.baseUrl, entry.id, entry.modelId, retesting, setStatus]);

  const kind = statusKindOf(entry.status, retesting);
  const statusText =
    kind === 'testing'
      ? t('settings.providers.modelGateway.testing')
      : kind === 'idle'
        ? t('settings.providers.modelGateway.untested')
        : kind === 'ok'
          ? `${(entry.status as { ok: true; latencyMs: number }).latencyMs}ms`
          : t('settings.providers.modelGateway.failed');

  return (
    <li
      data-testid="model-gateway-row"
      data-flash={flash ? 'true' : undefined}
      className={cn(
        'flex h-[54px] items-center gap-3.5 border-b px-[18px] transition-colors last:border-b-0',
        'hover:bg-[var(--surface-hover)]',
        flash && 'model-gateway-row-flash',
      )}
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <span
        data-testid="model-gateway-status-dot"
        data-status={kind}
        aria-hidden
        className={cn('h-3 w-3 shrink-0 rounded-full', DOT_CLASS[kind])}
      />
      <span
        className="min-w-0 flex-1 truncate text-14 font-medium"
        style={{ color: 'var(--text-primary)' }}
        title={entry.modelId}
      >
        {entry.modelId}
      </span>
      <button
        type="button"
        data-status={kind}
        aria-label={t('settings.providers.modelGateway.retest')}
        title={t('settings.providers.modelGateway.retestTip')}
        disabled={retesting}
        onClick={() => void handleRetest()}
        className="w-[74px] shrink-0 rounded-md text-left text-13 transition-colors disabled:cursor-default enabled:hover:text-[var(--text-primary)] enabled:hover:underline enabled:underline-offset-[3px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        {statusText}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="xs" tone="quiet" compact onClick={() => onEdit(entry)}>
          {t('settings.providers.modelGateway.edit')}
        </Button>
        <Button
          size="xs"
          tone="quiet"
          compact
          onClick={() => onDelete(entry)}
          className="font-normal text-[var(--text-tertiary)]"
        >
          {t('settings.providers.modelGateway.delete')}
        </Button>
        {/* PRD 行内开关 40×24（偏离登记）：共享 Switch 为 36×20 的批准几何，
            此处按 PRD 用本地 role="switch" 控件，颜色仍走 switch 语义 token。 */}
        <button
          type="button"
          role="switch"
          aria-checked={entry.enabled}
          aria-label={t('settings.providers.modelGateway.toggle', { name: entry.modelId })}
          onClick={() => void toggle(entry.id, !entry.enabled)}
          className={cn(
            'relative h-6 w-10 shrink-0 rounded-full transition-colors',
            entry.enabled ? 'bg-[var(--switch-track-on)]' : 'bg-[var(--switch-track-off)]',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'absolute left-0.5 top-0.5 h-5 w-5 rounded-full transition-transform',
              entry.enabled
                ? 'translate-x-4 bg-[var(--switch-thumb-on)]'
                : 'translate-x-0 bg-[var(--switch-thumb-off)]',
            )}
          />
        </button>
      </div>
    </li>
  );
}
