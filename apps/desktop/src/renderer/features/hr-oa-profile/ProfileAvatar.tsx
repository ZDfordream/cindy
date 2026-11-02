/**
 * ProfileAvatar — 个人头像 + 首字/人形兜底（FR-PROFILE-02，PRD §8.1 首字规则）。
 *
 * 三层结构（T18「头像图片加载完成后再淡入」）：品牌蓝/灰底兜底恒在下层，图片就绪后
 * 淡入覆盖；图片失败退回兜底（SC-4）。兜底色走语义 token（`--hr-oa-fallback-bg` /
 * `--hr-oa-fallback-empty`，PRD §10.1 新增色板的登记态），Light / Dark 双模式同源。
 */

import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { PersonProfile } from '../../../main/hr-oa/profile';

/**
 * 首字规则（PRD §8.1）：去首尾空白后按 **Unicode 码点**取第 1 个字符（不拆代理对）；
 * 拉丁字母转大写；复姓只取第 1 个字；姓名为空返回 `''`（调用方切人形图标）。
 */
export function profileInitialChar(name: string): string {
  const first = Array.from(String(name ?? '').trim())[0] ?? '';
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

export function ProfileAvatar(props: {
  size: 28 | 44;
  profile: PersonProfile | null;
  src?: string | null;
}) {
  const { size, profile, src } = props;
  const [imageFailed, setImageFailed] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const name = (profile?.name ?? '').trim();

  // 换图（含失败后重试）时重置装载态：新地址必须有机会重新淡入，不得停在旧失败。
  useEffect(() => {
    setImageFailed(false);
    setImageLoaded(false);
  }, [src]);

  const initial = profileInitialChar(name);
  const hasImage = Boolean(src) && !imageFailed;

  return (
    <span
      className={cn(
        'relative shrink-0 overflow-hidden rounded-full',
        size === 28 ? 'h-7 w-7' : 'h-11 w-11',
      )}
    >
      {name ? (
        <span
          aria-hidden="true"
          className={cn(
            'absolute inset-0 flex items-center justify-center rounded-full',
            // 品牌蓝圆底 + 白色首字（FR-PROFILE-02 / 集成设计 §4.1；两模式同值）。
            'bg-[var(--hr-oa-fallback-bg)] font-semibold text-white',
            size === 28 ? 'text-12' : 'text-16',
          )}
        >
          {initial}
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center rounded-full bg-[var(--hr-oa-fallback-empty)] text-[var(--text-secondary)]"
        >
          <UserRound size={size === 28 ? 15 : 20} strokeWidth={1.75} />
        </span>
      )}
      {hasImage ? (
        <img
          src={src ?? undefined}
          alt=""
          className={cn(
            'absolute inset-0 h-full w-full rounded-full object-cover transition-opacity',
            'duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]',
            imageLoaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => setImageLoaded(true)}
          onError={() => setImageFailed(true)}
        />
      ) : null}
    </span>
  );
}
