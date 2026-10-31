/** @vitest-environment jsdom */

/**
 * ModelGatewayForm — 添加 / 编辑模型的三栏弹窗（设计稿 §5.2）。
 *
 * 走真实生产入口：表单挂真实 `ModelGatewayProvider`（Task 1 store，add/update 走真
 * `create/updateCustomProvider` IPC）、真实 `testModelConnectivity`（Task 2，经
 * `maker.testProviderConnection` IPC），只在 IPC 边界打桩。断言看可观察结果：
 * 探测失败时**不落库**（create/update IPC 都不发）、**不关窗**、弹窗内出人话错误。
 *
 * 凭证契约：编辑态密钥不回显（占位「保持不变」），留空沿用已存（keychain 现读）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { ModelGatewayProvider, useModelGateway } from '../ModelGatewayStore';
import { ModelGatewayForm, type ModelGatewayFormProps } from '../ModelGatewayForm';
import type { ModelGatewayApi } from '../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

interface MakerMock {
  listProviders: ReturnType<typeof vi.fn>;
  createCustomProvider: ReturnType<typeof vi.fn>;
  updateCustomProvider: ReturnType<typeof vi.fn>;
  deleteCustomProvider: ReturnType<typeof vi.fn>;
  testProviderConnection: ReturnType<typeof vi.fn>;
}

let maker: MakerMock;
let safeStorageRead: ReturnType<typeof vi.fn>;

const ENDPOINT_LABEL = 'settings.providers.modelDialog.endpoint';
const KEY_LABEL = 'settings.providers.modelDialog.key';
const MODEL_LABEL = 'settings.providers.modelDialog.model';
const SAVE_LABEL = 'settings.providers.custom.save';
const PROBE_FAILED_LABEL = 'settings.providers.modelDialog.saveProbeFailed';
const KEY_KEEP_PLACEHOLDER = 'settings.providers.custom.fields.apiKeyEditPlaceholder';

/** 表单与 store 探针共享同一 `ModelGatewayProvider` 实例（edit 播种要用到）。 */
function renderForm(props: {
  mode: 'create' | 'edit';
  initial?: ModelGatewayFormProps['initial'];
}) {
  let api: ModelGatewayApi | null = null;
  function Probe() {
    api = useModelGateway();
    return null;
  }
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <ModelGatewayProvider>
      <Probe />
      <ModelGatewayForm
        open
        mode={props.mode}
        initial={props.initial}
        onClose={onClose}
        onSaved={onSaved}
      />
    </ModelGatewayProvider>,
  );
  return { onSaved, onClose, getApi: () => api! };
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

describe('ModelGatewayForm', () => {
  beforeEach(() => {
    window.localStorage.clear();
    maker = {
      listProviders: vi.fn(async () => ({ providers: [] as ProviderView[] })),
      createCustomProvider: vi.fn(async () => ({ ok: true })),
      updateCustomProvider: vi.fn(async () => ({ ok: true })),
      deleteCustomProvider: vi.fn(async () => ({ ok: true })),
      testProviderConnection: vi.fn(async () => ({ ok: true, latencyMs: 128 })),
    };
    safeStorageRead = vi.fn(async () => 'sk-stored');
    window.electronAPI = {
      maker,
      safeStorageRead,
    } as unknown as typeof window.electronAPI;
  });

  afterEach(cleanup);

  it('renders exactly three fields in order: endpoint, key, model', async () => {
    const { container } = render(
      <ModelGatewayProvider>
        <ModelGatewayForm open mode="create" onClose={() => {}} onSaved={() => {}} />
      </ModelGatewayProvider>,
    );
    await act(async () => {});

    const endpoint = screen.getByLabelText(ENDPOINT_LABEL);
    const key = screen.getByLabelText(KEY_LABEL);
    const model = screen.getByLabelText(MODEL_LABEL);
    // 顺序：接口地址 → 密钥 → 模型。
    expect(endpoint.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(key.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 整个弹窗只有这三个输入框（无删除控件、无协议选项）。
    expect(container.querySelectorAll('input')).toHaveLength(3);
  });

  it('save runs a real probe and refuses to persist when the probe fails', async () => {
    maker.testProviderConnection = vi.fn(async () => ({ ok: false, code: 'AUTH_INVALID', latencyMs: 0 }));
    const { onClose, onSaved } = renderForm({ mode: 'create' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-fake', modelId: 'm1' });
    clickSave();

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // 真实探测跑了一次；但 add 不被调用（不落库）、不关窗。
    expect(maker.testProviderConnection).toHaveBeenCalledTimes(1);
    expect(maker.createCustomProvider).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    // Ruling 11：主文案是人话标签，原始 detail 只进 tooltip/次要行。
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('p')?.textContent).toBe(PROBE_FAILED_LABEL);
    expect(alert.getAttribute('title')).toContain('AUTH_INVALID');
  });

  it('save persists and closes when the probe passes', async () => {
    const { onClose, onSaved, getApi } = renderForm({ mode: 'create' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    clickSave();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(maker.testProviderConnection).toHaveBeenCalledTimes(1);
    expect(maker.createCustomProvider).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(expect.any(String));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Ruling 14：保存即测试——落库后的 status 就是本次探测结果（非 untested）。
    expect(getApi().entries[0]!.status).toEqual({ ok: true, latencyMs: 128 });
  });

  it('edit save writes this probe result as the row status', async () => {
    // Ruling 14：改过 baseUrl/modelId 的编辑保存也写本次探测结果，不再置 untested。
    const editPhase = renderForm({
      mode: 'edit',
      initial: { id: 'm-existing', baseUrl: 'https://gw.example/anthropic', modelId: 'm-existing' },
    });
    await act(async () => {});
    await act(async () => {
      await editPhase.getApi().add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-m-existing',
        modelId: 'm-existing',
      });
    });
    // 播种条目此时还是 untested（store.add 的初始值）。
    expect(editPhase.getApi().entries[0]!.status).toBe('untested');

    fillFields({ modelId: 'm-renamed' });
    clickSave();

    await waitFor(() => expect(editPhase.onSaved).toHaveBeenCalledTimes(1));
    expect(maker.updateCustomProvider).toHaveBeenCalledTimes(1);
    expect(editPhase.onClose).toHaveBeenCalledTimes(1);
    expect(editPhase.getApi().entries[0]!.status).toEqual({ ok: true, latencyMs: 128 });
  });

  it('has no delete button in either mode', async () => {
    renderForm({ mode: 'create' });
    await act(async () => {});
    expect(screen.queryByText('settings.providers.modelGateway.delete')).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
    cleanup();

    renderForm({
      mode: 'edit',
      initial: { id: 'p1', baseUrl: 'https://gw.example/anthropic', modelId: 'm1' },
    });
    await act(async () => {});
    expect(screen.queryByText('settings.providers.modelGateway.delete')).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('edit mode prefills endpoint and model; key shows placeholder not the saved value', async () => {
    const { container } = render(
      <ModelGatewayProvider>
        <ModelGatewayForm
          open
          mode="edit"
          initial={{
            id: 'p1',
            baseUrl: 'https://gw.example/anthropic',
            apiKey: 'sk-secret-saved',
            modelId: 'mimo-test',
          }}
          onClose={() => {}}
          onSaved={() => {}}
        />
      </ModelGatewayProvider>,
    );
    await act(async () => {});

    const endpoint = screen.getByLabelText(ENDPOINT_LABEL) as HTMLInputElement;
    const key = screen.getByLabelText(KEY_LABEL) as HTMLInputElement;
    const model = screen.getByLabelText(MODEL_LABEL) as HTMLInputElement;
    expect(endpoint.value).toBe('https://gw.example/anthropic');
    expect(model.value).toBe('mimo-test');
    // 密钥不回显：空值 + 「保持不变」占位；已存密钥不进 DOM。
    expect(key.value).toBe('');
    expect(key.placeholder).toBe(KEY_KEEP_PLACEHOLDER);
    expect(key.type).toBe('password');
    expect(container.textContent).not.toContain('sk-secret-saved');
  });

  it('probe failure never persists: neither add nor update is called', async () => {
    maker.testProviderConnection = vi.fn(async () => ({ ok: false, code: 'ENDPOINT_NOT_FOUND', latencyMs: 0 }));

    // 创建路径：探测失败 → create 不发。
    const createPhase = renderForm({ mode: 'create' });
    await act(async () => {});
    fillFields({ baseUrl: 'https://bad.example/anthropic', apiKey: 'sk-fake', modelId: 'm1' });
    clickSave();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(createPhase.onClose).not.toHaveBeenCalled();
    cleanup();

    // 编辑路径：同 store 播真实条目（播完清掉创建计数），探测失败 → update 不发。
    // 初始 modelId 播种出稳定 id 'm-existing'（uniqueCustomProviderId 派生），与 initial.id 对齐。
    const editPhase = renderForm({
      mode: 'edit',
      initial: { id: 'm-existing', baseUrl: 'https://gw.example/anthropic', modelId: 'm-existing' },
    });
    await act(async () => {});
    await act(async () => {
      await editPhase.getApi().add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-m-existing',
        modelId: 'm-existing',
      });
    });
    maker.createCustomProvider.mockClear();
    fillFields({ baseUrl: 'https://bad.example/anthropic' });
    clickSave();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    // 硬保证：测不通不让存——create 与 update 都不被调用。
    expect(maker.createCustomProvider).not.toHaveBeenCalled();
    expect(maker.updateCustomProvider).not.toHaveBeenCalled();
    expect(maker.testProviderConnection).toHaveBeenCalled();
    expect(editPhase.onClose).not.toHaveBeenCalled();
  });

  it('Esc with non-editable focus closes only the form, never cascades to settings', async () => {
    // useSettingsEscape 同款：Settings 更早挂在 window 冒泡、关闭路径不看
    // defaultPrevented——弹窗必须用 capture 抢占，一次按键只退一层。
    const settingsEscape = vi.fn();
    window.addEventListener('keydown', settingsEscape);
    try {
      const { onClose } = renderForm({ mode: 'create' });
      await act(async () => {});
      // 焦点放在非可编辑处（保存按钮）——级联双关最容易发生的路径。
      const saveBtn = screen.getByRole('button', { name: SAVE_LABEL });
      act(() => {
        saveBtn.focus();
      });
      fireEvent.keyDown(saveBtn, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(settingsEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', settingsEscape);
    }
  });

  it('clears the typed key from state when the dialog closes (Ruling 16)', async () => {
    const props = { mode: 'create' as const, onClose: vi.fn(), onSaved: vi.fn() };
    const view = render(
      <ModelGatewayProvider>
        <ModelGatewayForm open {...props} />
      </ModelGatewayProvider>,
    );
    await act(async () => {});
    fireEvent.change(screen.getByLabelText(KEY_LABEL), { target: { value: 'sk-typed-secret' } });
    expect((screen.getByLabelText(KEY_LABEL) as HTMLInputElement).value).toBe('sk-typed-secret');

    // 父级关窗（组件常驻挂载，只换 open）：密钥须在关闭路径被清掉。
    view.rerender(
      <ModelGatewayProvider>
        <ModelGatewayForm open={false} {...props} />
      </ModelGatewayProvider>,
    );
    // 重开：若关闭时没清、只靠 open 复位，此处会残留上一次键入的 key。
    view.rerender(
      <ModelGatewayProvider>
        <ModelGatewayForm open {...props} />
      </ModelGatewayProvider>,
    );
    expect((screen.getByLabelText(KEY_LABEL) as HTMLInputElement).value).toBe('');
  });
});
