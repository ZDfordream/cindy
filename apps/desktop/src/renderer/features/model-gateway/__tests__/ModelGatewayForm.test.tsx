/** @vitest-environment jsdom */

/**
 * ModelGatewayForm — 添加 / 编辑模型的三栏弹窗（设计稿 §5.2）。
 *
 * 走真实生产入口：表单挂真实 `ModelGatewayProvider`（Task 1 store，add/update 走真
 * `create/updateCustomProvider` IPC），只在 IPC 边界打桩。断言看可观察结果：
 * 合法即存（保存不探测、不看连通性），存后条目恒「未测试」；密钥契约不变。
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
  exportHrbuddyModels: ReturnType<typeof vi.fn>;
  testProviderConnection: ReturnType<typeof vi.fn>;
}

let maker: MakerMock;
let safeStorageRead: ReturnType<typeof vi.fn>;

const ENDPOINT_LABEL = 'settings.providers.modelDialog.endpoint';
const KEY_LABEL = 'settings.providers.modelDialog.key';
const MODEL_LABEL = 'settings.providers.modelDialog.model';
const SAVE_LABEL = 'settings.providers.custom.save';
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
      exportHrbuddyModels: vi.fn(async () => undefined),
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

  it('save persists without probing (connectivity never gates save)', async () => {
    // PRD：合法即存——保存门是合法性校验，连通性不再拦截落库（也不探测）。
    maker.testProviderConnection = vi.fn(async () => ({ ok: false, code: 'AUTH_INVALID', latencyMs: 0 }));
    const { onClose, onSaved } = renderForm({ mode: 'create' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/fail', apiKey: 'sk-fake', modelId: 'm1' });
    clickSave();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(maker.testProviderConnection).not.toHaveBeenCalled();
    expect(maker.createCustomProvider).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('save persists and closes; the row starts untested', async () => {
    const { onClose, onSaved, getApi } = renderForm({ mode: 'create' });
    await act(async () => {});

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    clickSave();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(maker.testProviderConnection).not.toHaveBeenCalled();
    expect(maker.createCustomProvider).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(expect.any(String));
    expect(onClose).toHaveBeenCalledTimes(1);
    // PRD 推翻 Ruling 14：保存不探测，落库后的 status 恒「未测试」。
    expect(getApi().entries[0]!.status).toBe('untested');
  });

  it('edit save leaves the row untested when fields change', async () => {
    // PRD 推翻 Ruling 14：改过字段的编辑保存不再写探测结果，行回「未测试」。
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
    await act(async () => {
      await editPhase.getApi().setStatus('m-existing', { ok: true, latencyMs: 80 });
    });
    expect(editPhase.getApi().entries[0]!.status).toEqual({ ok: true, latencyMs: 80 });

    fillFields({ modelId: 'm-renamed' });
    clickSave();

    await waitFor(() => expect(editPhase.onSaved).toHaveBeenCalledTimes(1));
    expect(maker.updateCustomProvider).toHaveBeenCalledTimes(1);
    expect(editPhase.onClose).toHaveBeenCalledTimes(1);
    expect(maker.testProviderConnection).not.toHaveBeenCalled();
    expect(editPhase.getApi().entries[0]!.status).toBe('untested');
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
