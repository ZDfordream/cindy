/**
 * LogoutConfirmDialog — 退出登录确认弹窗（FR-LOGOUT-02 / T15）。
 *
 * 几何（PRD FR-LOGOUT-02）：宽 400px（确认类弹窗宽度，DESIGN §4）、圆角 22px =
 * §5 登记形状 `hrbuddy-logout-confirm-panel`（同 `hrbuddy-model-dialog-panel` 的
 * 22px 覆盖共享 `.modal-panel` 12px）；表面走共享 `.modal-scrim` / `.modal-panel`
 * （DESIGN §4 居中弹窗合同：登记底、描边、浮层阴影，调用点不再自带）。
 *
 * 文案（逐字）：`确定退出登录？` / `退出后需要重新登录才能使用 HRBuddy。`；
 * 有进行中任务时增一行 `当前有 N 个任务正在运行，退出将中断该任务。`（N=实际数，
 * 开弹窗瞬间的快照）。按钮 `取消` / `退出登录`；确认后按钮变 `正在退出…` 并禁用。
 *
 * 焦点（FR-LOGOUT-02）：初始焦点在「取消」；Tab/Shift+Tab 陷阱在弹窗内循环；
 * Esc / 点遮罩 / 取消 → 关闭并把焦点还给个人入口（开弹窗瞬间持有焦点的元素——
 * ProfileMenu 选中「退出登录」后已把焦点还给入口，时序与 ProfileMenu 的
 * returnFocus 同款）。**确认进行中（confirming）所有关闭路径一律锁住**：确认后
 * 登出已在途（不可逆），Esc/遮罩/取消若再把弹窗收掉会留下「界面以为没退、其实
 * 正在退」的假象——同共享 ConfirmDialog 的 loading 合同。
 *
 * `useHrOaLogoutConfirm` — 宿主接线的生产同构件（UserInfoSection 的 HrProfileFooter
 * 与会话规则用例共用）：开弹窗时快照 `countRunningAgentRuns()`（Ruling B 口径）、
 * 确认走 `requestHrOaLogout({ confirmBeatMs })`（先真停在途 Agent 轮再落
 * signed-out，T15 拍 ≥400ms）、登录态失效（FR-LOGOUT-05）或落 signed-out 时收弹窗。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { trackHrOaEvent } from '@/lib/hrOaTelemetry';
import {
  HR_OA_LOGOUT_CONFIRM_BEAT_MS,
  requestHrOaLogout,
  useHrOaAuth,
} from '../hr-oa-auth/hrOaAuthStore';
import { countRunningAgentRuns } from './runningTasks';

/** `logout_confirm_result.method`（PRD §11）：按钮 / Esc / 遮罩。 */
type LogoutConfirmMethod = 'button' | 'esc' | 'mask';

/** 弹窗内可聚焦控件（确认拍禁用后自动退出焦点环，与 disabled 语义一致）。 */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled])')];
}

export function LogoutConfirmDialog(props: {
  open: boolean;
  runningTaskCount: number;
  onCancel: () => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const { open, runningTaskCount, onCancel, onConfirm, confirming } = props;
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** 焦点归还目标：开弹窗瞬间持有焦点的个人入口。 */
  const openerRef = useRef<HTMLElement | null>(null);

  // 开弹窗一次性：记焦点归还目标、初始焦点「取消」、发 `logout_confirm_view`；
  // 关闭/卸载时把焦点还给入口（入口仍在树上时；确认成功后整树随 ownerKey 重挂载，
  // 入口已不在则不硬抢）。
  useEffect(() => {
    if (!open) return;
    // 埋点（profile-menu PRD §11）：弹窗曝光一次（开弹窗瞬间的 N 快照口径同 Ruling B）。
    trackHrOaEvent('logout_confirm_view', { has_running_task: runningTaskCount > 0 });
    const active = document.activeElement;
    openerRef.current =
      active instanceof HTMLElement && !panelRef.current?.contains(active) ? active : null;
    cancelRef.current?.focus();
    return () => {
      const target = openerRef.current;
      if (target && target.isConnected && target !== document.activeElement) {
        target.focus();
      }
    };
  }, [open, runningTaskCount]);

  if (!open) return null;

  const cancel = (method: LogoutConfirmMethod): void => {
    if (confirming) return;
    // 埋点（profile-menu PRD §11 logout_confirm_result）：用户收口的三条路记 method；
    // 会话失效强退的被动关闭不是用户决定，不发本事件（后续 logout 带 entry 记因）。
    trackHrOaEvent('logout_confirm_result', { result: 'cancel', method });
    onCancel();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel('esc');
      return;
    }
    if (event.key !== 'Tab') return;
    // 焦点陷阱：Tab/Shift+Tab 只在弹窗内循环（FR-LOGOUT-02）。
    const root = panelRef.current;
    if (!root) return;
    event.preventDefault();
    const items = focusablesIn(root);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? (current <= 0 ? items.length - 1 : current - 1)
      : (current < 0 || current === items.length - 1 ? 0 : current + 1);
    items[next]?.focus();
  };

  const titleId = 'logout-confirm-title';
  const bodyId = 'logout-confirm-body';
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      <div className="modal-scrim absolute inset-0" onClick={() => cancel('mask')} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={onKeyDown}
        className={cn(
          // 22px 圆角 = §5 登记 hrbuddy-logout-confirm-panel（PRD FR-LOGOUT-02 版式）。
          'modal-panel !rounded-[22px] relative flex w-full flex-col',
        )}
        style={{ maxWidth: 400 }}
      >
        <div className="flex flex-col gap-2 px-6 pb-2 pt-6">
          <h2 id={titleId} className="text-lg font-semibold leading-tight text-[var(--confirm-title)]">
            {t('hrOa.logout.title')}
          </h2>
          <p id={bodyId} className="text-14 leading-[1.43] text-[var(--confirm-desc)]">
            {t('hrOa.logout.body')}
          </p>
          {runningTaskCount > 0 ? (
            <p className="text-14 leading-[1.43] text-[var(--confirm-desc)]">
              {t('hrOa.logout.runningTasks', { count: runningTaskCount })}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 justify-end gap-2.5 px-6 pb-6 pt-4">
          <Button
            ref={cancelRef}
            type="button"
            size="lg"
            variant="secondary"
            palette="confirmation"
            disabled={confirming}
            onClick={() => cancel('button')}
            className="h-auto min-h-9 min-w-[96px] whitespace-nowrap py-1.5"
          >
            {t('logic.confirm.cancel')}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="primary"
            tone="danger-solid"
            palette="confirmation"
            disabled={confirming}
            onClick={() => {
              // 埋点（profile-menu PRD §11）：确认只有按钮一条路。
              trackHrOaEvent('logout_confirm_result', { result: 'confirm', method: 'button' });
              onConfirm();
            }}
            className="h-auto min-h-9 min-w-[96px] whitespace-nowrap py-1.5"
          >
            {confirming ? t('hrOa.logout.confirming') : t('hrOa.more.logout')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 确认流程的宿主接线（生产同构件）：弹层末项 / 入口 → 确认弹窗 → `requestHrOaLogout`。
 * 登录态失效（FR-LOGOUT-05）或任何 signed-out 落定都会收掉开着的弹窗。
 */
export function useHrOaLogoutConfirm(): {
  dialogOpen: boolean;
  confirming: boolean;
  runningTaskCount: number;
  openConfirm: () => void;
  cancelConfirm: () => void;
  confirmLogout: () => Promise<void>;
} {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [runningTaskCount, setRunningTaskCount] = useState(0);
  const { state } = useHrOaAuth();

  // FR-LOGOUT-05：登录态失效强退（确认弹窗若开着则一并关闭）。
  useEffect(() => {
    if (state?.status === 'signed-out') {
      setDialogOpen(false);
      setConfirming(false);
    }
  }, [state]);

  const openConfirm = useCallback(() => {
    // N 的快照口径（Ruling B）：开弹窗瞬间「当前账号下有在途 Agent 轮的会话数」。
    // 同步读取（store 自登记，见 runningTasks 头注——不引入重模块装入依赖）。
    setRunningTaskCount(countRunningAgentRuns());
    setConfirming(false);
    setDialogOpen(true);
  }, []);

  const cancelConfirm = useCallback(() => {
    setDialogOpen(false);
  }, []);

  const confirmLogout = useCallback(async () => {
    setConfirming(true);
    try {
      // T15：「正在退出…」拍 ≥ HR_OA_LOGOUT_CONFIRM_BEAT_MS；链内先真停在途
      // Agent 轮再落 signed-out（顺序合同见 requestHrOaLogout / runningTasks）。
      await requestHrOaLogout({ confirmBeatMs: HR_OA_LOGOUT_CONFIRM_BEAT_MS });
    } finally {
      // 失败（回 false）同样收弹窗：登录态未变、留在原界面，等下一次触发。
      setConfirming(false);
      setDialogOpen(false);
    }
  }, []);

  return {
    dialogOpen,
    confirming,
    runningTaskCount,
    openConfirm,
    cancelConfirm,
    confirmLogout,
  };
}
