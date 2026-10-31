/**
 * SettingsModalHost — 设置以「弹窗」形态打开（HRBuddy 2026-10-29 需求 5）。
 *
 * 需求原文：「HRBuddy 的设置采用 workbuddy 的弹窗打开形式，这样操作更简单」。
 * WorkBuddy 参考图里设置是一块居中大面板 + 半透明遮罩，而不是整页切换。
 *
 * 做法：保留 `SettingsView` 与它的 `?tab=` 深链（既有链接、测试与路由不受影响），
 * 只是在它外面套一层模态壳——遮罩 + 圆角面板 + 右上角 ×。这样视觉与操作方式
 * 对齐 WorkBuddy，改动半径却局限在路由出口。
 *
 * ⚠️ 已知取舍（如实记录）：路由仍是 `/settings`，因此进入设置时**下层内容会被
 * 路由替换**，不是像 WorkBuddy 那样把设置浮在当前会话之上。要做到后者需要把
 * 设置从「内容区路由」改成「壳层浮层」，会动到 router 的内容区结构与深链语义，
 * 属于更大范围的重构——如果你要那个效果，我再单独做一版。
 *
 * 设计约定：`.modal-scrim` / `.modal-panel` 走共享类（DESIGN.md §4）；
 * 点遮罩不关闭，只经 × / Esc / 返回按钮退出。
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SettingsView } from '@/components/settings/SettingsView';

export function SettingsModalHost() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Esc 关闭（弹窗语义；点遮罩不关，见 DESIGN.md §4）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        navigate(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-3"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.title')}
    >
      {/* 点空白处关闭（owner 2026-10-29：对齐 WorkBuddy；有意偏离 DESIGN.md §4） */}
      <div className="modal-scrim absolute inset-0" onClick={() => navigate(-1)} />

      <div
        className="modal-panel relative flex h-full max-h-[min(820px,92vh)] w-full flex-col overflow-hidden"
        style={{ maxWidth: 'min(1040px, 100vw - 24px)' }}
      >
        {/* 右上角 ×：与 SettingsView 自带的返回按钮并存（WorkBuddy 参考图两者都有） */}
        <button
          type="button"
          aria-label={t('settings.providers.modelDialog.close')}
          className="absolute right-3 top-3 z-10 rounded-full p-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          onClick={() => navigate(-1)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>

        <div className="min-h-0 flex-1">
          <SettingsView />
        </div>
      </div>
    </div>
  );
}
