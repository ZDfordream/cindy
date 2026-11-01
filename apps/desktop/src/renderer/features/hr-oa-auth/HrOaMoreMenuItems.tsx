/**
 * HrOaMoreMenuItems — 「更多」浮层的 HRBuddy 会话条目（PRD FR-HOME-02 / FR-HOME-03）。
 *
 * 两个条目（PRD 飞层就是这组）：
 * - 「自定义」→ 打开「添加模型」弹窗（origin=home：无跳过按钮、无底部提示）。首页
 *   （S4）在挂时经 `requestHomeCustomizeDialog()` 递给首页宿主，与两态共用同一份
 *   网关条目表（保存成功即入列表并成为当前模型）；首页不在（会话页等）无人认领 →
 *   回落 `HrOaCustomizeFallbackHost` 自带的同一弹窗，关闭回原界面（AC-14）。
 * - 「退出登录」→ `requestHrOaLogout()`（T9 转场回 S1）：**无二次确认**（PRD
 *   FR-HOME-03），清登录态与未发送草稿、保留该账号模型配置，且不弹「登录已过期」。
 *
 * 由 `SidebarTopNav` 的「更多」浮层在 hr 会话下渲染；Cindy 账号层的导航自定义条目
 * 在 hr 会话让位给「自定义」（PRD 侧栏本期导航为占位，「自定义」= 模型配置）。
 *
 * **回落弹窗的挂载位**：条目在 `DropdownMenuContent` 里，菜单关闭时 Radix 会把内容
 * 整棵卸载——回落弹窗**不能**挂在条目的输出里（会随菜单一起消失）。因此回落状态走
 * 模块级小 store，弹窗由 `HrOaCustomizeFallbackHost` 在菜单**外**挂载（同返回树的
 * 兄弟位，随侧栏常驻）。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { LogOut, SlidersHorizontal } from 'lucide-react';

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

import { OnboardingModelDialog } from '../model-gateway/OnboardingModelDialog';
import { ModelGatewayScope } from '../model-gateway/ModelGatewayStore';
import { requestHrOaLogout } from './hrOaAuthStore';
import { requestHomeCustomizeDialog } from './OnboardingSessionHost';

// ── 回落弹窗的模块级开关（菜单内容卸载不丢；宿主见 HrOaCustomizeFallbackHost）────
let fallbackOpen = false;
let fallbackUsed = false;
const fallbackListeners = new Set<() => void>();

// ── 回落宿主注册表（评审 Finding 1）────────────────────────────────────────────
// 「更多」浮层在任务视图下有**两份常驻同挂**（展开 + rail，隐藏的只是 opacity-0
// pointer-events-none，拦不住 portal 到 body 的弹窗），每份菜单各挂一个宿主。
// 弹窗必须全窗单例：注册表选出唯一 active 宿主渲染，其余返回 null；active 卸载
// （菜单/侧栏拆卸）即移交下一个注册者，弹窗不因单个宿主消失而丢失。
const fallbackHostTokens: object[] = [];
let activeFallbackHostToken: object | null = null;

function publishFallback(): void {
  for (const listener of fallbackListeners) listener();
}

function subscribeFallback(listener: () => void): () => void {
  fallbackListeners.add(listener);
  return () => {
    fallbackListeners.delete(listener);
  };
}

function registerFallbackHost(token: object): void {
  fallbackHostTokens.push(token);
  if (activeFallbackHostToken === null) {
    activeFallbackHostToken = token;
    publishFallback();
  }
}

function unregisterFallbackHost(token: object): void {
  const index = fallbackHostTokens.indexOf(token);
  if (index >= 0) fallbackHostTokens.splice(index, 1);
  if (activeFallbackHostToken === token) {
    activeFallbackHostToken = fallbackHostTokens[0] ?? null;
    publishFallback();
  }
}

function openCustomizeFallback(): void {
  fallbackOpen = true;
  fallbackUsed = true;
  publishFallback();
}

function closeCustomizeFallback(): void {
  fallbackOpen = false;
  publishFallback();
}

function fallbackSnapshot(): boolean {
  return fallbackOpen;
}

function fallbackUsedSnapshot(): boolean {
  return fallbackUsed;
}

/**
 * 回落弹窗宿主：挂在「更多」浮层**外**（菜单关闭不随之卸载）。仅在真正回落后
 * 才建 `ModelGatewayScope` store（侧栏常态零成本）；弹窗本体与首页同款
 * `OnboardingModelDialog`（origin=home）。
 *
 * **全窗单例**（注册表）：N 份菜单各挂一个宿主，但只有 active 那份渲染弹窗——
 * 否则展开 + rail 双常驻会叠出两套遮罩 / 两套表单（评审 Finding 1）。
 */
export function HrOaCustomizeFallbackHost() {
  const [token] = useState<object>(() => ({}));
  useEffect(() => {
    registerFallbackHost(token);
    return () => {
      unregisterFallbackHost(token);
    };
  }, [token]);
  const isActiveHost = useSyncExternalStore(
    subscribeFallback,
    () => activeFallbackHostToken === token,
  );
  const open = useSyncExternalStore(subscribeFallback, fallbackSnapshot);
  const used = useSyncExternalStore(subscribeFallback, fallbackUsedSnapshot);
  if (!isActiveHost || !used) return null;
  return (
    <ModelGatewayScope>
      <OnboardingModelDialog
        open={open}
        origin="home"
        onSkipped={closeCustomizeFallback}
        onSaved={closeCustomizeFallback}
        onClose={closeCustomizeFallback}
      />
    </ModelGatewayScope>
  );
}

export function HrOaMoreMenuItems() {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuItem
        onSelect={() => {
          // 首页宿主认领（共享 store，保存即翻两态）；不在首页时走回落宿主。
          if (!requestHomeCustomizeDialog()) openCustomizeFallback();
        }}
        className="gap-2.5"
      >
        <SlidersHorizontal size={16} strokeWidth={1.8} />
        {t('hrOa.more.customize')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="danger"
        onSelect={() => {
          // PRD FR-HOME-03：T9 直接执行，无二次确认。
          void requestHrOaLogout();
        }}
        className="gap-2.5"
      >
        <LogOut size={16} strokeWidth={1.8} />
        {t('hrOa.more.logout')}
      </DropdownMenuItem>
    </>
  );
}
