/**
 * Tooltip — shadcn/ui new-york 风格封装，基于 @radix-ui/react-tooltip。
 *
 * 用途：F-PJ-7 — Project 名 / Session 标题 / Toggle 按钮 hover 后显示完整路径或标题。
 *
 * 规格（prod_spec ccagent-projects-sidebar V1.7 F-PJ-7）：
 *   - delayDuration 500ms
 *   - 圆角 12（项目"非交互容器"统一规格）
 *   - 字号 13 / JetBrains Mono（用于路径展示）
 *   - 跨平台一致：用 Radix 而非原生 title，避免浏览器/系统差异
 *
 * 用法：
 *   <Tooltip.Provider>            // 顶层包裹一次
 *     <Tooltip.Root>
 *       <Tooltip.Trigger asChild>...</Tooltip.Trigger>
 *       <Tooltip.Content>...</Tooltip.Content>
 *     </Tooltip.Root>
 *   </Tooltip.Provider>
 */

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from '@/lib/utils';

// 全局默认 delayDuration（F-PJ-7 规格 500ms）—— 调用方可在 Provider 上覆盖
// disableHoverableContent=true:鼠标离开 trigger 立即关闭,不允许移到 tip 内容
// 上"接住"它继续保持打开。我们所有 Tip 用法都是纯文本 label,没有需要 hover
// 交互的内容(链接 / 按钮),关掉这个对可访问性零成本,而开着会让用户感觉
// "tip 在按钮已经移开后还赖在屏幕上" —— 多次验收反馈的视觉延迟根因。
const TooltipProvider = ({
  delayDuration = 500,
  skipDelayDuration = 200,
  disableHoverableContent = true,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider
    delayDuration={delayDuration}
    skipDelayDuration={skipDelayDuration}
    disableHoverableContent={disableHoverableContent}
    {...props}
  />
);

const TooltipRoot = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
    /** 内容字体：mono 用于路径展示（F-PJ-7），sans 用于普通文本（默认） */
    variant?: 'sans' | 'mono';
  }
>(({ className, side = 'top', sideOffset = 6, variant = 'sans', ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      side={side}
      sideOffset={sideOffset}
      className={cn(
        // F-PJ-7 视觉规格：12px 圆角 / 13px 文本 / 8px×10px 内边距
        // select-none:tooltip 是 hover 提示 chrome,role="tooltip" 不在
        // globals.css 的全局禁选名单里,不加会让全 app 提示文字可被划选。
        'z-[60] select-none rounded-xl px-2.5 py-1.5 text-13 leading-snug shadow-lg',
        // Cindy tooltip 两模式都是深底白字；Board 浅描边叠在深底上会看成一圈白边。
        'border border-transparent bg-[var(--tooltip-bg)] text-[var(--tooltip-text)]',
        'max-w-[420px] break-all', // 长路径允许任意位置截断换行
        variant === 'mono' && 'font-mono',
        // 入场/出场动画:tooltip 是信息不是对象,入场纯 opacity 不缩放,
        // 退场走轻浮层统一的 float-out(--motion-instant)。
        // 注意 Radix Tooltip 的 data-state 是 delayed-open / instant-open /
        // closed(没有 "open"),所以入场直接挂 mount 动画,closed 态靠更高
        // 特异性的规则覆盖成退场动画。
        'animate-fade-in data-[state=closed]:animate-float-out',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export const Tooltip = {
  Provider: TooltipProvider,
  Root: TooltipRoot,
  Trigger: TooltipTrigger,
  Content: TooltipContent,
};

// ── <Tip> ───────────────────────────────────────────────────────────────────
// 一行包装,替代浏览器原生 title 属性。内部自带 Provider,任何位置都能直接用。
//
// 用法:
//   <Tip text="提示文案"><button>...</button></Tip>
//   <Tip text={longPath} mono><span>...</span></Tip>          // 长路径用 mono 字体
//   <Tip text="..." side="bottom" delay={200}>...</Tip>      // 自定义方位/延迟
//   <Tip text={maybeNull}>...</Tip>                          // text 为空时直接渲染 children,不挂 tooltip
//   <Tip text="..." forceOpen>...</Tip>                       // 由调用方强制展示
//   <Tip text="..." controlledOpen={false}>...</Tip>          // 由调用方强制关闭
//   <Tip text="..." controlledOpen={menuOpen ? false : undefined}>...</Tip>
//     // 菜单/弹层触发面标准写法:弹层打开期间强制关闭,并进入 TT-10 抑制窗
//
// children 必须是单个能接受 ref + onMouseEnter/Leave 等事件的元素(button / a / div / span / 自定义 forwardRef 组件)。
// 普通文本节点请先包一层 <span>。
//
// ── 复合 trigger 场景 ──
// 用在其他 asChild Trigger(Popover / Dropdown 等)内部时,把 Tip 当作 children 传入即可:
//   <PopoverTrigger asChild>
//     <Tip text="..."><button>...</button></Tip>
//   </PopoverTrigger>
// Tip 是 forwardRef + 透传 props,会把外层 Trigger 注入的 ref/事件正确合并给 button。
//
// ── BUG-TOOLTIP-01 提示生命周期(PRD §6.5 TT-01~TT-12) ─────────────────────
// 全部图标提示统一遵守(回归用例 __tests__/tooltipLifecycle.test.tsx,不埋点):
//   TT-01  指针悬停 500ms 后出现(Provider delayDuration 500,delay 可覆盖)
//   TT-02  Tab 聚焦后出现(focus 即开)
//   TT-03  指针离开 → 立即消失
//   TT-04  按下 → 立即消失
//   TT-05  点击 → 立即消失
//   TT-06  Esc → 立即消失
//   TT-07  窗口失焦 → 立即消失,切回不自动恢复,指针重新移入才恢复
//   TT-08  滚动(任意滚动容器)→ 立即消失
//   TT-09  菜单打开 → 立即消失(调用方以 controlledOpen={false} 标记弹层打开)
//   TT-10  菜单关闭后焦点回到图标 → 不再出现(受迫关闭后的抑制窗,指针移入才解除)
//   TT-11  300ms 内移到相邻图标 → 立即显示,不重新计时(跨 Tip 共享 skip 窗口)
//   TT-12  未悬停时不得常驻

export interface TipProps {
  /** 提示文案;为 null/undefined/空字符串时直接渲染 children,不挂 tooltip */
  text: React.ReactNode | null | undefined;
  children: React.ReactElement;
  /** 字体:mono 用于路径/命令展示;sans 默认 */
  mono?: boolean;
  /** 弹出方位,默认 top */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** 延迟显示(ms),默认沿用 Provider 的 500 */
  delay?: number;
  /** 强制禁用,等价于 text 为空 */
  disabled?: boolean;
  /** 强制展示,用于按住、拖拽等不会触发默认 hover 的状态 */
  forceOpen?: boolean;
  /**
   * 受控开关。提供时优先于 forceOpen,用于需要明确关闭 tooltip 的拖拽态。
   * `false` 同时标记「弹层/菜单打开」(TT-09),关闭后进入 TT-10 抑制窗;
   * 菜单触发面标准写法:`controlledOpen={menuOpen ? false : undefined}`。
   */
  controlledOpen?: boolean;
  /** Discard hover requests while temporarily controlled (e.g. recording). */
  resetHoverOnControlChange?: boolean;
  /** 自定义 Content 样式(覆盖默认宽度等) */
  contentClassName?: string;
}

/** TT-11:任意 Tip 关闭后的 300ms 内,其它 Tip 的 hover 立即显示(不重新计时)。 */
const ADJACENT_SKIP_MS = 300;
const skipWindowListeners = new Set<() => void>();

function noteTipClosed(): void {
  for (const listener of skipWindowListeners) listener();
}

type TriggerHandler = ((event: unknown) => void) | undefined;

function chainHandlers(...handlers: TriggerHandler[]) {
  return (event: unknown) => {
    for (const handler of handlers) handler?.(event);
  };
}

// 注意:不写出 React.HTMLAttributes 的具体类型,因为外层 Trigger(Popover/Dropdown 等)
// 注入的 props 形态各异——用 ...rest 直接转发即可,Radix 的 Slot 会正确合并。
// ref 类型用 unknown:外层 Trigger 可能是任何元素(button/span/img 等),Tip 不该限定。
export const Tip = React.forwardRef<unknown, TipProps>(function Tip(props, forwardedRef) {
  const {
    text,
    children,
    mono,
    side = 'top',
    delay,
    disabled,
    forceOpen,
    controlledOpen,
    resetHoverOnControlChange = false,
    contentClassName,
    ...rest
  } = props;
  const isEmpty =
    disabled ||
    text === null ||
    text === undefined ||
    (typeof text === 'string' && text.length === 0);

  // open 一律受控(由 hoverOpen 复刻 hover 驱动),不在受控/非受控间切换——
  // Radix 要求 open 全生命周期同一模式,而 TT-07/08/10 的强制关闭要对所有 Tip
  // 一致生效,必须走同一条受控通道。
  const requestedOpen = controlledOpen ?? (forceOpen ? true : undefined);
  const [hoverOpen, setHoverOpen] = React.useState(false);
  // TT-10 抑制窗:受迫关闭(controlledOpen=false,弹层打开)与窗口失焦后,**focus
  // 来源**的打开请求被忽略——菜单关闭焦点回返、切回窗口都不得把提示叫回来。
  // 解除:指针移入/移动(重新移入意图)或焦点真正离开(保住 TT-02 的 Tab 聚焦出现)。
  const suppressOpenRef = React.useRef(false);
  // 最近一次 trigger 交互来源:用来区分「focus 回返」(TT-10 要挡)与
  // 「新 hover / 合成请求」(要放行,见 voiceTooltipControl 的 handoff 合同)。
  const lastInteractionRef = React.useRef<'pointer' | 'focus' | 'none'>('none');
  const requestedOpenRef = React.useRef(requestedOpen);
  requestedOpenRef.current = requestedOpen;
  if (requestedOpen === false) suppressOpenRef.current = true;

  const open = requestedOpen ?? hoverOpen;

  // TT-11 跨 Tip skip 窗口:Radix 的 skipDelayDuration 只在单个 Provider 内共享,
  // 而每个 Tip 自带 Provider,跨图标无效——用订阅复刻「相邻图标立即显示」。
  const [skipWindow, setSkipWindow] = React.useState(false);
  const skipWindowTimerRef = React.useRef(0);
  React.useEffect(() => {
    const listener = () => {
      setSkipWindow(true);
      window.clearTimeout(skipWindowTimerRef.current);
      skipWindowTimerRef.current = window.setTimeout(() => setSkipWindow(false), ADJACENT_SKIP_MS);
    };
    skipWindowListeners.add(listener);
    return () => {
      skipWindowListeners.delete(listener);
      window.clearTimeout(skipWindowTimerRef.current);
    };
  }, []);

  // 任意关闭路径(离开/按下/失焦/滚动/受迫)都记账 skip 窗口起点。
  const wasOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (wasOpenRef.current && !open) noteTipClosed();
    wasOpenRef.current = open;
  }, [open]);

  React.useLayoutEffect(() => {
    if (resetHoverOnControlChange && requestedOpen !== undefined) setHoverOpen(false);
  }, [resetHoverOnControlChange, requestedOpen]);

  // disabled/空文案 = 不挂 tooltip 树(下方 cloneElement 透明传递)。曾经打开的
  // hover 记忆必须一并清掉:Radix Root 随之卸载重挂,hoverOpen 不清会在宿主把
  // visible 翻回来时原地复弹(BrowserChrome 的「retained-host boundary」合同)。
  React.useLayoutEffect(() => {
    if (isEmpty) {
      setHoverOpen(false);
      suppressOpenRef.current = false;
      lastInteractionRef.current = 'none';
    }
  }, [isEmpty]);

  // TT-07 窗口失焦 / TT-08 滚动:立即消失。滚动监听挂在 window 捕获阶段——
  // Radix 自带的滚动关闭只覆盖「滚动容器包含 trigger」,标题栏图标浮在滚动区之上,
  // 任意滚动都必须关(BUG-TOOLTIP-01)。
  React.useEffect(() => {
    if (!open) return undefined;
    const closeNow = () => setHoverOpen(false);
    const handleWindowBlur = () => {
      suppressOpenRef.current = true;
      setHoverOpen(false);
    };
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('scroll', closeNow, { capture: true, passive: true });
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('scroll', closeNow, { capture: true });
    };
  }, [open]);

  // 没有 tooltip 内容时,Tip 仍要保持"透明传递":把外层 props/ref 直接合并到 children,
  // 避免在复合 trigger 里成为 ref/事件断点。React 18 的 cloneElement 类型签名不接受 ref
  // 在 props 字面量里,需要用 ref 字段单独传。这里用类型断言把它当成附加属性透传。
  if (isEmpty) {
    return React.cloneElement(children, {
      ...rest,
      ref: forwardedRef,
    } as Partial<unknown>);
  }

  const restHandlers = rest as Record<string, TriggerHandler>;
  return (
    <TooltipProvider delayDuration={skipWindow ? 0 : delay}>
      <TooltipRoot open={open} onOpenChange={(next) => {
        if (next) {
          // 受迫关闭期间一律不接受打开请求(TT-09):否则弹层打开期间的 hover/focus
          // 会把 hoverOpen 弄脏,控制交回瞬间提示又冒出来(原始症状)。
          if (requestedOpen === false) return;
          // TT-10:抑制窗内只挡 focus 来源(菜单关闭焦点回返 / 切窗后残留聚焦);
          // 新 hover 与合成请求照常放行(voiceTooltipControl 的 handoff 合同)。
          if (suppressOpenRef.current && lastInteractionRef.current === 'focus') return;
        }
        // A hover callback during forced display must not reopen a different
        // label when control returns to the pointer after recording stops.
        setHoverOpen(resetHoverOnControlChange && requestedOpen !== undefined ? false : next);
      }}>
        <TooltipTrigger
          asChild
          ref={forwardedRef as React.Ref<HTMLButtonElement>}
          {...rest}
          onPointerMove={chainHandlers(restHandlers.onPointerMove, () => {
            lastInteractionRef.current = 'pointer';
            // 指针移入/移动 = 重新移入意图,解除 TT-10 抑制;弹层仍开着时靠
            // requestedOpen===false 继续挡住,菜单关闭后由 Radix 的 hover 锁存
            // 保证不原地复弹,移出再移入才按 500ms 重新计时。
            if (requestedOpenRef.current !== false) suppressOpenRef.current = false;
          })}
          onPointerEnter={chainHandlers(restHandlers.onPointerEnter, () => {
            lastInteractionRef.current = 'pointer';
            if (requestedOpenRef.current !== false) suppressOpenRef.current = false;
          })}
          onPointerLeave={chainHandlers(restHandlers.onPointerLeave, () => {
            // 指针离开 = 本段 hover 结束(TT-03/TT-12)。受迫关闭期间 Radix 的
            // close 通知会被 useControllableState 吞掉(value===prop 不回调),
            // 这里直接清 hover 记忆,否则「移走了提示还常驻」(原始症状)。
            lastInteractionRef.current = 'none';
            setHoverOpen(false);
            if (requestedOpenRef.current !== false) suppressOpenRef.current = false;
          })}
          onPointerDown={chainHandlers(restHandlers.onPointerDown, () => {
            // TT-04 按下即消失。菜单触发面的 pointerdown 会 preventDefault 吞掉
            // Radix 自己的 close,这里直接清 hover 记忆,保证「点击 ≡ 提示消失」
            // 且控制交回后不复弹。
            lastInteractionRef.current = 'pointer';
            setHoverOpen(false);
          })}
          onClick={chainHandlers(restHandlers.onClick, () => {
            // TT-05 点击即消失,同上兜底。
            lastInteractionRef.current = 'pointer';
            setHoverOpen(false);
          })}
          onFocus={chainHandlers(restHandlers.onFocus, () => {
            lastInteractionRef.current = 'focus';
          })}
          onBlur={chainHandlers(restHandlers.onBlur, () => {
            // 焦点真正离开 trigger(且弹层未开)解除抑制,保住 TT-02 的 Tab 再聚焦出现。
            lastInteractionRef.current = 'none';
            if (requestedOpenRef.current !== false) suppressOpenRef.current = false;
          })}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent
          side={side}
          variant={mono ? 'mono' : 'sans'}
          className={contentClassName}
        >
          {text}
        </TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  );
});
Tip.displayName = 'Tip';
