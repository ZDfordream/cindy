// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：`LoginScreen`（S2 账号密码登录，PRD §6.2 FR-LOGIN-01~06）。
 *   经真实 `useHrOaAuth` → `window.electronAPI.hrOa` 桥调 `hrOa:login`；断言用户可观察的
 *   禁用/只读/焦点/选区/行内错误文案与 500ms 成功停留，以及口令不 trim、账号 trim、
 *   重复提交只发一次 IPC、错误分支各自的清空/保留与焦点回归。
 * - Bug／规则依据：login-onboarding PRD §6.2 FR-LOGIN-02~05 + §9.2 成功停留 500ms；
 *   任务简报 Step 1 用例矩阵；「口令明文不进错误文案/日志」安全底线。
 * - 现有覆盖缺口：S2 是新屏，仓库无任何 hr-oa-auth 测试；相邻 login 测试只覆盖旧
 *   Cindy 登录页（LoginPage/LoginHandoff），不覆盖 OA 账号密码表单。
 * - 最小失败输入：两空字段点「登录」应禁用（旧实现若不禁用即失败）；{error:'wrong_credentials'}
 *   后密码框值应为空且获焦；提交中再提交不应出现第二次 hrOa.login 调用。
 * - tier：unit（进程内 RTL 组件测试，IPC 以 window.electronAPI 桩注入，无真实网络/计时墙钟）。
 * - 实测耗时：单文件墙钟约 2.8s（vitest Duration 2.13s，10 例）
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';
import { LoginScreen } from '../LoginScreen';

const bridge = vi.hoisted(() => ({
  login: vi.fn(),
  logout: vi.fn(),
  getState: vi.fn(),
  onAuthStateChange: vi.fn((_cb: (payload: unknown) => void) => () => {}),
}));

const PROFILE = {
  name: '张三',
  loginName: 'zhangsan',
  dept: '人力资源部',
  mobile: '',
  email: '',
  title: '',
  sex: '男',
  personId: 'P100',
};
const SIGNED_IN = { status: 'signed-in', accountKey: 'P100', profile: PROFILE };

function installBridge(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      hrOa: {
        login: bridge.login,
        logout: bridge.logout,
        getState: bridge.getState,
      },
      onAuthStateChange: bridge.onAuthStateChange,
    },
  });
}

function renderLogin() {
  const onBack = vi.fn();
  const onSuccess = vi.fn();
  render(<LoginScreen onBack={onBack} onSuccess={onSuccess} />);
  return { onBack, onSuccess };
}

const accountField = () => screen.getByLabelText('账号') as HTMLInputElement;
const passwordField = () => screen.getByLabelText('密码') as HTMLInputElement;
const submitButton = () =>
  screen.getByRole('button', { name: /^(登录|登录中…|登录成功)$/ }) as HTMLButtonElement;
const backButton = () => screen.getByRole('button', { name: '返回' }) as HTMLButtonElement;
const alertRow = () => screen.getByRole('alert');

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  bridge.login.mockReset();
  bridge.logout.mockReset();
  bridge.getState.mockReset();
  bridge.getState.mockResolvedValue({ status: 'signed-out' });
  installBridge();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LoginScreen 提交闸门', () => {
  it('两项都非空才启用「登录」；Enter 提交', async () => {
    const user = userEvent.setup();
    renderLogin();
    const account = accountField();
    const password = passwordField();
    const submit = submitButton();

    // FR-LOGIN-02：进入 S2 后账号框自动聚焦。
    expect(document.activeElement).toBe(account);
    expect(submit.disabled).toBe(true);

    await user.type(account, 'alice');
    expect(submit.disabled).toBe(true);
    await user.clear(account);
    await user.type(password, 'pw');
    expect(submit.disabled).toBe(true);

    await user.type(account, 'alice');
    expect(submit.disabled).toBe(false);

    bridge.login.mockResolvedValue(SIGNED_IN);
    await user.type(password, '{Enter}');
    expect(bridge.login).toHaveBeenCalledTimes(1);
    expect(bridge.login).toHaveBeenCalledWith('alice', 'pw');
  });

  it('提交后按钮转「登录中…」、输入只读、返回禁用，重复提交不再发第二次 IPC', async () => {
    const user = userEvent.setup();
    renderLogin();
    const account = accountField();
    const password = passwordField();

    await user.type(account, 'alice');
    await user.type(password, 'pw');

    let resolveLogin!: (value: unknown) => void;
    bridge.login.mockReturnValue(new Promise((resolve) => (resolveLogin = resolve)));
    await user.click(submitButton());

    const busy = submitButton();
    expect(busy.textContent).toBe('登录中…');
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(account.readOnly).toBe(true);
    expect(password.readOnly).toBe(true);
    expect(backButton().disabled).toBe(true);

    // 防重入锁：表单重复提交 / 重复点击均不得触发第二次 IPC。
    fireEvent.submit(account.closest('form') as HTMLFormElement);
    fireEvent.click(busy);
    expect(bridge.login).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLogin(SIGNED_IN);
    });
  });

  it('成功后「登录成功」停留 500ms，再调 onSuccess', async () => {
    vi.useFakeTimers();
    bridge.login.mockResolvedValue(SIGNED_IN);
    const { onSuccess } = renderLogin();

    fireEvent.change(accountField(), { target: { value: 'alice' } });
    fireEvent.change(passwordField(), { target: { value: 'pw' } });
    fireEvent.click(submitButton());
    await act(async () => {});

    const success = submitButton();
    expect(success.textContent).toBe('登录成功');
    expect(success.disabled).toBe(true);

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(onSuccess).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('账号提交前 trim、密码原样提交', async () => {
    const user = userEvent.setup();
    renderLogin();
    bridge.login.mockResolvedValue(SIGNED_IN);

    await user.type(accountField(), '  alice  ');
    await user.type(passwordField(), ' pw ');
    await user.click(submitButton());

    expect(bridge.login).toHaveBeenCalledWith('alice', ' pw ');
  });
});

describe('LoginScreen 错误分支（FR-LOGIN-05）', () => {
  it('wrong_credentials：行内 alert、两框红、清空并聚焦密码；再输入即清错误', async () => {
    const user = userEvent.setup();
    renderLogin();
    const account = accountField();
    const password = passwordField();
    bridge.login.mockResolvedValue({ error: 'wrong_credentials' });

    await user.type(account, 'alice');
    await user.type(password, 'wrong');
    await user.click(submitButton());

    expect(alertRow().textContent).toBe('账号或密码错误');
    expect(account.getAttribute('aria-invalid')).toBe('true');
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(password.value).toBe('');
    expect(document.activeElement).toBe(password);
    // 账号保留，便于直接改密码重试。
    expect(account.value).toBe('alice');
    // FR-LOGIN-05：出错卡片抖动一次（shake 类为一次性动画宿主）。
    expect((account.closest('form') as HTMLFormElement).classList.contains('shake')).toBe(true);

    await user.type(password, 'x');
    expect(alertRow().textContent).toBe('');
    expect(account.getAttribute('aria-invalid')).toBeNull();
    expect(password.getAttribute('aria-invalid')).toBeNull();
    expect(submitButton().disabled).toBe(false);
  });

  it('locked：仅账号框红、聚焦并选中账号文本', async () => {
    const user = userEvent.setup();
    renderLogin();
    const account = accountField();
    const password = passwordField();
    bridge.login.mockResolvedValue({ error: 'locked' });

    await user.type(account, 'alice');
    await user.type(password, 'pw');
    await user.click(submitButton());

    expect(alertRow().textContent).toBe('账号已被锁定');
    expect(account.getAttribute('aria-invalid')).toBe('true');
    expect(password.getAttribute('aria-invalid')).toBeNull();
    expect(document.activeElement).toBe(account);
    expect(account.selectionStart).toBe(0);
    expect(account.selectionEnd).toBe('alice'.length);
    // 锁定与凭证错误不同：不猜哪边错，输入一律保留。
    expect(password.value).toBe('pw');
  });

  it.each([
    ['network_error', '网络异常，请检查网络后重试'],
    ['timeout', '登录超时，请稍后重试'],
  ] as const)('%s：输入保留、焦点回登录按钮', async (kind, copy) => {
    const user = userEvent.setup();
    renderLogin();
    const account = accountField();
    const password = passwordField();
    bridge.login.mockResolvedValue({ error: kind });

    await user.type(account, 'alice');
    await user.type(password, 'pw');
    await user.click(submitButton());

    expect(alertRow().textContent).toBe(copy);
    expect(account.value).toBe('alice');
    expect(password.value).toBe('pw');
    // 网络/超时不是字段错误：不上红框，错误消解靠「网络恢复后重试」。
    expect(account.getAttribute('aria-invalid')).toBeNull();
    expect(password.getAttribute('aria-invalid')).toBeNull();
    expect(document.activeElement).toBe(submitButton());
  });
});

describe('LoginScreen 其它交互（FR-LOGIN-01/03）', () => {
  it('密码眼睛按钮 aria-label 在「显示密码 / 隐藏密码」间切换', async () => {
    const user = userEvent.setup();
    renderLogin();
    const password = passwordField();

    const eye = screen.getByRole('button', { name: '显示密码' });
    expect(password.type).toBe('password');
    await user.click(eye);
    expect(password.type).toBe('text');
    expect(screen.getByRole('button', { name: '隐藏密码' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '隐藏密码' }));
    expect(password.type).toBe('password');
  });

  it('返回与 Esc 回 onBack；登录中 Esc 被忽略', async () => {
    const user = userEvent.setup();
    const { onBack } = renderLogin();

    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(1);

    await user.click(backButton());
    expect(onBack).toHaveBeenCalledTimes(2);

    await user.type(accountField(), 'alice');
    await user.type(passwordField(), 'pw');
    let resolveLogin!: (value: unknown) => void;
    bridge.login.mockReturnValue(new Promise((resolve) => (resolveLogin = resolve)));
    await user.click(submitButton());
    await user.keyboard('{Escape}');
    expect(onBack).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveLogin({ error: 'network_error' });
    });
  });
});
