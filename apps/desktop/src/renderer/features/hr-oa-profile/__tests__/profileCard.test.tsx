// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`ProfileCard`（弹层身份卡，FR-PROFILE-03/05/06）——纯展示
 *   组件，props 由宿主（Task 4 的 ProfileMenu）供给。断言用户可观察的身份卡合同：
 *   44px 头像 + 姓名（2 行截断 + 悬停完整提示）+「部门 · 岗位」（单项省略连接符、
 *   双空隐藏）+ `登录名` 行 + `邮箱` 行（空隐藏）；`refresh-error` 显示
 *   「信息更新失败 · 重试」；`error` 显示「未获取到信息 / 个人信息获取失败，请稍后
 *   重试 / 重试」；loading 4 条骨架 + 读屏「正在获取个人信息」；重试请求中按钮变
 *   「重试中…」（FR-PROFILE-05）。
 * - Bug／规则依据：profile-menu PRD FR-PROFILE-03/05/06、§8 字段展示规则、§8.2 截断
 *   规则、SC-5/SC-7；**Review Focus #4 / 集成设计 §4.1（OQ-3 裁决）**：`login_name` 是
 *   OA 登录名不是工号，标签必须是「登录名」，出现「工号」即红线违约；隐私红线（PRD
 *   §7.2 / FR-PROFILE-09）：`mobile` / `sex` 绝不展示。
 * - 现有覆盖缺口：身份卡是新组件，仓内无任何身份卡/个人资料展示测试；此文件是
 *   「登录名 ≠ 工号」标签红线与 mobile/sex 不展示红线的唯一回归哨。
 * - 最小失败输入：标签渲染成「工号」即失败；profile 带 mobile/sex 而界面出现其值即
 *   失败；dept 与 title 双空仍渲染连接符行即失败；邮箱空仍渲染邮箱行即失败；
 *   refresh-error 无「信息更新失败」/「重试」即失败；点击重试不调 onRetry 即失败。
 * - tier：unit（jsdom + RTL，纯 props 驱动，无 IPC / 网络 / 计时等待）。
 * - 实测耗时：单文件墙钟约 1.8s（vitest Duration 138ms，9 例）。
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import type { PersonProfile } from '../../../../main/hr-oa/profile';
import { ProfileCard } from '../ProfileCard';

function makeProfile(over: Partial<PersonProfile> = {}): PersonProfile {
  return {
    name: '张三',
    loginName: 'YLS',
    dept: '人力资源部',
    mobile: '13800000000',
    email: 'zhangsan@example.com',
    title: '专员',
    sex: '男',
    personId: 'p-1',
    ...over,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
});

afterEach(cleanup);

describe('ProfileCard · 字段行与截断（FR-PROFILE-03/06，§8）', () => {
  it('「部门 · 岗位」：双字段用「 · 」连接；单项省略连接符；双空隐藏该行', () => {
    const { unmount } = render(
      <ProfileCard profile={makeProfile()} state="ready" onRetry={() => {}} />,
    );
    expect(screen.getByText('人力资源部 · 专员')).toBeTruthy();
    unmount();

    render(<ProfileCard profile={makeProfile({ title: '' })} state="ready" onRetry={() => {}} />);
    expect(screen.getByText('人力资源部')).toBeTruthy();
    expect(screen.queryByText(/·/)).toBeNull();

    cleanup();
    render(
      <ProfileCard profile={makeProfile({ dept: '', title: '' })} state="ready" onRetry={() => {}} />,
    );
    // 双空隐藏：不留空行、更不能渲染出孤立连接符。
    expect(screen.queryByText(/·/)).toBeNull();
    expect(screen.queryByText('人力资源部')).toBeNull();
    expect(screen.queryByText('专员')).toBeNull();
  });

  it('邮箱行有值显示、为空隐藏（§8 为空时隐藏该行）', () => {
    const { unmount } = render(
      <ProfileCard profile={makeProfile()} state="ready" onRetry={() => {}} />,
    );
    expect(screen.getByText('zhangsan@example.com')).toBeTruthy();
    unmount();

    render(<ProfileCard profile={makeProfile({ email: '' })} state="ready" onRetry={() => {}} />);
    expect(screen.queryByText('邮箱')).toBeNull();
    expect(screen.queryByText('zhangsan@example.com')).toBeNull();
  });

  it('姓名截断提示（SC-7）：title 为完整姓名；邮箱单行省略（§8.2）', () => {
    const longName = '欧阳锋锋锋锋锋锋锋锋锋锋锋';
    render(
      <ProfileCard
        profile={makeProfile({ name: longName })}
        state="ready"
        onRetry={() => {}}
      />,
    );
    // 姓名同时有可见层（p）与读屏全文层（sr-only aria-describedby 目标），按可见层取。
    const name = screen.getByText(longName, { selector: 'p' });
    // 悬停完整提示 = title 全文；2 行 clamp（§8.2 多行 -webkit-line-clamp: 2）。
    expect(name.getAttribute('title')).toBe(longName);
    expect(name.className).toContain('line-clamp-2');
    // 邮箱 / 部门行 1 行省略。
    const email = screen.getByText('zhangsan@example.com');
    expect(email.className).toContain('truncate');
    const sub = screen.getByText('人力资源部 · 专员');
    expect(sub.className).toContain('truncate');
  });
});

describe('ProfileCard · 登录名不是工号（Review Focus #4）+ 隐私红线', () => {
  it('显示「登录名」标签与 login_name 值，绝不显示「工号」；mobile/sex 不出现', () => {
    render(
      <ProfileCard
        profile={makeProfile({ mobile: '13800000000', sex: '男' })}
        state="ready"
        onRetry={() => {}}
      />,
    );

    // 标签红线：login_name 是 OA 登录名（实测如 YLS），不是工号（OQ-3 裁决）。
    expect(screen.getByText('登录名')).toBeTruthy();
    expect(screen.getByText('YLS')).toBeTruthy();
    expect(screen.queryByText('工号')).toBeNull();

    // 隐私红线（PRD §7.2 / FR-PROFILE-09）：手机号与性别绝不展示。
    expect(screen.queryByText('13800000000')).toBeNull();
    expect(screen.queryByText('男')).toBeNull();
    expect(screen.queryByText('女')).toBeNull();
  });
});

describe('ProfileCard · 状态面（FR-PROFILE-04/05）', () => {
  it('loading：4 条骨架 + 读屏「正在获取个人信息」（FR-PROFILE-04）', () => {
    render(<ProfileCard profile={null} state="loading" onRetry={() => {}} />);
    expect(screen.getByText('正在获取个人信息')).toBeTruthy();
    // 身份卡骨架 = 44px 圆 + 4 条（FR-PROFILE-04）；条数是加载态的可观察结构。
    expect(screen.getAllByTestId('profile-card-skeleton-bar')).toHaveLength(4);
  });

  it('refresh-error：缓存资料 + 「信息更新失败」与「重试」（FR-PROFILE-05）', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ProfileCard profile={makeProfile()} state="refresh-error" onRetry={onRetry} />);

    // 有缓存：继续显示缓存资料（可见姓名层，读屏全文层另存 sr-only）。
    expect(screen.getByText('张三', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('登录名')).toBeTruthy();
    expect(screen.getByText('信息更新失败')).toBeTruthy();

    const retry = screen.getByRole('menuitem', { name: '重试' });
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('重试请求中按钮显示「重试中…」，请求落定后回「重试」（FR-PROFILE-05）', async () => {
    const user = userEvent.setup();
    let resolveRetry!: () => void;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveRetry = r;
        }),
    );
    render(<ProfileCard profile={makeProfile()} state="refresh-error" onRetry={onRetry} />);
    await user.click(screen.getByRole('menuitem', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('menuitem', { name: '重试中…' })).toBeTruthy();

    // 同一失败态再落定（state 未变）也必须回「重试」，不得卡在「重试中…」。
    resolveRetry();
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: '重试' })).toBeTruthy();
    });
  });

  it('error（无缓存）：「未获取到信息 / 个人信息获取失败，请稍后重试 / 重试」', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ProfileCard profile={null} state="error" onRetry={onRetry} />);

    expect(screen.getByText('未获取到信息')).toBeTruthy();
    expect(screen.getByText('个人信息获取失败，请稍后重试')).toBeTruthy();
    // 失败初始焦点目标是「重试」（PRD §5.4 错误态初始焦点在重试）。
    const retry = screen.getByRole('menuitem', { name: '重试' });
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('44px 头像（FR-PROFILE-03 布局契约：h-11）', () => {
    render(<ProfileCard profile={makeProfile()} state="ready" onRetry={() => {}} />);
    const avatar = [...document.querySelectorAll('*')].find((el) =>
      el.className?.includes?.('h-11 w-11'),
    );
    expect(avatar).toBeTruthy();
  });
});
