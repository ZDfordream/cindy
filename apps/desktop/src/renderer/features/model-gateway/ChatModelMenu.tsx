/**
 * ChatModelMenu —— 聊天输入框右下角的模型菜单（设计稿 §5.3）。
 *
 * 自取数据、无需 props：条目来自 `useModelGateway()`（只列 `enabled === true`），
 * 当前模型来自 `useCurrentModel()`（全局单一值，回落语义见 currentModelStore）。
 * 挂载方负责套 `ModelGatewayProvider`（聊天输入区在 ProvidersSection 子树之外）。
 *
 * 形态：
 * - 当前项胶囊：状态点 + 短名（截断）+ `▾`
 * - 下拉：每行 ✓（当前）+ 状态点 + 名称 + 延迟／「未测试」／「连不上」；
 *   失败原因（原始 detail）只进 tooltip，正文永远是短语（Ruling 11）
 * - 空态（无 enabled 模型）：明确指向「添加模型」（Review Focus #5）
 * - 菜单底部一行弱链「去设置」→ `/settings?tab=providers`
 *
 * 点选即切换全局当前模型，作用于**后续消息**（不回溯已发送的）。
 * 颜色全部走语义 token（Light / Dark 同源），无硬编码色。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

import { useModelGateway } from './ModelGatewayStore';
import { useCurrentModel } from './currentModelStore';
import type { ModelEntry, ModelStatus } from './types';

/** 状态点颜色走语义 token（与 ModelGatewayRow 同口径）：成功绿 / 三级灰 / 错误红。 */
function statusDot(status: ModelStatus): { glyph: string; color: string } {
  if (status === 'untested') return { glyph: '○', color: 'var(--text-tertiary)' };
  if (status.ok) return { glyph: '●', color: 'var(--card-status-done)' };
  return { glyph: '●', color: 'var(--error-fg)' };
}

/** 行内状态文本：延迟 / 未测试 / 连不上（短语，detail 只进 tooltip）。 */
function statusText(t: (key: string) => string, status: ModelStatus): string {
  if (status === 'untested') return t('settings.providers.modelGateway.untested');
  if (status.ok) return `${status.latencyMs}ms`;
  return t('settings.providers.modelGateway.failed');
}

function StatusDot({ status }: { status: ModelStatus }) {
  const dot = statusDot(status);
  return (
    <span
      data-testid="chat-model-status-dot"
      aria-hidden
      className="w-3 shrink-0 text-center text-13 leading-none"
      style={{ color: dot.color }}
    >
      {dot.glyph}
    </span>
  );
}

/** 面板契约宽度（portal 固定定位用；trigger 右缘对齐面板右缘）。 */
const PANEL_WIDTH_PX = 280;

export function ChatModelMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { entries } = useModelGateway();
  const { currentId, setCurrent } = useCurrentModel();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 面板经 portal 挂 body（composer 工具条 overflow-hidden 会裁掉上浮面板），
  // 按 trigger 的视口坐标固定定位；滚动 / 改尺寸即收起，避免漂移。
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);

  const enabled = entries.filter((entry) => entry.enabled);
  const current: ModelEntry | null = enabled.find((entry) => entry.id === currentId) ?? null;

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({
        left: Math.max(8, rect.right - PANEL_WIDTH_PX),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
      });
    }
    setOpen(true);
  };

  // 点外面 / Esc / 滚动 / 改尺寸收起（菜单贴着输入框，Esc 不与输入框抢占——只在展开时接管）。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onGeometryChange = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onGeometryChange);
    document.addEventListener('scroll', onGeometryChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onGeometryChange);
      document.removeEventListener('scroll', onGeometryChange, true);
    };
  }, [open]);

  const goSettings = () => {
    setOpen(false);
    navigate('/settings?tab=providers');
  };

  return (
    <div ref={rootRef} data-testid="chat-model-menu-root" className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('newChat.chatModelMenu.triggerAria')}
        onClick={toggleOpen}
        className={cn(
          'flex h-[30px] max-w-[min(220px,100%)] shrink items-center gap-1 overflow-hidden rounded-full',
          'border border-transparent bg-transparent px-2.5 transition-colors',
          'hover:border-[var(--border-default)] hover:bg-[var(--composer-pill-bg)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
        )}
      >
        <StatusDot status={current?.status ?? 'untested'} />
        <span
          data-testid="chat-model-trigger-label"
          className="min-w-0 truncate text-12 font-medium text-[var(--model-trigger-text)]"
        >
          {current ? current.name : t('newChat.chatModelMenu.placeholder')}
        </span>
        <ChevronDown size={12} className="shrink-0 text-[var(--composer-pill-icon)]" aria-hidden />
      </button>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={panelRef}
            data-testid="chat-model-menu"
            style={{
              position: 'fixed',
              left: anchor.left,
              bottom: anchor.bottom,
              width: PANEL_WIDTH_PX,
            }}
            className={cn(
              'z-50 overflow-hidden rounded-[12px]',
              'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-2',
              'shadow-[var(--shadow-menu)]',
            )}
          >
            {enabled.length === 0 ? (
              // 空态必须指向「添加模型」（Review Focus #5）：去设置 → 模型供应商页添加。
              <div className="flex flex-col items-center gap-2 px-3 py-4">
                <p className="text-13 text-[var(--text-secondary)]">
                  {t('newChat.chatModelMenu.empty')}
                </p>
                <button
                  type="button"
                  onClick={goSettings}
                  className="rounded-lg px-2 py-1 text-13 font-medium text-[var(--accent-cta-fg)] hover:bg-[var(--surface-hover)]"
                >
                  {t('settings.providers.modelGateway.add')}
                </button>
              </div>
            ) : (
              <div
                role="listbox"
                aria-label={t('newChat.chatModelMenu.triggerAria')}
                className="max-h-[300px] overflow-y-auto"
              >
                {enabled.map((entry) => {
                  const selected = entry.id === currentId;
                  return (
                    <div
                      key={entry.id}
                      role="option"
                      aria-selected={selected}
                      tabIndex={0}
                      data-testid="chat-model-menu-row"
                      onClick={() => {
                        setCurrent(entry.id);
                        setOpen(false);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setCurrent(entry.id);
                          setOpen(false);
                        }
                      }}
                      title={
                        entry.status !== 'untested' && !entry.status.ok
                          ? entry.status.detail
                          : undefined
                      }
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-left',
                        'hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                        selected && 'bg-[var(--surface-hover)]',
                      )}
                    >
                      <span className="w-3 shrink-0 text-12" aria-hidden>
                        {selected ? (
                          <Check size={12} className="text-[var(--text-primary)]" />
                        ) : null}
                      </span>
                      <StatusDot status={entry.status} />
                      <span className="min-w-0 flex-1 truncate text-13 text-[var(--text-primary)]">
                        {entry.name}
                      </span>
                      <span className="shrink-0 text-12 text-[var(--text-secondary)]">
                        {statusText(t, entry.status)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 菜单底部一行弱链「去设置」（owner 裁决 2026-10-31 补充 #1）。 */}
            <button
              type="button"
              onClick={goSettings}
              className={cn(
                'mt-1 w-full rounded-[6px] px-2 py-1.5 text-left text-12 text-[var(--text-secondary)]',
                'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              {t('newChat.chatModelMenu.openSettings')}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
