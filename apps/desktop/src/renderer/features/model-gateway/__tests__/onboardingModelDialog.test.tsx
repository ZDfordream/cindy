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
 *   = `onSkipped`；origin='home' 无跳过出口、同路径 = `onClose`；保存走真实连通性检测
 *   （Ruling 9）：检测中「检测连接中…」+ 输入只读 + 关闭类动作禁用 + Esc/遮罩忽略，
 *   检测成功 ✓「已保存」保持 450ms 才回 `onSaved(id)`，检测失败 / 10s 超时出失败条 +
 *   面板 shake + 输入保留且零落库，失败条在任意字段再次输入后消失。
 * - Bug／规则依据：Ruling 9（controller 2026-11-01，login-onboarding PRD FR-MODEL-05 /
 *   AC-09 / §7 保存结果，OQ-6 真实校验不允许「仍然保存」）；S3 合同（origin 差异、
 *   五条跳过/关闭路径）；DESIGN.md §4 遮罩 dirty 抖动不关（PRD 2026-11-01）；
 *   Ruling 16/27/28 与合法性门经 wrapper 的回归护栏（简报测试清单末两项）。
 * - 现有覆盖缺口：`ModelGatewayForm.test.tsx` 只覆盖不探测的设置面（probeOnSave 缺省）
 *   与落库主路径，没有探测锁定 / 探测失败不落库 / 超时条 / ✓已保存 450ms 保持 /
 *   失败条输入即清的任何断言；S3 合同（onSkipped 与 onClose 分流）在旧入口下无法观察。
 * - 最小失败输入：改前点保存直接落库（探测从不发生）→ 探测失败例会落库并回 onSaved、
 *   超时例无超时条、锁定例无「检测连接中…」与输入只读、成功例无 450ms 保持。
 * - tier：unit（jsdom 组件渲染 + IPC 边界打桩；无真实 I/O；超时例用 fake timers
 *   推进 10s，不做真实等待）。
 * - 实测耗时：~2.6s 墙钟（`pnpm --dir apps/desktop exec vitest run
 *   src/renderer/features/model-gateway/__tests__/onboardingModelDialog.test.tsx`，18 用例）。
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
// Ruling 9 保存结果三态、探测失败 / 超时条的文案 key（译文在 5 语 locale JSON 里逐 key
// 落位）。Finding 3 key 分流：探测失败 = `probeFailed`（连接失败…），落盘失败 =
// `saveFailed`（保存失败…）——磁盘错不得说成「连接失败」。
const PROBING_LABEL = 'settings.providers.modelDialog.probing';
const SAVED_LABEL = 'settings.providers.modelDialog.saved';
const PROBE_FAILED = 'settings.providers.modelDialog.probeFailed';
const PROBE_TIMEOUT = 'settings.providers.modelDialog.probeTimeout';

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
        trackOrigin={props.origin === 'onboarding' ? 'onboarding' : 'home_send'}
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

  it('test_probing_lock_freezes_inputs_disables_close_actions_ignores_esc_scrim', async () => {
    // Ruling 9 保存锁（「检测连接中…」期间）：全部输入只读、取消/关闭/跳过禁用，
    // Esc 与点遮罩忽略——防探测/落库半截被误关丢掉已填内容。
    let releaseProbe!: (result: { ok: boolean; latencyMs?: number; detail?: string }) => void;
    maker.testProviderConnection = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve;
        }),
    );
    const { onSkipped, onSaved, onClose, view } = renderDialog({ origin: 'onboarding' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    clickSave();

    await screen.findByText(PROBING_LABEL);
    expect((screen.getByLabelText(ENDPOINT_LABEL) as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText(KEY_LABEL) as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText(MODEL_LABEL) as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByRole('button', { name: CANCEL_LABEL }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: CLOSE_LABEL }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: SKIP_LABEL }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(screen.getByLabelText(ENDPOINT_LABEL), { key: 'Escape' });
    fireEvent.click(scrim(view));
    expect(onSkipped).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      releaseProbe({ ok: true, latencyMs: 5 });
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('test_probe_success_shows_saved_check_then_returns_id_after_hold', async () => {
    // Ruling 9 保存结果（AC-09）：检测成功 → 按钮 ✓「已保存」保持 450ms → onSaved(id)；
    // 探测先于落库（真实探测一次、通了才写盘）。fake timers 钉 450ms 保持，不真实等待。
    vi.useFakeTimers();
    try {
      let releaseProbe!: (result: { ok: boolean; latencyMs?: number }) => void;
      maker.testProviderConnection = vi.fn(
        () =>
          new Promise((resolve) => {
            releaseProbe = resolve;
          }),
      );
      const { onSaved, getApi } = renderDialog({ origin: 'onboarding' });
      await act(async () => {});

      fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
      clickSave();
      expect(screen.getByText(PROBING_LABEL)).toBeTruthy();

      await act(async () => {
        releaseProbe({ ok: true, latencyMs: 5 });
      });
      await act(async () => {});
      expect(maker.testProviderConnection).toHaveBeenCalledTimes(1);
      expect(maker.createCustomProvider).toHaveBeenCalledTimes(1);
      expect(screen.getByText(SAVED_LABEL)).toBeTruthy();
      // 保持期内不交棒；450ms 整点才回 onSaved(id)。
      expect(onSaved).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(449);
      });
      expect(onSaved).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(onSaved).toHaveBeenCalledWith(expect.any(String));
      expect(getApi().entries).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_probe_failure_shows_strip_shakes_keeps_input_and_never_persists', async () => {
    // Ruling 9 检测失败（OQ-6）：连接失败条（probeFailed，Finding 3 分键）+ 抖动 +
    // 输入保留；**不允许「仍然保存」**——探测不过零落库，可改后重试或跳过。
    maker.testProviderConnection = vi.fn(async () => ({ ok: false, code: 'AUTH_INVALID', latencyMs: 0 }));
    const { onSkipped, onSaved, onClose, view } = renderDialog({ origin: 'onboarding' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    clickSave();

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain(PROBE_FAILED);
    expect(panel(view).classList.contains('shake')).toBe(true);
    // 输入保留：三栏值原样在、可继续改后重试。
    expect((screen.getByLabelText(ENDPOINT_LABEL) as HTMLInputElement).value).toBe('https://gw.example/anthropic');
    expect((screen.getByLabelText(KEY_LABEL) as HTMLInputElement).value).toBe('sk-ok');
    expect((screen.getByLabelText(MODEL_LABEL) as HTMLInputElement).value).toBe('m1');
    expect(maker.createCustomProvider).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onSkipped).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('test_probe_timeout_after_10s_shows_timeout_strip', async () => {
    // Ruling 9 超时护栏：10s 不回包 → 独立超时条「连接超时，请检查接口地址或网络」+
    // 抖动 + 零落库；fake timers 推进 10s，不做真实等待。
    vi.useFakeTimers();
    try {
      maker.testProviderConnection = vi.fn(() => new Promise(() => {}));
      const { onSaved, view } = renderDialog({ origin: 'onboarding' });
      await act(async () => {});

      fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
      clickSave();
      expect(screen.getByText(PROBING_LABEL)).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });

      expect(screen.getByRole('alert').textContent).toContain(PROBE_TIMEOUT);
      expect(panel(view).classList.contains('shake')).toBe(true);
      expect(maker.createCustomProvider).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_failure_strip_clears_on_any_field_input', async () => {
    // Ruling 9（FR-MODEL-08）：失败提示条在任意字段再次输入后消失，不糊住下一次尝试。
    maker.testProviderConnection = vi.fn(async () => ({ ok: false, detail: '连不上' }));
    renderDialog({ origin: 'onboarding' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    clickSave();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    fillFields({ modelId: 'm2' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('test_probe_ok_then_persist_throws_shows_persist_copy_not_probe_copy', async () => {
    // Finding 3 key 分流：探测通过后写盘抛错 = 落盘失败条（saveFailed），**不是**
    // 连接失败条（probeFailed）——磁盘错不得说成「连接失败，请检查接口地址…」。
    // 同时守 Finding 1 的 probeOnSave 侧：落盘失败在本弹窗仍抖（抖动门 = probeOnSave）。
    maker.testProviderConnection = vi.fn(async () => ({ ok: true, latencyMs: 5 }));
    maker.createCustomProvider = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { onSaved, view } = renderDialog({ origin: 'onboarding' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    clickSave();

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const strip = screen.getByRole('alert').textContent!;
    expect(strip).toContain(SAVE_FAILED);
    expect(strip).not.toContain(PROBE_FAILED);
    expect(panel(view).classList.contains('shake')).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
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
