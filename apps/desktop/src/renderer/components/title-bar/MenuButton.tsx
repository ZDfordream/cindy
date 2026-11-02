/**
 * MenuButton — 标题栏 ≡（应用内菜单）。
 *
 * **≡ 已下线（profile-menu PRD FR-MENU-08 / D2，藏不删）**：菜单项已迁入侧栏
 * 个人弹层（`features/hr-oa-profile/ProfileMenu`，§6.2 迁移对照表），HR 模式下
 * 标题栏不再挂本按钮——挂载位 `ChromeActions` 随 Cindy 账号层的
 * `SHOW_CINDY_ACCOUNT_UI` 一起收起（legacyVisibility 单一恢复开关；恢复 ≡ 翻开关
 * 即回，不重接线）。本文件保留全部原实现作恢复面；其挂载的共享任务轮询与
 * 「已结束」提示已随 ≡ 下线上移至 ChromeActions（与 ≡ 可见性无关）。
 * 菜单项常量（文案 key）以 `ProfileMenu` 的 `PROFILE_MENU_ITEMS` 为准（埋点复用）。
 */
import { Menu } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { checkForUpdateWithToast } from '@/lib/checkForUpdateWithToast';
import { createLogger } from '@/lib/logger';

const log = createLogger('MenuButton');
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';

export function MenuButton({ onExitFullscreen }: { onExitFullscreen?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Tip text={t('titleBar.menu')} side="bottom" controlledOpen={menuOpen ? false : undefined}>
          {/* 尺寸与 ChromeActions 的折叠按钮同规格(h-7 / 图标 15 / rounded-md),
              与折叠态标题行图标(「…」h-7 / 15)视觉重量一致。 */}
          <button
            className={cn(
              'flex items-center justify-center',
              'h-7 w-7 rounded-md',
              'text-titlebar-icon',
              'transition-colors',
              'hover:bg-titlebar-button-hover',
              'focus-visible:outline-none',
            )}
            aria-label={t('titleBar.menu')}
          >
            <Menu size={15} />
          </button>
        </Tip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {onExitFullscreen && (
          <DropdownMenuItem onSelect={onExitFullscreen}>
            {t('contentHeader.exitFullscreen')}
          </DropdownMenuItem>
        )}
        {/* 设置入口:Windows / Linux 没有原生应用菜单(installApplicationMenu 非
            darwin 直接置 null),macOS「设置…」菜单项在这些平台不可见;侧栏底部
            用户卡片虽可进设置但无可见「设置」标识,可发现性不足(#1881)。此处
            常驻应用内左上角菜单,与 MainLayout 'open-settings' 命令同一判定
            (pathname + search,见 MainLayout currentPathRef):已在设置默认页时
            不重复导航;在 /settings?tab=xxx 子页时回到设置默认页,与 macOS 原生
            菜单「设置…」行为一致。 */}
        <DropdownMenuItem
          onSelect={() => {
            log.info('Settings clicked');
            if (`${location.pathname}${location.search}` !== '/settings') {
              navigate('/settings');
            }
          }}
        >
          {t('titleBar.menuItems.settings')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void window.electronAPI.resourceUsageWindow
              .open()
              .catch((err: unknown) => {
                log.error('Failed to open resource usage window', err);
              });
          }}
        >
          {t('titleBar.menuItems.resourceUsage')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            log.info('Help clicked');
            navigate('/settings?tab=help');
          }}
        >
          {t('titleBar.menuItems.help')}
        </DropdownMenuItem>
        {/* Issue 页入口:与 macOS 系统菜单「帮助 → 问题反馈」等价,但此处常驻应用内左上角
            菜单,Windows / Linux(无系统菜单)也能访问 —— 否则非 mac 平台无可见入口。
            navigate('/issues') 与 MainLayout 的 'open-issues' 系统菜单命令同一行为。

            标签**刻意不是术语**「Issue」:菜单项回答的是「点这里能干什么」,而它的邻居
            全是动作短语(帮助 / 检查更新);夹一个英文名词既断了风格,也让不熟悉 GitHub
            的用户不知道该不该点。术语裁决(i18n/GLOSSARY.md)管的是指代那类对象的位置
            —— 页面标题与正文仍写 Issue,因为点进去就跳 GitHub,名字必须对得上。 */}
        <DropdownMenuItem
          onSelect={() => {
            log.info('Issues clicked');
            navigate('/issues');
          }}
        >
          {t('titleBar.menuItems.issues')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => { void checkForUpdateWithToast(t); }}
        >
          {t('titleBar.menuItems.checkForUpdates')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
