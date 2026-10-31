/** @vitest-environment jsdom */

/**
 * ModelGatewayForm — 添加 / 编辑模型的三栏弹窗（设计稿 §5.2 / PRD 2026-11-01）。
 *
 * 走真实生产入口：表单挂真实 `ModelGatewayProvider`（Task 1 store，add/update 走真
 * `create/updateCustomProvider` IPC），只在 IPC 边界打桩。断言看可观察结果：
 * 合法性门（三项合法 + 不重复才可保存、不合法零写盘）、保存不探测、存后条目恒
 * 「未测试」；行内错触焦后才显示（touched）；遮罩 dirty 抖动不关 / clean 可关，
 * Esc / 取消 / ✕ 任何状态可关；密钥契约不变。
 *
 * 凭证契约：编辑态密钥不回显（占位「保持不变」），留空沿用已存（keychain 现读）。
 * i18n 在测试里打桩为 key 直出（带 `{{model}}` 时拼 `key:model`），断言 key 而非译文；
 * 译文（PRD 文案）在 5 语 locale JSON 里逐 key 落位。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import { ModelGatewayProvider, useModelGateway } from '../ModelGatewayStore';
import { ModelGatewayForm, type ModelGatewayFormProps } from '../ModelGatewayForm';
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
let safeStorageRead: ReturnType<typeof vi.fn>;

const ENDPOINT_LABEL = 'settings.providers.modelDialog.endpoint';
const KEY_LABEL = 'settings.providers.modelDialog.key';
const MODEL_LABEL = 'settings.providers.modelDialog.model';
const SAVE_LABEL = 'settings.providers.custom.save';
const CANCEL_LABEL = 'settings.providers.custom.cancel';
const CLOSE_LABEL = 'settings.providers.modelDialog.close';
const KEY_KEEP_PLACEHOLDER = 'settings.providers.custom.fields.apiKeyEditPlaceholder';
// 行内错 / 帮助文案的 key（PRD 文案的 5 语正本在 locale JSON）。
const ERR_ENDPOINT_REQUIRED = 'settings.providers.modelDialog.baseUrlRequired';
const ERR_ENDPOINT_INVALID = 'settings.providers.modelDialog.baseUrlInvalid';
const ERR_URL_NO_CREDENTIALS = 'settings.providers.modelDialog.urlNoCredentials';
const ERR_KEY_REQUIRED = 'settings.providers.modelDialog.apiKeyRequired';
const ERR_MODEL_REQUIRED = 'settings.providers.modelDialog.modelIdRequired';
const ERR_MODEL_DUPLICATE = 'settings.providers.modelDialog.modelIdDuplicate';
const MODEL_HINT = 'settings.providers.modelDialog.modelHint';

/** 表单与 store 探针共享同一 `ModelGatewayProvider` 实例（edit 播种要用到）。 */
function renderForm(props: {
  mode: 'create' | 'edit';
  initial?: ModelGatewayFormProps['initial'];
  open?: boolean;
}) {
  let api: ModelGatewayApi | null = null;
  function Probe() {
    api = useModelGateway();
    return null;
  }
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const tree = (open: boolean) => (
    <ModelGatewayProvider>
      <Probe />
      <ModelGatewayForm
        open={open}
        mode={props.mode}
        initial={props.initial}
        onClose={onClose}
        onSaved={onSaved}
      />
    </ModelGatewayProvider>
  );
  const view = render(tree(props.open ?? true));
  return {
    onSaved,
    onClose,
    getApi: () => api!,
    view,
    /** 父级换 `open`（组件常驻挂载语义），Ruling 16 关闭清密钥要靠它复现。 */
    setOpen: (open: boolean) => view.rerender(tree(open)),
  };
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
  fireEvent.click(saveButton());
}

function saveButton() {
  return screen.getByRole('button', { name: SAVE_LABEL }) as HTMLButtonElement;
}

function expectSaveDisabled(disabled: boolean) {
  expect(saveButton().disabled).toBe(disabled);
}

/** 触焦后才显示（touched）：行内错的唯一显示门槛是 blur 过该字段。 */
function blurField(label: string) {
  fireEvent.blur(screen.getByLabelText(label));
}

describe('ModelGatewayForm', () => {
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
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('settings.providers.modelDialog.savedToast:m-renamed');
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

  it('test_save_requires_all_three_and_persists_untested', async () => {
    // 合法性门（PRD）：缺任一项 / URL 不合法 → 保存禁用且零写盘；三项合法才可点，
    // 保存调 add、不调 testModelConnectivity，落库后恒「未测试」。
    const { onClose, onSaved, getApi } = renderForm({ mode: 'create' });
    await act(async () => {});

    expectSaveDisabled(true);
    fillFields({ baseUrl: 'https://gw.example/a', apiKey: 'sk-ok' });
    expectSaveDisabled(true);
    fillFields({ baseUrl: '', apiKey: 'sk-ok', modelId: 'm1' });
    expectSaveDisabled(true);
    fillFields({ baseUrl: 'https://gw.example/a', apiKey: '', modelId: 'm1' });
    expectSaveDisabled(true);
    fillFields({ baseUrl: 'not-a-url', apiKey: 'sk-ok', modelId: 'm1' });
    expectSaveDisabled(true);
    clickSave();
    expect(maker.createCustomProvider).not.toHaveBeenCalled();

    fillFields({ baseUrl: 'http://gw.example/anthropic', apiKey: 'sk-ok', modelId: 'm1' });
    expectSaveDisabled(false);
    clickSave();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(maker.createCustomProvider).toHaveBeenCalledTimes(1);
    expect(maker.testProviderConnection).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getApi().entries[0]!.status).toBe('untested');
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('settings.providers.modelDialog.addedToast:m1');
  });

  it('test_duplicate_model_id_rejected_but_self_edit_ok', async () => {
    // PRD 重复拦截：与任一其它条目 modelId 相同 → 保存禁用 + 行内错「该模型已添加」；
    // 编辑回填自身 modelId 不算重复。
    const created = renderForm({ mode: 'create' });
    await act(async () => {});
    await act(async () => {
      await created.getApi().add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-dup',
        modelId: 'm-dup',
      });
    });

    fillFields({ baseUrl: 'https://gw.example/anthropic', apiKey: 'sk-new', modelId: 'm-dup' });
    expectSaveDisabled(true);
    blurField(MODEL_LABEL);
    expect(screen.getByText(ERR_MODEL_DUPLICATE)).toBeTruthy();
    maker.createCustomProvider.mockClear();
    clickSave();
    expect(maker.createCustomProvider).not.toHaveBeenCalled();
    cleanup();

    // 编辑自身：回填的 modelId 与自己的条目相同 → 不报重复、保存可点。
    const edited = renderForm({
      mode: 'edit',
      initial: { id: 'm-dup', baseUrl: 'https://gw.example/anthropic', modelId: 'm-dup' },
    });
    await act(async () => {});
    await act(async () => {
      await edited.getApi().add({
        baseUrl: 'https://gw.example/anthropic',
        apiKey: 'sk-dup',
        modelId: 'm-dup',
      });
    });
    expectSaveDisabled(false);
    blurField(MODEL_LABEL);
    expect(screen.queryByText(ERR_MODEL_DUPLICATE)).toBeNull();
    expect(screen.queryByText(ERR_MODEL_REQUIRED)).toBeNull();
  });

  it('test_scrim_shake_when_dirty_and_escape_always_closes', async () => {
    // 遮罩语义分层（PRD 2026-11-01，推翻旧「遮罩可关」登记）：dirty 点遮罩不关 +
    // 面板 shake；clean 点遮罩可关；Esc / 取消 / ✕ 任何状态都关。关闭后密钥清空
    // （Ruling 16 回归）。
    const { onClose, view, setOpen } = renderForm({ mode: 'create' });
    await act(async () => {});
    const scrim = view.container.querySelector('.modal-scrim')!;
    const panel = view.container.querySelector('.modal-panel')!;

    // clean 点遮罩 → 关。
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    // dirty 点遮罩 → 不关 + shake 类；再点仍不关（动画重启不炸）。
    fillFields({ apiKey: 'sk-typed-secret' });
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel.classList.contains('shake')).toBe(true);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Esc（dirty 也关）/ 取消 / ✕ 任何状态都关。
    fireEvent.keyDown(screen.getByLabelText(KEY_LABEL), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: CANCEL_LABEL }));
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: CLOSE_LABEL }));
    expect(onClose).toHaveBeenCalledTimes(4);

    // 关闭后密钥 state 清空（Ruling 16：组件常驻挂载，重开不得残留）。
    setOpen(false);
    setOpen(true);
    expect((screen.getByLabelText(KEY_LABEL) as HTMLInputElement).value).toBe('');
  });

  it('inline errors show only after blur (touched) with PRD copy keys', async () => {
    // PRD：行内错触焦后才显示；未出错时「模型」字段显示帮助文案（出错时被错误取代）。
    renderForm({ mode: 'create' });
    await act(async () => {});

    expect(screen.queryByText(ERR_ENDPOINT_REQUIRED)).toBeNull();
    expect(screen.queryByText(ERR_KEY_REQUIRED)).toBeNull();
    expect(screen.queryByText(ERR_MODEL_REQUIRED)).toBeNull();
    expect(screen.getByText(MODEL_HINT)).toBeTruthy();

    blurField(ENDPOINT_LABEL);
    expect(screen.getByText(ERR_ENDPOINT_REQUIRED)).toBeTruthy();
    fillFields({ baseUrl: 'not-a-url' });
    expect(screen.getByText(ERR_ENDPOINT_INVALID)).toBeTruthy();
    expect(screen.queryByText(ERR_ENDPOINT_REQUIRED)).toBeNull();

    blurField(KEY_LABEL);
    expect(screen.getByText(ERR_KEY_REQUIRED)).toBeTruthy();

    blurField(MODEL_LABEL);
    expect(screen.getByText(ERR_MODEL_REQUIRED)).toBeTruthy();
    // 出错时帮助文案让位给错误（PRD：msg 只有一行）。
    expect(screen.queryByText(MODEL_HINT)).toBeNull();
  });

  it('test_url_rejects_userinfo_but_allows_at_in_path_or_query', async () => {
    // Ruling 27：baseUrl 原样写进 ~/.hrbuddy/models.json（凭证绝不落盘的红线文件），
    // basic-auth userinfo（用户名/密码）不得通过校验；判 userinfo 只认 URL 解析结果，
    // path / query 里的 `@` 不算、不误伤。
    const { onClose, onSaved } = renderForm({ mode: 'create' });
    await act(async () => {});

    fillFields({
      baseUrl: 'https://user:pass@example.com/anthropic',
      apiKey: 'sk-ok',
      modelId: 'm1',
    });
    expectSaveDisabled(true);
    blurField(ENDPOINT_LABEL);
    expect(screen.getByText(ERR_URL_NO_CREDENTIALS)).toBeTruthy();
    clickSave();
    expect(maker.createCustomProvider).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 只有用户名也算 userinfo，照拒。
    fillFields({ baseUrl: 'https://user@example.com/anthropic' });
    expectSaveDisabled(true);
    expect(screen.getByText(ERR_URL_NO_CREDENTIALS)).toBeTruthy();

    // path / query 里的 @ 不是 userinfo：PRD 格式检查照常放行。
    fillFields({ baseUrl: 'https://example.com/anthropic@v1?u=a@b' });
    expectSaveDisabled(false);
    expect(screen.queryByText(ERR_URL_NO_CREDENTIALS)).toBeNull();
  });

  it('test_url_parse_failure_rejected_as_format_invalid', async () => {
    // Ruling 28：格式正则过但 `new URL()` 解析抛（如非法端口）不得空转放行——
    // `https://user:pass@host:99999` 这类复合输入会把 userinfo 带进 models.json
    // （凭证红线）。按既有格式错拒收，不新增文案 key。
    const { onSaved } = renderForm({ mode: 'create' });
    await act(async () => {});

    fillFields({
      baseUrl: 'https://user:pass@host:99999',
      apiKey: 'sk-ok',
      modelId: 'm1',
    });
    expectSaveDisabled(true);
    blurField(ENDPOINT_LABEL);
    expect(screen.getByText(ERR_ENDPOINT_INVALID)).toBeTruthy();
    clickSave();
    expect(maker.createCustomProvider).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
