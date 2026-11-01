/**
 * homeOnboardingGate —— S4 两态首页的补配门禁（login-onboarding PRD §6.4）。
 *
 * 两态判据**必须**带 `hydrated`（`homeGatePhaseOf`）：条目表未加载完时 `entries` 的
 * `[]` 只是「还没读到」，不是「没有模型」——直接拿 `entries.length === 0` 判未配置
 * 会复发已修的发送门禁冷启动竞态（785f582125）。
 *
 * 四个门禁入口共用**一处** `gate(trigger)`（发送 / 模型选择器 / 推荐问题 / 横幅
 * 「去配置」，PRD §8.1「跳过后再次门禁」）：
 * - `unconfigured`：打开添加模型弹窗（origin=home）并回 true（原动作不执行，输入保留）；
 * - `loading`：静默等待、不开弹窗、回 true（绝不拿空表判「零来源」）；
 * - 已打开：防重入（PRD §9.6），回 true；
 * - `configured`：回 false（原动作照常）。
 *
 * 宿主合同（Task 5 deferred minor）：保存成功尾 `OnboardingModelDialog` 会**既**回
 * `onSaved(id)` **又**回 `onClose()`。两个回调都只表示「弹窗结束」——`onSaved` 先落
 * `lastSaveRef` 记账，`onClose` 读完再清；绝不能把 `onClose` 当「用户放弃配置」。
 * 横幅折叠 / 圆点变绿**不靠回调分支**：同在一个 `ModelGatewayProvider` 实例里，
 * 落库翻转 `entries` 即驱动两态翻转（T5/T8）。
 *
 * 弹窗打开期间首页 `inert` + `aria-hidden`（PRD §8.3），关闭即撤；关闭后焦点回到
 * 开启前的活动元素（触发按钮或输入框，PRD §8.3「焦点回到触发元素或输入框」）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { OnboardingModelDialog } from './OnboardingModelDialog';
import { useModelGateway } from './ModelGatewayStore';

/** 门禁触发入口（`home_gate_trigger` 埋点的 trigger 维度，PRD §10.2）。 */
export type HomeGateTrigger = 'send' | 'selector' | 'suggestion' | 'banner';

/**
 * 首页两态 + 加载窗口（PRD §6.4 状态矩阵）：
 * `loading` = 条目表还没 hydrate；`unconfigured` = S4b；`configured` = S4a。
 */
export type HomeGatePhase = 'loading' | 'unconfigured' | 'configured';

/** 两态判据（**必须**带 hydrated，见文件头注）。 */
export function homeGatePhaseOf(
  entries: readonly { id: string }[],
  hydrated: boolean,
): HomeGatePhase {
  if (!hydrated) return 'loading';
  return entries.length > 0 ? 'configured' : 'unconfigured';
}

/** 首页门禁面（`ChatInput` / `ChatModelMenu` / 推荐问题 / 横幅共用这一份）。 */
export interface HomeGateSurface {
  phase: HomeGatePhase;
  /** 统一门禁入口；true = 已被门禁消费（开弹窗 / 静默等待 / 防重入），原动作不执行。 */
  gate(trigger: HomeGateTrigger): boolean;
  /** 无条件打开补配弹窗（横幅 / 引导卡等明确的「去配置」动作用；同样防重入）。 */
  openDialog(trigger: HomeGateTrigger): void;
}

const HomeGateContext = createContext<HomeGateSurface | null>(null);

/** 读当前面的门禁（不在门禁面内时为 null = 该面不设门禁，行为不变）。 */
export function useHomeGateSurface(): HomeGateSurface | null {
  return useContext(HomeGateContext);
}

/**
 * 推荐问题的「填入 + 门禁」共用链（S4a 填入不发送；S4b 填入并开补配弹窗）。
 * 首页建议入口（内置 4 条 + 插件建议）都走这一处，不各自复制门禁。
 */
export function applyHomeSuggestion(
  surface: HomeGateSurface | null,
  fill: (prompt: string) => void,
  prompt: string,
): void {
  fill(prompt);
  surface?.gate('suggestion');
}

/** `home_gate_trigger` 的单一触发点（Task 8 接 sink；trigger 维度在此收口）。 */
export function trackHomeGateTrigger(trigger: HomeGateTrigger): void {
  // TODO(Task 8): 接埋点 sink（PRD §10.2 home_gate_trigger，属性 trigger）。
  void trigger;
}

/**
 * 弹窗结束的单一触发点（Task 8 接 sink）：`savedId` 非空 = 本次结束带保存成功
 * （home_view(entry=save)），空 = 用户关闭（model_dialog_skip 一类）。
 */
export function trackHomeGateDialogClosed(savedId: string | null): void {
  // TODO(Task 8): 接埋点 sink（PRD §10.2 home_view.entry / model_dialog_skip）。
  void savedId;
}

export function HomeOnboardingGateProvider(props: { children?: ReactNode }) {
  const { entries, hydrated } = useModelGateway();
  const phase = useMemo(() => homeGatePhaseOf(entries, hydrated), [entries, hydrated]);
  const [dialogOpen, setDialogOpen] = useState(false);
  // 开弹窗前的活动元素：关闭后归还焦点（触发按钮或输入框，PRD §8.3）。
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Task 5 合同（deferred minor）：保存成功尾既回 onSaved(id) 又回 onClose()。
  // onSaved 先落账、onClose 读出再清——「弹窗结束」不等于「用户放弃配置」。
  const lastSaveRef = useRef<string | null>(null);

  const openDialog = useCallback(
    (trigger: HomeGateTrigger) => {
      if (dialogOpen) return; // 防重入（PRD §9.6）：已开时不二次触发。
      const active = document.activeElement;
      restoreFocusRef.current =
        active instanceof HTMLElement && active !== document.body && active !== document.documentElement
          ? active
          : null;
      trackHomeGateTrigger(trigger);
      setDialogOpen(true);
    },
    [dialogOpen],
  );

  const gate = useCallback(
    (trigger: HomeGateTrigger): boolean => {
      if (dialogOpen) return true;
      if (phase === 'loading') return true; // 静默等待（Review Focus #5）。
      if (phase === 'unconfigured') {
        openDialog(trigger);
        return true;
      }
      return false;
    },
    [dialogOpen, openDialog, phase],
  );

  const handleSaved = useCallback((id: string) => {
    // 成功尾先回 onSaved 再回 onClose：这里只记账 + 关窗，视觉由 entries 翻转驱动。
    lastSaveRef.current = id;
    setDialogOpen(false);
  }, []);

  const handleClose = useCallback(() => {
    // 读出「本次结束是否带保存」再清账（保存成功与用户关闭都走这里）：savedId 交
    // trackHomeGateDialogClosed 收口；两种结局都只关窗——不得把 onClose 当用户放弃
    // （放弃也保留输入、不重开、不回退两态）。
    const savedId = lastSaveRef.current;
    lastSaveRef.current = null;
    trackHomeGateDialogClosed(savedId);
    setDialogOpen(false);
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (target?.isConnected) target.focus();
  }, []);

  const handleSkipped = useCallback(() => {
    // origin=home 没有跳过出口（onSkipped 不会触发）；保留回调占位以满足弹窗合同。
    setDialogOpen(false);
  }, []);

  const surface = useMemo<HomeGateSurface>(
    () => ({ phase, gate, openDialog }),
    [phase, gate, openDialog],
  );

  return (
    <HomeGateContext.Provider value={surface}>
      {/* 首页内容面：弹窗打开期间整体 inert + aria-hidden（PRD §8.3）。
          display:contents 不参与布局（挂载方的 flex / 高度链不受包裹影响）。 */}
      <div
        data-testid="home-onboarding-surface"
        style={{ display: 'contents' }}
        inert={dialogOpen || undefined}
        aria-hidden={dialogOpen || undefined}
      >
        {props.children}
      </div>
      <OnboardingModelDialog
        open={dialogOpen}
        origin="home"
        onSkipped={handleSkipped}
        onSaved={handleSaved}
        onClose={handleClose}
      />
    </HomeGateContext.Provider>
  );
}

