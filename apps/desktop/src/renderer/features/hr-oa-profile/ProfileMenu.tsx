/**
 * ProfileMenu — 个人弹层（FR-MENU-01~07）：≡ 菜单迁移后的唯一应用级菜单。
 *
 * 几何（PRD FR-MENU-01 / 原型 `.profile-pop`）：自个人入口向上弹，左缘与入口左缘
 * 对齐、底边距入口顶边 6px（原型 `left: 0; bottom: calc(100% + 6px)` 的 fixed 换算）；
 * 宽固定 264px（FR-PROFILE-06）；圆角 14px = §5 登记形状 `hrbuddy-profile-menu`；
 * 阴影同「更多」浮层（登记浮层阴影 `--shadow-menu`）。最大高度 = 窗口高度 − 72px，
 * 超出内部滚动（原型 `overflow-y: auto` 的「菜单区内部滚动」口径）。
 *
 * 结构（FR-MENU-01）：身份卡（`ProfileCard`，含失败面「重试」）+ 分隔线 +
 * 迁入的 ≡ 菜单项（§6.2 迁移对照表顺序：设置 / 资源监视器 / 帮助 / 问题反馈 /
 * 检查更新）+ 分隔线 + `退出登录`。**「问题反馈」不得改名**（FR-MENU-05 明文
 * 红线，不改成 WorkBuddy 的「意见反馈」）；文案 key 沿用 ≡ 的 `titleBar.menuItems.*`
 * 与 `hrOa.more.logout`，五语逐字不变。菜单项常量（`PROFILE_MENU_ITEMS`，文案 key）
 * 由本文件导出，供埋点复用。
 *
 * 键盘（FR-MENU-07 / 原型 popEl keydown）：打开后焦点在第 1 个可用项（获取失败时
 * 为「重试」；↑ 开层聚焦末项经可选超集 `initialFocus` 传入，同 Task 3 `onOpen` 的
 * focus 提示）；↑/↓ 在 `[role=menuitem]` 序内循环（含身份卡的「重试」，原型
 * `popItems` 同口径），Home/End 跳首末；Enter/Space 走原生 button 语义执行；
 * Esc 关闭并把焦点还给个人入口；Tab/Shift+Tab 关闭并按顺序移走焦点（原型
 * stageFocusables：前进 = 入口之后下一个可聚焦元素，后退 = 入口本身）；点外部关闭
 * 且不移焦（原型 outside pointerdown 口径）。关闭焦点归还目标 = 开层瞬间的
 * `document.activeElement`（即个人入口；ProfileEntry / HrProfileRailEntry 开层前都
 * 持有焦点）。
 *
 * 打开收口（FR-MENU-01「其他浮层与提示全部关闭」）：结果提示（toast）全部收起；
 * 其它 Radix 浮层由其自身「外部点击收起」覆盖；图标提示（BUG-TOOLTIP-01）由
 * Task 7 的提示引擎按「菜单打开时立即消失」收口。另按 FR-PROFILE-07 R5：距上次
 * 成功取数超 30 分钟时后台 `refresh('stale')`（不回骨架）。
 *
 * 数据面：身份卡内容与「重试」动作取自 `useHrOaProfile()`（Ruling A 的 `ProfileState`
 * 由 `profileState` prop 受控供给展示与初始焦点分流，宿主传同一 hook 的 `state`）。
 */

import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  CircleHelp,
  LogOut,
  MessageSquare,
  RefreshCw,
  Settings,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useAppShortcutDisplay } from '@/hooks/useAppShortcut';
import { ProfileCard } from './ProfileCard';
import { isProfileStale, useHrOaProfile, type ProfileState } from './useHrOaProfile';

/** 弹层动作项（≡ 迁移对照表 + 退出登录）；埋点复用本并集与常量表。 */
export type ProfileMenuItem =
  | 'settings'
  | 'resource_monitor'
  | 'help'
  | 'feedback'
  | 'check_update'
  | 'logout';

/**
 * 菜单项常量（≡ 的文案 key 迁到本文件，供埋点复用）。顺序 = PRD §6.2 迁移对照表，
 * 与渲染序一致；`labelKey` 沿用 ≡ 原 key，五语文案逐字不变。
 */
export const PROFILE_MENU_ITEMS: ReadonlyArray<{
  id: Exclude<ProfileMenuItem, 'logout'>;
  labelKey: string;
  icon: LucideIcon;
}> = [
  { id: 'settings', labelKey: 'titleBar.menuItems.settings', icon: Settings },
  { id: 'resource_monitor', labelKey: 'titleBar.menuItems.resourceUsage', icon: Activity },
  { id: 'help', labelKey: 'titleBar.menuItems.help', icon: CircleHelp },
  { id: 'feedback', labelKey: 'titleBar.menuItems.issues', icon: MessageSquare },
  { id: 'check_update', labelKey: 'titleBar.menuItems.checkForUpdates', icon: RefreshCw },
] as const;

/** 退出登录（迁移对照表末项；文案 key 沿用「更多」同款 `hrOa.more.logout`）。 */
export const PROFILE_MENU_LOGOUT_LABEL_KEY = 'hrOa.more.logout';

/** 弹层内可聚焦项 = `[role=menuitem]`（含身份卡失败/更新失败面的「重试」，原型 popItems；
 * `aria-disabled` 的「重试中…」仍留在环内可聚焦，同原型只滤真正 disabled/不在场的项）。 */
function menuItemsIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (el) => !el.hasAttribute('disabled'),
  );
}

/** 弹层外的 Tab 序（原型 stageFocusables：不含弹层自身、不含 inert/隐藏）。 */
function tabbablesOutside(root: HTMLElement | null): HTMLElement[] {
  const selector =
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
  return [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => {
    if (root?.contains(el)) return false;
    if (el.closest('[hidden]') || el.closest('[inert]')) return false;
    return el.getAttribute('aria-hidden') !== 'true';
  });
}

export function ProfileMenu(props: {
  open: boolean;
  anchor: DOMRect | null;
  /** 展示状态（Ruling A 的 `ProfileState`）；宿主传 `useHrOaProfile().state`。 */
  profileState: ProfileState;
  onClose: () => void;
  onAction: (item: ProfileMenuItem) => void;
  /** 可选超集：↑ 开层聚焦末项（FR-PROFILE-01 / AC-04）；缺省首项。 */
  initialFocus?: 'first' | 'last';
}) {
  const { open, anchor, profileState, onClose, onAction, initialFocus = 'first' } = props;
  const { t } = useTranslation();
  const { profile, avatarUrl, refresh } = useHrOaProfile();
  const settingsShortcut = useAppShortcutDisplay('open-settings');
  const menuRef = useRef<HTMLDivElement>(null);
  /** 焦点归还目标：开层瞬间持有焦点的个人入口（Esc / 选中项后归还）。 */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const openedRef = useRef(false);

  // 开层一次性收口（FR-MENU-01 / FR-PROFILE-07 R5）：记焦点归还目标、收结果提示、
  // stale 后台刷新、初始焦点（第 1 个可用项；获取失败时为「重试」；↑ 开层为末项）。
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && !menuRef.current?.contains(active) ? active : null;
    toast.dismissAll();
    if (isProfileStale()) void refresh('stale');
    const items = menuRef.current ? menuItemsIn(menuRef.current) : [];
    const target = initialFocus === 'last' ? items[items.length - 1] : items[0];
    target?.focus();
  }, [open, initialFocus, refresh]);

  // 点外部收起且不移焦（原型 outside pointerdown）；点在入口上留给入口的开/收语义。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (returnFocusRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, onClose]);

  // 状态面原位更新、焦点不动（PRD §5.6 状态矩阵）；但焦点所在的项被切换移除
  // （如「重试」在落定后消失）时把焦点接回第 1 个可用项（原型 ensurePopFocus）。
  useEffect(() => {
    if (!open || !openedRef.current) return;
    const root = menuRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && root.contains(active)) return;
    menuItemsIn(root)[0]?.focus();
  }, [open, profileState]);

  const close = (returnFocus: boolean): void => {
    onClose();
    if (returnFocus) returnFocusRef.current?.focus();
  };

  const select = (item: ProfileMenuItem): void => {
    // 选任一菜单项 = 收起 + 焦点还给入口（原型 closePop(true)），再交宿主动作。
    close(true);
    onAction(item);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const root = menuRef.current;
    if (!root) return;
    const items = menuItemsIn(root);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const n = items.length;
    let next = -1;
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % n;
    else if (event.key === 'ArrowUp') next = current < 0 ? n - 1 : (current - 1 + n) % n;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = n - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    } else if (event.key === 'Tab') {
      // Tab/Shift+Tab 关闭并按顺序移走（原型 stageFocusables）：前进 = 入口之后
      // 下一个可聚焦元素（无则回首）；后退 = 入口本身。不跟弹层内部焦点走。
      event.preventDefault();
      close(false);
      const entry = returnFocusRef.current;
      if (!entry) return;
      if (event.shiftKey) {
        entry.focus();
        return;
      }
      const list = tabbablesOutside(root);
      const index = list.indexOf(entry);
      (list[index + 1] ?? list[0] ?? entry).focus();
      return;
    } else {
      return;
    }
    event.preventDefault();
    items[next]?.focus();
  };

  // 身份卡「重试」→ `refresh('retry')`（FR-PROFILE-05；按钮态由 ProfileCard 收口）。
  const onRetry = useMemo(() => () => refresh('retry'), [refresh]);

  if (!open) return null;

  const menuLabel = t('titleBar.menu');
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={menuLabel}
      onKeyDown={onKeyDown}
      className={cn(
        // 14px 圆角 = §5 登记形状 `hrbuddy-profile-menu`（PRD `.profile-pop` 版式）；
        // 阴影 / 底 / 描边 / 行文字与「更多」浮层同一套共享菜单表面（DESIGN §4）。
        'fixed z-50 overflow-y-auto rounded-[14px]',
        'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
        'p-1.5 text-[var(--cmd-palette-item-text)] shadow-[shadow:var(--shadow-menu)]',
      )}
      style={{
        left: anchor?.left ?? 0,
        // 原型 `bottom: calc(100% + 6px)`（相对入口）→ fixed 换算：底边在入口顶边
        // 上方 6px。开层时按当前窗高取值（弹层为瞬态浮层，不在开合期间跟随 resize
        // 重锚；重开即重算）。
        bottom: window.innerHeight - (anchor?.top ?? 0) + 6,
        width: 264,
        // 最大高度 = 窗口高度 − 72px，超出本层内部滚动（FR-MENU-01）。
        maxHeight: window.innerHeight - 72,
        transformOrigin: 'bottom left',
      }}
    >
      <ProfileCard profile={profile} state={profileState} onRetry={onRetry} avatarUrl={avatarUrl} />
      <div role="separator" className="-mx-1.5 my-1 h-px bg-[var(--cmd-palette-border)]" />
      {PROFILE_MENU_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            aria-keyshortcuts={item.id === 'settings' ? 'Meta+Comma' : undefined}
            onClick={() => select(item.id)}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left',
              'text-14 leading-[1.43] text-[var(--cmd-palette-item-text)]',
              'transition-[background-color,font-weight] duration-[var(--motion-instant)] ease-[var(--motion-ease-out)]',
              'hover:bg-[var(--sidebar-item-hover)] focus-visible:bg-[var(--sidebar-item-hover)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            )}
          >
            <Icon size={16} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
            {/* 设置右侧快捷键提示（FR-MENU-02）；跟随改绑/平台格式化（mac ⌘,）。 */}
            {item.id === 'settings' && settingsShortcut ? (
              <kbd className="ml-auto pl-4 text-12 font-normal leading-[1.33] text-[var(--cmd-palette-item-meta)]">
                {settingsShortcut}
              </kbd>
            ) : null}
          </button>
        );
      })}
      <div role="separator" className="-mx-1.5 my-1 h-px bg-[var(--cmd-palette-border)]" />
      <button
        type="button"
        role="menuitem"
        onClick={() => select('logout')}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left',
          'text-14 leading-[1.43] text-[var(--error-fg)]',
          'transition-[background-color,font-weight] duration-[var(--motion-instant)] ease-[var(--motion-ease-out)]',
          'hover:bg-[var(--sidebar-item-hover)] focus-visible:bg-[var(--sidebar-item-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        )}
      >
        <LogOut size={16} strokeWidth={1.8} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t(PROFILE_MENU_LOGOUT_LABEL_KEY)}</span>
      </button>
    </div>,
    document.body,
  );
}
