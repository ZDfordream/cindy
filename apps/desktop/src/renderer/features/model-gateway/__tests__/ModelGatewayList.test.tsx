/** @vitest-environment jsdom */

/**
 * ModelGatewayList — 右栏模型列表（PRD model-provider-settings 2026-11-01）：
 * 插入序行、状态点/状态文字四态、行内重测、删除 5s 撤销 toast、空态与标题计数。
 *
 * 走真实生产入口：`ModelGatewayList`/`ModelGatewayRow` 挂在真实
 * `ModelGatewayProvider`（store）与真实 `ToastContainer` 下，只在 IPC 边界打桩
 * （`window.electronAPI.maker.*` / `safeStorageRead`，与 modelGatewayStore.test.ts
 * 同法）。重测走真实 `testModelConnectivity` → `maker.testProviderConnection`；
 * 删除撤销走真实 `remove → UndoHandle` 与真实 toast store。
 *
 * 测试价值
 * - 生产入口与可观察结果：ModelGatewayList/Row 组件入口；用户可观察 = 行文案与
 *   状态点四态对应、testing 禁点、删除即消失 + 撤销 toast 回原位闪高亮、toast
 *   5s 自动消失、空态与标题计数、开关只翻 enabled。
 * - Bug／规则依据：PRD 交互稿脚本语义（statusText 四态 / removeModel+toast 撤销 /
 *   empty 态）；T1 挂账「undo() 双击只生效一次」。
 * - 现有覆盖缺口：旧用例只有删除确认框 + 一次成功重测，没有撤销 toast、testing
 *   中间态、四态映射、空态计数与 double-undo。
 * - 最小失败输入：一条 untested 条目点状态文字；一条条目点删除再点撤销。
 * - tier：unit（jsdom 渲染生产组件，假时钟推 5s 窗口，无真实等待）。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { ToastContainer } from '@/components/ui/toast';
import { toast } from '@/lib/toast';
import { ModelGatewayProvider, useModelGateway } from '../ModelGatewayStore';
import type { ModelGatewayApi } from '../types';
import { ModelGatewayList } from '../ModelGatewayList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { model?: string; name?: string }) => {
      const param = opts?.model ?? opts?.name;
      return typeof param === 'string' ? `${key}:${param}` : key;
    },
  }),
}));

interface MakerMock {
  listProviders: ReturnType<typeof vi.fn>;
  createCustomProvider: ReturnType<typeof vi.fn>;
  updateCustomProvider: ReturnType<typeof vi.fn>;
  deleteCustomProvider: ReturnType<typeof vi.fn>;
  exportHrbuddyModels: ReturnType<typeof vi.fn>;
  testProviderConnection: ReturnType<typeof vi.fn>;
}

let maker: MakerMock;
let safeStorageRead: ReturnType<typeof vi.fn>;

/** 拿 store API 的探针 + 被测列表 + 真实 toast 容器，共享同一个 ModelGatewayProvider 实例。 */
function renderList() {
  let api: ModelGatewayApi | null = null;
  const onAdd = vi.fn();
  function Probe() {
    api = useModelGateway();
    return null;
  }
  render(
    <ModelGatewayProvider>
      <Probe />
      <ModelGatewayList onAdd={onAdd} onEdit={() => {}} />
      <ToastContainer />
    </ModelGatewayProvider>,
  );
  return { getApi: () => api!, onAdd };
}

async function addModel(api: ModelGatewayApi, modelId: string) {
  await act(async () => {
    await api.add({
      baseUrl: 'https://gw.example/anthropic',
      apiKey: `sk-${modelId}`,
      modelId,
    });
  });
}

describe('ModelGatewayList', () => {
  beforeEach(() => {
    window.localStorage.clear();
    toast.dismissAll();
    maker = {
      listProviders: vi.fn(async () => ({ providers: [] as ProviderView[] })),
      createCustomProvider: vi.fn(async () => ({ ok: true })),
      updateCustomProvider: vi.fn(async () => ({ ok: true })),
      deleteCustomProvider: vi.fn(async () => ({ ok: true })),
      exportHrbuddyModels: vi.fn(async () => undefined),
      testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 128 })),
    };
    safeStorageRead = vi.fn(async () => 'sk-test');
    window.electronAPI = {
      maker,
      safeStorageRead,
    } as unknown as typeof window.electronAPI;
  });

  afterEach(cleanup);

  it('renders rows in insertion order with a status dot per row', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'b');
    await addModel(getApi(), 'a');

    // 插入序：先加的 b 在前，新条目追加末尾（不再按 modelId 排序）。
    const rows = screen.getAllByTestId('model-gateway-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('b')).toBeTruthy();
    expect(within(rows[1]!).getByText('a')).toBeTruthy();
    // 每行一个状态点。
    expect(screen.getAllByTestId('model-gateway-status-dot')).toHaveLength(2);
  });

  it('test_toggle_hides_from_chat_without_dropping_config', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');

    await act(async () => {
      fireEvent.click(screen.getByRole('switch'));
    });

    // 配置不丢：条目仍在列表里，只是 enabled 翻成 false（聊天菜单读的正是它）。
    expect(within(screen.getByTestId('model-gateway-row')).getByText('a')).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(getApi().entries[0]!.enabled).toBe(false);
    expect(maker.deleteCustomProvider).not.toHaveBeenCalled();
  });

  it('删除后 5 秒内可撤销', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');
    await addModel(getApi(), 'b');

    // 假时钟要在点击前启用——remove() 的 5s 删除窗口与 toast 的 5s 展示都要挂在假时钟上。
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(
          within(screen.getAllByTestId('model-gateway-row')[0]!).getByRole('button', {
            name: 'settings.providers.modelGateway.delete',
          }),
        );
      });
      // PRD：点删除无确认框，行立即消失；真正的 deleteCustomProvider 延迟 5s（撤销窗口）。
      expect(screen.getAllByTestId('model-gateway-row')).toHaveLength(1);
      expect(screen.queryByText('a')).toBeNull();
      expect(maker.deleteCustomProvider).not.toHaveBeenCalled();
      // toast「已删除 {model}」带「撤销」。
      expect(screen.getByText('settings.providers.modelGateway.deletedToast:a')).toBeTruthy();
      const undoButton = screen.getByRole('button', {
        name: 'settings.providers.modelGateway.undo',
      });

      await act(async () => {
        fireEvent.click(undoButton);
      });
      // 撤销 → 行回原索引（a 回到 b 前）并 flash 高亮；延迟删除被取消。
      const rows = screen.getAllByTestId('model-gateway-row');
      expect(rows).toHaveLength(2);
      expect(within(rows[0]!).getByText('a')).toBeTruthy();
      expect(within(rows[1]!).getByText('b')).toBeTruthy();
      expect(rows[0]!.getAttribute('data-flash')).toBe('true');

      // toast 5 秒自动消失（与删除窗口同步；+300ms 退出动画后彻底移除）。
      await act(async () => {
        vi.advanceTimersByTime(5300);
      });
      expect(screen.queryByText('settings.providers.modelGateway.deletedToast:a')).toBeNull();
      // 撤销后窗口到期也不得落下真正的删除。
      expect(maker.deleteCustomProvider).not.toHaveBeenCalled();
    } finally {
      // 同 test_undo_twice：toast 退出动画收尾后才弃假时钟。
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      vi.useRealTimers();
    }
  });

  it('test_undo_twice_restores_row_only_once', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');

    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(
          within(screen.getByTestId('model-gateway-row')).getByRole('button', {
            name: 'settings.providers.modelGateway.delete',
          }),
        );
      });
      const undoButton = screen.getByRole('button', {
        name: 'settings.providers.modelGateway.undo',
      });
      // T1 挂账钉子：undo() 双击只生效一次，行不得被插回两份。
      await act(async () => {
        fireEvent.click(undoButton);
        fireEvent.click(undoButton);
      });
      expect(screen.getAllByTestId('model-gateway-row')).toHaveLength(1);
    } finally {
      // 跑完 toast 退出动画（300ms finalize）再弃假时钟，防 zombie toast 泄漏进下个用例。
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      vi.useRealTimers();
    }
  });

  it('test_undo_window_toast_force_closes_with_delete_window', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');

    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(
          within(screen.getByTestId('model-gateway-row')).getByRole('button', {
            name: 'settings.providers.modelGateway.delete',
          }),
        );
      });
      // 键盘用户 Tab 到 toast 会 focus 住面板 → 全局 toast 暂停自动关闭。
      // 撤销窗口绝不能跟着暂停：store 的 5s 真删不暂停，toast 必须同源强制收口，
      // 否则「撤销」按钮还在而窗口已过，点了无反馈、条目连密钥永久消失。
      const toastPanel = screen
        .getByText('settings.providers.modelGateway.deletedToast:a')
        .closest('[role="status"]')!;
      await act(async () => {
        fireEvent.focus(toastPanel);
      });
      await act(async () => {
        vi.advanceTimersByTime(5300);
      });
      // 窗口到点：toast 已收口（不被 focus 拖住），真删已落。
      expect(screen.queryByText('settings.providers.modelGateway.deletedToast:a')).toBeNull();
      expect(maker.deleteCustomProvider).toHaveBeenCalledWith('a');
      // 退出残留里的撤销点了也无效：行不回来。
      const undo = screen.queryByRole('button', {
        name: 'settings.providers.modelGateway.undo',
      });
      if (undo) {
        await act(async () => {
          fireEvent.click(undo);
        });
      }
      expect(screen.queryByTestId('model-gateway-row')).toBeNull();
    } finally {
      // 同 test_undo_twice：toast 退出动画收尾后才弃假时钟。
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      vi.useRealTimers();
    }
  });

  it('test_status_and_switch_show_focus_visible_ring', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');

    // 全局 `*:focus-visible { outline: none }` 抹了 UA 焦点提示；本地控件必须像
    // 共享 Button/Switch 一样自带 focus-visible ring，键盘焦点才可见（断言形态
    // 同 button.test.tsx：类名契约）。
    const statusBtn = screen.getByRole('button', {
      name: 'settings.providers.modelGateway.retest',
    });
    const toggleBtn = screen.getByRole('switch');
    for (const control of [statusBtn, toggleBtn]) {
      expect(control.className).toContain('focus-visible:ring-2');
      expect(control.className).toContain('focus-visible:ring-[var(--focus-ring-soft)]');
    }
  });

  it('test_retest_flow_and_status_four_states', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');

    // 四态之一（idle）：未测试 + 空心点。
    const dot = () => screen.getByTestId('model-gateway-status-dot');
    const statusBtn = () =>
      screen.getByRole('button', { name: 'settings.providers.modelGateway.retest' });
    expect(statusBtn().textContent).toBe('settings.providers.modelGateway.untested');
    expect(dot().getAttribute('data-status')).toBe('idle');

    // 探测挂起（可控 Promise）→ testing 态：「测试中…」+ disabled + 旋环点。
    let resolveProbe: (v: { ok: true; latencyMs: number } | { ok: false; detail: string }) => void =
      () => {};
    maker.testProviderConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    await act(async () => {
      fireEvent.click(statusBtn());
    });
    expect(statusBtn().textContent).toBe('settings.providers.modelGateway.testing');
    expect(statusBtn().hasAttribute('disabled')).toBe(true);
    expect(dot().getAttribute('data-status')).toBe('testing');

    // 探测成功回写：{n}ms + 绿点。
    await act(async () => {
      resolveProbe({ ok: true, latencyMs: 128 });
    });
    expect(statusBtn().textContent).toBe('128ms');
    expect(dot().getAttribute('data-status')).toBe('ok');
    expect(getApi().entries[0]!.status).toEqual({ ok: true, latencyMs: 128 });

    // 再测一次失败：连不上 + 红点。
    maker.testProviderConnection.mockImplementation(async () => ({ ok: false, detail: 'boom' }));
    await act(async () => {
      fireEvent.click(statusBtn());
    });
    expect(statusBtn().textContent).toBe('settings.providers.modelGateway.failed');
    expect(dot().getAttribute('data-status')).toBe('fail');
    expect(getApi().entries[0]!.status).toEqual({ ok: false, detail: 'boom' });
  });

  it('test_inflight_retest_result_discarded_after_edit_resets_status', async () => {
    const { getApi } = renderList();
    await act(async () => {});
    await addModel(getApi(), 'a');

    // 探测挂起（可控 Promise）——真实模式慢探测会把这个窗口拉得不小。
    let resolveProbe: (v: { ok: true; latencyMs: number }) => void = () => {};
    maker.testProviderConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve;
        }),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'settings.providers.modelGateway.retest' }),
      );
    });

    // 在途期间编辑同一行改 baseUrl 并保存（Form 保存走同一 store 入口 `update`）：
    // PRD「改字段 → 未测试」已由 store.update 重置 status。
    await act(async () => {
      await getApi().update('a', {
        baseUrl: 'https://changed.example/anthropic',
        apiKey: 'sk-a',
        modelId: 'a',
      });
    });

    // 旧配置的探测结果到站：必须就地丢弃，不得盖掉「未测试」。
    await act(async () => {
      resolveProbe({ ok: true, latencyMs: 128 });
    });
    const statusBtn = screen.getByRole('button', {
      name: 'settings.providers.modelGateway.retest',
    });
    expect(statusBtn.textContent).toBe('settings.providers.modelGateway.untested');
    expect(getApi().entries[0]!.status).toBe('untested');
    // lastTestedAt 同样不得被这次陈旧回写带上。
    expect(getApi().entries[0]!.lastTestedAt).toBeUndefined();
  });

  it('test_empty_state_and_title_count', async () => {
    const { getApi, onAdd } = renderList();
    await act(async () => {});

    // 空态：文案 + 「添加模型」按钮；标题计数 (0)。头部与空态各有一个添加按钮（PRD）。
    expect(screen.getByText('settings.providers.modelGateway.empty')).toBeTruthy();
    expect(screen.getByText('settings.providers.modelGateway.title')).toBeTruthy();
    expect(screen.getByText('(0)')).toBeTruthy();
    const addButtons = screen.getAllByRole('button', {
      name: 'settings.providers.modelGateway.add',
    });
    expect(addButtons).toHaveLength(2);
    fireEvent.click(addButtons[0]!);
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('model-gateway-row')).toBeNull();

    await addModel(getApi(), 'a');
    expect(screen.queryByText('settings.providers.modelGateway.empty')).toBeNull();
    expect(screen.getByText('(1)')).toBeTruthy();
  });
});
