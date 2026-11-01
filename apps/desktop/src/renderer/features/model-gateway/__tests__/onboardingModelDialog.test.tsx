/** @vitest-environment jsdom */

/**
 * OnboardingModelDialog — S3 添加模型引导弹窗（origin=onboarding / home）。
 *
 * 走真实生产入口：`OnboardingModelDialog` 包裹 `ModelGatewayForm`，挂真实
 * `ModelGatewayProvider`（add/update 走真 `createCustomProvider` IPC），只在 IPC 边界
 * 打桩。断言看用户可观察结果：origin 决定跳过按钮与底部提示的显隐、五条关闭路径的
 * 回调出口（跳过 vs 关闭）、遮罩 dirty 抖动不关、保存锁定期的禁用与忽略、保存成功
 * 回传 id、保存失败条 + 抖动 + 输入保留、合法性门与重复拦截经 wrapper 不回归。
 *
 * 测试价值
 * - 生产入口与可观察结果：`OnboardingModelDialog`（S3 / 首页补配的生产入口）；
 *   origin='onboarding' 显示「跳过，稍后配置」与底部提示且 ×/取消/跳过/Esc/无输入遮罩
 *   = `onSkipped`；origin='home' 无跳过出口、同路径 = `onClose`；保存中取消/关闭/跳过
 *   禁用且 Esc/遮罩忽略；保存成功 `onSaved(id)`；保存失败出失败条 + 面板 shake + 输入保留。
 * - Bug／规则依据：login-onboarding Task 5 简报 S3 合同（origin 差异、五条跳过/关闭
 *   路径、保存失败条）；DESIGN.md §4 遮罩 dirty 抖动不关（PRD 2026-11-01）；
 *   Ruling 16/27/28 与合法性门经 wrapper 的回归护栏（简报测试清单末两项）。
 * - 现有覆盖缺口：`ModelGatewayForm.test.tsx` 只覆盖 origin 缺省（home 语义）与落库
 *   主路径，没有 onboarding 跳过出口 / skip 按钮 / 底部提示 / 保存失败条与失败抖动的
 *   任何断言；S3 合同（onSkipped 与 onClose 分流）在旧入口下无法观察。
 * - 最小失败输入：origin='onboarding' 点 × 未实现前只回 onClose（onSkipped 不触发）；
 *   保存中点遮罩未加 busy 门前会误关；createCustomProvider 拒绝未实现前不出失败条、
 *   不 shake、输入被复位。
 * - tier：unit（jsdom 组件渲染 + IPC 边界打桩；无真实 I/O、无真实等待）。
 * - 实测耗时：~2.6s 墙钟（`pnpm --dir apps/desktop exec vitest run
 *   src/renderer/features/model-gateway/__tests__/onboardingModelDialog.test.tsx`，16 用例）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { ModelGatewayProvider, useModelGateway } from '../ModelGatewayStore';
import { OnboardingModelDialog } from '../OnboardingModelDialog';
import type { ModelGatewayApi } from '../types';
import { toast } from '@/lib/toast';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { model?: string }) => (opts?.model ? `${key}:${opts.model}` : key),
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

interface MakerMock {
  listProviders: ReturnType<typeof vi.fn>;
  createCustomProvider: ReturnType<typeof vi.fn>;
  updateCustomProvider: ReturnType<typeof vi.fn>;
  deleteCustomProvider: ReturnType<typeof vi.fn>;
  exportHrbuddyModels: ReturnType<typeof vi.fn>;
  testProviderConnection: ReturnType<typeof vi.fn>;
}

let maker: MakerMock;

const ENDPOINT_LABEL = 'settings.providers.modelDialog.endpoint';
const KEY_LABEL = 'settings.providers.modelDialog.key';
const MODEL_LABEL = 'settings.providers.modelDialog.model';
const SAVE_LABEL = 'settings.providers.custom.save';
const CANCEL_LABEL = 'settings.providers.custom.cancel';
const CLOSE_LABEL = 'settings.providers.modelDialog.close';
const SKIP_LABEL = 'settings.providers.modelDialog.skip';
const SKIP_HINT = 'settings.providers.modelDialog.skipHint';
const SAVE_FAILED = 'settings.providers.modelDialog.saveFailed';
const ERR_MODEL_DUPLICATE = 'settings.providers.modelDialog.modelIdDuplicate';

/** 表单与 store 探针共享同一 `ModelGatewayProvider` 实例（重复拦截播种要用到）。 */
function renderDialog(props: { origin: 'onboarding' | 'home' }) {
  let api: ModelGatewayApi | null = null;
  function Probe() {
    api = useModelGateway();
    return null;
  }
  const onSkipped = vi.fn();
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <ModelGatewayProvider>
      <Probe />
      <OnboardingModelDialog
        open
        origin={props.origin}
        onSkipped={onSkipped}
        onSaved={onSaved}
        onClose={onClose}
      />
    </ModelGatewayProvider>,
  );
  return { onSkipped, onSaved, onClose, view, getApi: () => api! };
}

function fillFields(values: { baseUrl?: string; apiKey?: string; modelId?: string }) {
  if (values.baseUrl !== undefined) {
    fireEvent.change(screen.getByLabelText(ENDPOINT_LABEL), { target: { value: values.baseUrl } });
  }
  if (values.apiKey !== undefined) {
    fireEvent.change(screen.getByLabelText(KEY_LABEL), { target: { value: values.apiKey } });
  }
  if (values.modelId !== undefined) {
    fireEvent.change(screen.getByLabelText(MODEL_LABEL), { target: { value: values.modelId } });
  }
}

function clickSave() {
  fireEvent.click(screen.getByRole('button', { name: SAVE_LABEL }));
}

function panel(view: RenderResult) {
  return view.container.querySelector('.modal-panel') as HTMLDivElement;
}

function scrim(view: RenderResult) {
  return view.container.querySelector('.modal-scrim') as HTMLDivElement;
}

/** 关闭路径的五条触发方式（S3 合同逐条对应）。 */
const dismissPaths = [
  ['×', () => fireEvent.click(screen.getByRole('button', { name: CLOSE_LABEL }))],
  ['取消', () => fireEvent.click(screen.getByRole('button', { name: CANCEL_LABEL }))],
  ['跳过', () => fireEvent.click(screen.getByRole('button', { name: SKIP_LABEL }))],
  ['Esc', () => fireEvent.keyDown(screen.getByRole('button', { name: SAVE_LABEL }), { key: 'Escape' })],
  ['无输入点遮罩', (view: RenderResult) => fireEvent.click(scrim(view))],
] as const;

describe('OnboardingModelDialog', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    maker = {
      listProviders: vi.fn(async () => ({ providers: [] as ProviderView[] })),
      createCustomProvider: vi.fn(async () => ({ ok: true })),
      updateCustomProvider: vi.fn(async () => ({ ok: true })),
      deleteCustomProvider: vi.fn(async () => ({ ok: true })),
      exportHrbuddyModels: vi.fn(async () => undefined),
      testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 128 })),
    };
    window.electronAPI = {
      maker,
      safeStorageRead: vi.fn(async () => 'sk-stored'),
    } as unknown as typeof window.electronAPI;
  });

  afterEach(cleanup);

  it('test_origin_onboarding_shows_skip_affordances_home_shows_none', async () => {
    // S3 合同：origin='onboarding' 显示「跳过，稍后配置」文字按钮 + 底部提示；
    // origin='home'（更多 → 自定义 / 补配）两者都不显示。
    renderDialog({ origin: 'onboarding' });
    await act(async () => {});
    expect(screen.getByRole('button', { name: SKIP_LABEL })).toBeTruthy();
    expect(screen.getByText(SKIP_HINT)).toBeTruthy();
    // 提交动作仍是右侧 取消 / 保存 双药丸（跳过不是提交动作）。
    expect(screen.getByRole('button', { name: CANCEL_LABEL })).toBeTruthy();
    expect(screen.getByRole('button', { name: SAVE_LABEL })).toBeTruthy();
    cleanup();

    renderDialog({ origin: 'home' });
    await act(async () => {});
    expect(screen.queryByRole('button', { name: SKIP_LABEL })).toBeNull();
    expect(screen.queryByText(SKIP_HINT)).toBeNull();
  });

  it.each(dismissPaths)(
    'test_onboarding_%s_means_skip',
    async (_name, fire: (view: RenderResult) => void) => {
      // onboarding 五条关闭路径（×/取消/跳过/Esc/无输入遮罩）全部 = 跳过 → onSkipped，
      // 不得回 onClose（否则宿主会把跳过当普通关闭处理）。
      const { onSkipped, onClose, view } = renderDialog({ origin: 'onboarding' });
      await act(async () => {});

      fire(view);

      expect(onSkipped).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it.each(dismissPaths.filter(([name]) => name !== '跳过'))(
    'test_home_%s_means_close',
    async (_name, fire: (view: RenderResult) => void) => {
      // home 四条关闭路径（×/取消/Esc/无输入遮罩）= 关闭 → onClose，不得回 onSkipped。
      const { onSkipped, onClose, view } = renderDialog({ origin: 'home' });
      await act(async () => {});

      fire(view);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSkipped).not.toHaveBeenCalled();
    },
  );

  it.each(['onboarding', 'home'] as const)(
    'test_scrim_with_input_shakes_and_does_not_close_%s',
    async (origin) => {
      // 既有遮罩分层经 wrapper 回归：dirty 点遮罩只抖不关（两 origin 同口径）。
      const { onSkipped, onClose, view } = renderDialog({ origin });
      await act(async () => {});

      fillFields({ apiKey: 'sk-typed-secret' });
      fireEvent.click(scrim(view));

      expect(panel(view).classList.contains('shake')).toBe(true);
      expect(onSkipped).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it('test_save_lock_disables_cancel_close_skip_and_ignores_esc_scrim', async () => {
    // 保存锁定期（保存按钮忙碌态）：取消/关闭/跳过禁用，Esc 与点遮罩忽略——
    // 防落库半截被误关丢掉已填内容。
    let releaseCreate!: () => void;
    maker.createCustomProvider = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseCreate = resolve;
        }),
    );
    const { onSkipped, onSaved, onClose, view } = renderDialog({ origin: 'onboarding' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    clickSave();

    await waitFor(() => {
      expect((screen.getByRole('button', { name: CANCEL_LABEL }) as HTMLButtonElement).disabled).toBe(true);
    });
    expect((screen.getByRole('button', { name: CLOSE_LABEL }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: SKIP_LABEL }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(screen.getByRole('button', { name: SAVE_LABEL }), { key: 'Escape' });
    fireEvent.click(scrim(view));
    expect(onSkipped).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      releaseCreate();
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('test_save_success_returns_new_id', async () => {
    // S3 合同：保存成功 → onSaved(id)（条目落库并成为当前模型由宿主处理）。
    const { onSaved, getApi } = renderDialog({ origin: 'onboarding' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    clickSave();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith(expect.any(String));
    expect(maker.createCustomProvider).toHaveBeenCalledTimes(1);
    expect(maker.testProviderConnection).not.toHaveBeenCalled();
    expect(getApi().entries).toHaveLength(1);
  });

  it('test_save_failure_shows_strip_shakes_and_keeps_input', async () => {
    // S3 合同：保存失败 → 失败提示条 + 弹窗抖动 + 输入保留（不丢已填内容）。
    maker.createCustomProvider = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { onSkipped, onSaved, onClose, view } = renderDialog({ origin: 'onboarding' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    clickSave();

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain(SAVE_FAILED);
    expect(panel(view).classList.contains('shake')).toBe(true);
    // 输入保留：三栏值原样在、可继续改后重试。
    expect((screen.getByLabelText(ENDPOINT_LABEL) as HTMLInputElement).value).toBe('https://gw.example/anthropic');
    expect((screen.getByLabelText(KEY_LABEL) as HTMLInputElement).value).toBe('sk-ok');
    expect((screen.getByLabelText(MODEL_LABEL) as HTMLInputElement).value).toBe('m1');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onSkipped).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('test_save_gate_and_duplicate_model_guard_through_wrapper', async () => {
    // 简报清单末项经 wrapper 回归：三项未全合法保存禁用；模型重复 → 「该模型已添加」
    // （深度用例在 ModelGatewayForm.test.tsx，这里守 S3 入口不绕过合法性门）。
    const { onSaved, getApi } = renderDialog({ origin: 'onboarding' });
    await act(async () => {});
    await act(async () => {
      await getApi().add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-dup',
        modelId: 'm-dup',
      });
    });
    // 播种走了 createCustomProvider；清掉后断言「保存被门拦住、零写盘」才干净。
    maker.createCustomProvider.mockClear();

    const saveButton = () => screen.getByRole('button', { name: SAVE_LABEL }) as HTMLButtonElement;
    expect(saveButton().disabled).toBe(true);
    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-new' });
    expect(saveButton().disabled).toBe(true);

    fillFields({ modelId: 'm-dup' });
    expect(saveButton().disabled).toBe(true);
    fireEvent.blur(screen.getByLabelText(MODEL_LABEL));
    expect(screen.getByText(ERR_MODEL_DUPLICATE)).toBeTruthy();

    clickSave();
    expect(maker.createCustomProvider).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
