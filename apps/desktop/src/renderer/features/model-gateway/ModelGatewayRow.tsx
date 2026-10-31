/**
 * ModelGatewayRow — 模型列表的一行（设计稿 §5.1）：状态点 + 模型名 + 状态文本 +
 * 「编辑」「删除」+ 启停开关。
 *
 * 状态点三态：`●` 绿=已连通(行内显示延迟) / `○` 灰=未测试 / `●` 红=连不上。
 * 状态文本格本身就是重测按钮（Ruling 1：store 无 retest，行内自己跑探测再回写
 * `setStatus`）——`aria-label` 重测，`title` 提示「重测连通」；连不上时 title 顺带
 * 附上原始 detail。detail 只出现在 tooltip，正文永远是短的人话标签（连不上）。
 *
 * 凭证契约：重测时经 `readCustomProviderKey` 从 keychain 现读 API key，只作为
 * 一次探测的 IPC 入参，不进 React state、不落任何 JSON。协议写死
 * `anthropic-messages`（`testModelConnectivity` 内固定）。
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { readCustomProviderKey } from '@/lib/customProviders';

import { useModelGateway } from './ModelGatewayStore';
import { testModelConnectivity } from './useModelConnectivity';
import type { ModelEntry, ModelStatus } from './types';

/** 状态点颜色走语义 token：成功绿 / 三级灰 / 错误红，Light/Dark 同源。 */
function statusDot(status: ModelStatus): { glyph: string; color: string } {
  if (status === 'untested') return { glyph: '○', color: 'var(--text-tertiary)' };
  if (status.ok) return { glyph: '●', color: 'var(--card-status-done)' };
  return { glyph: '●', color: 'var(--error-fg)' };
}

export function ModelGatewayRow({
  entry,
  onEdit,
}: {
  entry: ModelEntry;
  onEdit: (entry: ModelEntry) => void;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { toggle, remove, setStatus } = useModelGateway();
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

  const handleDelete = useCallback(async () => {
    const confirmed = await confirm({
      title: t('settings.providers.modelGateway.deleteConfirm.title'),
      description: t('settings.providers.modelGateway.deleteConfirm.description', {
        name: entry.modelId,
      }),
      confirmText: t('settings.providers.modelGateway.deleteConfirm.confirm'),
      confirmVariant: 'destructive',
    });
    if (confirmed) await remove(entry.id);
  }, [confirm, entry.id, entry.modelId, remove, t]);

  const dot = statusDot(entry.status);
  const statusText =
    entry.status === 'untested'
      ? t('settings.providers.modelGateway.untested')
      : entry.status.ok
        ? `${entry.status.latencyMs}ms`
        : t('settings.providers.modelGateway.failed');
  // 失败原因（原始 detail）只进 tooltip；「重测连通」提示负责可发现性。
  const retestTip =
    entry.status !== 'untested' && !entry.status.ok
      ? `${t('settings.providers.modelGateway.retestTip')}\n${entry.status.detail}`
      : t('settings.providers.modelGateway.retestTip');

  return (
    <li
      data-testid="model-gateway-row"
      className="flex items-center gap-2 border-b px-4 py-2.5 last:border-b-0"
      style={{ borderColor: 'var(--settings-theme-card-border)' }}
    >
      <span
        data-testid="model-gateway-status-dot"
        aria-hidden
        className="w-3 shrink-0 text-center text-13 leading-none"
        style={{ color: dot.color }}
      >
        {dot.glyph}
      </span>
      <span className="min-w-0 flex-1 truncate text-13" style={{ color: 'var(--text-primary)' }}>
        {entry.modelId}
      </span>
      <button
        type="button"
        aria-label={t('settings.providers.modelGateway.retest')}
        title={retestTip}
        disabled={retesting}
        onClick={() => void handleRetest()}
        className="shrink-0 px-1 text-12"
        style={{ color: 'var(--text-secondary)' }}
      >
        {statusText}
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="xs" tone="quiet" compact onClick={() => onEdit(entry)}>
          {t('settings.providers.modelGateway.edit')}
        </Button>
        <Button size="xs" tone="quiet" compact onClick={() => void handleDelete()}>
          {t('settings.providers.modelGateway.delete')}
        </Button>
        <Switch
          checked={entry.enabled}
          onCheckedChange={(next) => void toggle(entry.id, next)}
          aria-label={t('settings.providers.modelGateway.toggle', { name: entry.modelId })}
        />
      </div>
    </li>
  );
}
