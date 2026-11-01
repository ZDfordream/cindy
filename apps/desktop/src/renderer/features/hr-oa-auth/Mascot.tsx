/**
 * Mascot —— HRBuddy 线框机器猫（PRD FR-WELCOME-01：猫耳、耳机、竖缝眼）。
 *
 * 品牌目录无吉祥物资产，按 PRD 原型自绘内联 SVG（几何对齐原型 160 viewBox）。
 * 颜色全部走语义 token（浅描线 → --border-default、深描线/耳罩弧 → --text-secondary
 * / --text-tertiary、眼与口 → --text-primary、填充 → --surface-elevated /
 * --surface-chip），双模式随主题自然派生，不写死色值。
 *
 * 闲置动效：浮动 3.6s、眨眼 4.2s 循环（PRD §9.3）。`prefers-reduced-motion: reduce`
 * 时**不挂** `hr-oa-mascot-float` / `hr-oa-mascot-blink` 类（FR-WELCOME-01），
 * globals.css 的 reduce 块另做兜底。纯展示、不可点击（PRD 原型 aria-hidden）。
 */

import { useEffect, useId, useState } from 'react';

import { cn } from '@/lib/utils';

export interface MascotProps {
  /** 渲染边长（px，按 viewBox 160 等比）。缺省：hero 150（S1）、card 36（S2 卡片顶）。 */
  size?: number;
  variant: 'hero' | 'card';
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function Mascot(props: MascotProps): React.JSX.Element {
  const { variant } = props;
  const size = props.size ?? (variant === 'hero' ? 150 : 36);
  // 转场期间 S1/S2 可能同时挂载：clipPath id 用 useId 保证唯一（去掉冒号，
  // 免得 url(#…) 片段在个别解析器里吃瘪）。
  const clipId = `hr-oa-mascot-head-${useId().replace(/:/g, '')}`;
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setReducedMotion(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  return (
    <svg
      className={cn('hr-oa-mascot', !reducedMotion && 'hr-oa-mascot-float')}
      viewBox="0 0 160 160"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <ellipse cx="80" cy="88" rx="48" ry="42" />
        </clipPath>
      </defs>
      {/* 猫耳 */}
      <path
        d="M44 62 L36 22 L70 44 Z"
        fill="var(--surface-elevated)"
        stroke="var(--text-tertiary)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M116 62 L124 22 L90 44 Z"
        fill="var(--surface-elevated)"
        stroke="var(--text-tertiary)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M47 52 L42 32" stroke="var(--border-default)" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M113 52 L118 32" stroke="var(--border-default)" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      {/* 头 + 线框网格 */}
      <ellipse cx="80" cy="88" rx="48" ry="42" fill="var(--surface-elevated)" stroke="var(--text-tertiary)" strokeWidth="2" />
      <g
        clipPath={`url(#${clipId})`}
        fill="none"
        stroke="var(--border-default)"
        strokeWidth=".8"
      >
        <ellipse cx="80" cy="88" rx="14" ry="42" />
        <ellipse cx="80" cy="88" rx="28" ry="42" />
        <ellipse cx="80" cy="88" rx="42" ry="42" />
        <ellipse cx="80" cy="70" rx="48" ry="12" />
        <ellipse cx="80" cy="88" rx="48" ry="12" />
        <ellipse cx="80" cy="106" rx="48" ry="12" />
      </g>
      {/* 耳机：头梁 + 两侧耳罩 */}
      <path
        d="M30 84 C30 40 130 40 130 84"
        fill="none"
        stroke="var(--text-secondary)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <rect
        x="22"
        y="76"
        width="14"
        height="30"
        rx="7"
        fill="var(--surface-chip)"
        stroke="var(--text-secondary)"
        strokeWidth="2"
      />
      <rect
        x="124"
        y="76"
        width="14"
        height="30"
        rx="7"
        fill="var(--surface-chip)"
        stroke="var(--text-secondary)"
        strokeWidth="2"
      />
      {/* 竖缝眼（眨眼动效宿主）+ 口 */}
      <g
        className={cn(!reducedMotion && 'hr-oa-mascot-blink')}
        fill="var(--text-primary)"
      >
        <rect x="62" y="76" width="7" height="22" rx="3.5" />
        <rect x="91" y="76" width="7" height="22" rx="3.5" />
      </g>
      <path d="M76 108 q4 4 8 0" fill="none" stroke="var(--text-primary)" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
