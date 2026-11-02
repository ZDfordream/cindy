/** @vitest-environment jsdom */

/**
 * homeOnboardingGate — S4 两态首页（S4a 已配置 / S4b 未配置）+ 补配门禁 + 转场。
 *
 * 走真实生产入口：真实 `ModelGatewayProvider` + 真实 `HomeOnboardingGateProvider`
 * （含 `OnboardingModelDialog` 宿主与 inert 面）+ 真实 `OnboardingHomeBanner` +
 * 真实 `ChatInput`（首页草稿，内含真实 `ChatModelMenu`）+ 真实 `runHomeSuggestion`
 * 填入链（composerDraftStore → 编辑器），只在 IPC / 语音 / 站点导航边界打桩。
 * 断言看用户可观察结果：横幅与选择器两态、四个门禁入口开弹窗不动作、输入保留、
 * 加载窗口置灰且绝不弹「无来源」、保存成功横幅折叠 + 圆点变绿 + 输入可立即发送、
 * 弹窗打开期间首页 inert + aria-hidden 且重复触发被吞。
 *
 * 测试价值
 * - 生产入口与可观察结果：首页发送 / 模型选择器 / 推荐问题 / 横幅「去配置」四个
 *   补配门禁入口（PRD §6.4 FR-HOME-06/07/08/09、AC-12/13）；S4b 打开添加模型弹窗
 *   （origin=home，无「跳过，稍后配置」）而不发送、输入保留；S4a 横幅不显示、圆点
 *   绿 + 模型 ID、推荐只填入不自动发送；`hydrated === false` 加载窗口 Send 置灰、
 *   直接 / 间接派发都静默等待且**不弹**「当前模型没有可用来源」（Review Focus #5，
 *   冷启动竞态回归的门禁半边）；保存成功后横幅折叠、圆点变绿、输入保留可立即发送
 *   （T5/T8）；弹窗打开期间首页 `inert` + `aria-hidden`、重复点击不二次触发
 *   （Review Focus #6 / PRD §8.3、§9.6）。
 * - Bug／规则依据：login-onboarding PRD §6.4 两态与门禁、§8.1「跳过后再次门禁」、
 *   §9.2 T5/T8 转场、§9.6 防重入；发送门禁冷启动竞态（785f582125）「未加载 ≠ 无
 *   模型」不得回归；Task 5 弹窗成功尾 `onSaved` + `onClose` 双回调合同（宿主不得把
 *   onClose 当用户放弃）。
 * - 现有覆盖缺口：`chatInputModelLoading.test.tsx` 只钉「加载窗口不弹无来源」与稳态
 *   真零来源弹框（无首页两态 / 无补配弹窗 / 无横幅）；`ChatModelMenu.test.tsx` 只有
 *   S4a 下拉与空态指设置，无 S4b 红点 / 点击开弹窗；`onboardingModelDialog.test.tsx`
 *   只测弹窗自身，无宿主两态、折叠、inert 与门禁入口。
 * - 最小失败输入：`hydrated && entries.length === 0` + 输入框有字 → 点发送即复现
 *   （旧码 RED：发出去或弹「无来源」，而不是开补配弹窗）；`listProviders` 悬着 →
 *   点发送即复现加载窗口误判。
 * - tier：unit（jsdom，真实 store + 组件，IPC 边界打桩；450ms 成功保持用 fake
 *   timers，不真实等待）。
 * - 实测耗时：整文件 5.6–7.4s 墙钟（`pnpm --dir apps/desktop exec vitest run
 *   src/renderer/features/model-gateway/__tests__/homeOnboardingGate.test.tsx`，10 用例
 *   执行 0.6s；其余为真实 ChatInput 树的导入收集，与 chatInputModelLoading.test.tsx
 *   同量级——该文件同套 mock 面 6.8s）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';
import type { ComponentProps, ReactNode } from 'react';
import type { ProviderView } from '@cindy/model-providers';

import { ModelGatewayProvider } from '../ModelGatewayStore';
import {
  HomeOnboardingGateProvider,
  applyHomeSuggestion,
  useHomeGateSurface,
} from '../homeOnboardingGate';
import { OnboardingHomeBanner } from '../OnboardingHomeBanner';
import { ChatInput } from '@/components/new-chat/ChatInput';
import {
  plainTextToTiptapDoc,
  saveDraft as saveComposerDraft,
  clearDraft as clearComposerDraft,
} from '@/lib/composerDraftStore';

// 用户可观察文案断言用真实 zh-CN（与 ChatModelMenu.test 同法）；其余 key 原样返回。
const COPY: Record<string, string> = {
  'onboarding.homeBanner.title': '还没有配置模型',
  'onboarding.homeBanner.sub': '添加一个模型后，就可以开始对话了',
  'onboarding.homeBanner.action': '去配置',
  'newChat.chatModelMenu.unconfigured': '未配置模型',
  'newChat.chatModelMenu.triggerAria': '选择模型',
  'newChat.chatModelMenu.placeholder': '选择模型',
  'newChat.chatModelMenu.empty': '还没有可用的模型',
  'newChat.chatModelMenu.openSettings': '去设置',
  'settings.providers.modelDialog.skip': '跳过，稍后配置',
  'newChat.sendButton.send': '发送',
};
const t = (key: string) => COPY[key] ?? key;

// FR-HOME-BANNER-01 改版文案：标题（副文案见 homeBanner.test.tsx 的规格断言）。
const BANNER_TEXT = '还没有配置模型';
const BANNER_ACTION = '去配置';
const SELECTOR_LABEL = '选择模型';
const UNCONFIGURED_LABEL = '未配置模型';
const SEND_LABEL = '发送';
const SKIP_LABEL = '跳过，稍后配置';
const DRAFT_KEY = 'home-onboarding-gate-test';

const h = vi.hoisted(() => ({
  editor: null as Editor | null,
  listening: false,
  stop: vi.fn().mockResolvedValue(undefined),
  confirm: vi.fn(),
  gatewayProviders: [] as ProviderView[],
  localProviders: [] as ProviderView[],
  connectedSourceLoading: false,
  listGatewayProviders: (): Promise<{ providers: ProviderView[] }> =>
    Promise.resolve({ providers: [] as ProviderView[] }),
  // 探测 / 落库 IPC（保存成功例手动结算探测，不真实等待）。
  testProviderConnection: (): Promise<{ ok: boolean; latencyMs?: number }> =>
    Promise.resolve({ ok: true, latencyMs: 128 }),
  createCustomProvider: (): Promise<{ ok: boolean }> => Promise.resolve({ ok: true }),
  safeStorageRead: (): Promise<string> => Promise.resolve('sk-test'),
}));

vi.mock('react-i18next', async (original) => ({
  ...await original<typeof import('react-i18next')>(),
  useTranslation: () => ({ t }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: h.confirm }) }));
vi.mock('@/components/sidebar/SortableList', () => ({
  SortableList: ({ items, renderItem, role, ariaLabel, className }: {
    items: readonly unknown[];
    renderItem: (item: unknown, index: number) => ReactNode;
    role?: string;
    ariaLabel?: string;
    className?: string;
  }) => (
    <div role={role} aria-label={ariaLabel} className={className}>
      {items.map((item, index) => <div key={index}>{renderItem(item, index)}</div>)}
    </div>
  ),
}));
vi.mock('@/components/new-chat/ModelSelector', async (original) => ({
  ...await original<typeof import('@/components/new-chat/ModelSelector')>(),
  ModelSelector: ({ modelId, disabled }: { modelId: string; disabled?: boolean }) => (
    <button data-testid="model-selector" disabled={disabled}>{modelId}</button>
  ),
}));
vi.mock('@/hooks/useSshCodexProviders', () => ({
  useSshCodexProviders: () => ({ providers: [], status: 'ready', refresh: () => {} }),
}));
vi.mock('@/components/new-chat/ExtraDirsButton', () => ({ ExtraDirsButton: () => null }));
vi.mock('@/components/new-chat/PermissionSelector', () => ({ PermissionSelector: () => <span data-testid="permission-selector" /> }));
vi.mock('@/components/new-chat/NewGoalDialog', () => ({ NewGoalDialog: () => null }));
vi.mock('@/components/new-chat/FolderPickerPopover', () => ({ FolderPickerPopover: () => null, addRecentFolder: vi.fn() }));
vi.mock('@/components/new-chat/AtMentionPanel', () => ({ AtMentionPanel: () => null }));
vi.mock('@/components/new-chat/SlashCommandPalette', () => ({ SlashCommandPalette: () => null }));
vi.mock('@/voice-input/VoiceInputPointerHintLayer', () => ({ VoiceInputPointerHintLayer: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/voice-input/VoiceInputStatusNotice', () => ({ VoiceInputStatusNotice: () => null }));
vi.mock('@/voice-input/useVoiceInput', () => ({
  useVoiceInput: (editor: Editor | null) => {
    h.editor = editor;
    return {
      state: h.listening ? 'listening' : 'idle',
      isListening: h.listening,
      isBusy: h.listening,
      draftText: '',
      start: vi.fn(),
      stop: h.stop,
      cancel: vi.fn(),
    };
  },
}));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: h.localProviders, loading: false }) }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => ({ providers: [], loading: false, unsupported: false }) }));
vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: h.connectedSourceLoading }),
}));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({ agents: [], loading: false }) }));
vi.mock('@/hooks/useAgentCapabilities', async (original) => ({
  ...await original<typeof import('@/hooks/useAgentCapabilities')>(),
  useAgentCapabilities: () => ({ capabilities: null, loading: false }),
}));

const noOp = () => {};
const api: typeof window.electronAPI = new Proxy({} as typeof window.electronAPI, {
  get: (_obj, key) => {
    if (key === 'listSync') return () => ({ ghosts: [] });
    if (key === 'listProviders') return () => h.listGatewayProviders();
    if (key === 'testProviderConnection') return h.testProviderConnection;
    if (key === 'createCustomProvider') return h.createCustomProvider;
    if (key === 'safeStorageRead') return h.safeStorageRead;
    if (key === 'getDataSnapshot') return () => { throw new Error('test bridge unavailable'); };
    if (key === 'setGlobalShortcut') return () => Promise.resolve({ ok: true });
    if (key === 'platform') return 'darwin';
    if (key === 'then') return undefined;
    if (String(key).startsWith('on')) return () => noOp;
    return new Proxy(() => Promise.resolve(undefined), { get: (_fn, nested) => Reflect.get(api, nested) });
  },
});

// jsdom 未实现 Range 的 getClientRects / getBoundingClientRect：prosemirror 的滚动
// 定位（草稿填入后的 focus('end')）会拿 Range 调它们；补空几何即可，断言不依赖布局。
const emptyRects = () => [] as unknown as DOMRectList;
const emptyRect = () =>
  ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
for (const proto of [Element.prototype, Text.prototype, Range.prototype] as {
  getClientRects?: unknown;
  getBoundingClientRect?: unknown;
}[]) {
  if (!proto.getClientRects) proto.getClientRects = emptyRects;
  if (!proto.getBoundingClientRect) proto.getBoundingClientRect = emptyRect;
}

const attachments: ComponentProps<typeof ChatInput>['attachmentState'] = {
  attachments: [], hasAttachments: false, addFiles: vi.fn(), addClipboardImage: vi.fn(),
  rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
  pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
  pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
  removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles: noOp, restoreFiles: (files) => [...files],
};

const homeProps: ComponentProps<typeof ChatInput> = {
  sessionId: undefined,
  initialWorkingDir: '/workspace',
  runtimeAgentKind: 'claude-code',
  vendorKey: 'cc',
  deviceLinkDeviceId: null,
  attachmentState: attachments,
  hideRuntimeControls: false,
  showFolderPicker: false,
  disableAutofocus: true,
  draftKey: DRAFT_KEY,
  initialModel: 'claude-opus-5',
  initialProviderId: 'xd',
  onSend: vi.fn().mockResolvedValue(true),
};

/** 网关条目夹具（与 chatInputModelLoading 同形：source=user 即 model-gateway 条目）。 */
function gatewayEntryProvider(modelId = 'gw-model-alpha', id = 'gw-entry'): ProviderView {
  return {
    id,
    name: modelId,
    source: 'user',
    connected: true,
    agents: ['claude-code'],
    auth: { method: 'apiKey' },
    routing: { 'claude-code': { upstream: 'https://gw.example.test', authStrategy: 'api-key-header' } },
    models: {
      'claude-code': [
        { id: modelId, name: modelId, catalogPresetId: 'hrbuddy-gateway', contextWindow: 200_000, efforts: [], defaultEffort: null },
      ],
    },
  };
}

/** 手动结算的 listProviders：拉宽「未 hydrated」加载窗口，不真实等待。 */
function deferredGatewayLoad() {
  let resolve!: (value: { providers: ProviderView[] }) => void;
  const promise = new Promise<{ providers: ProviderView[] }>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * 首页门禁面（与 NewMakerDraftRoute 同构）：横幅由宿主按 `useHomeGateSurface().phase`
 * 挂载，推荐问题走生产 `applyHomeSuggestion`（填入 + 门禁），ChatInput 是真实输入卡。
 */
function renderHomeGate(options?: { onSend?: ReturnType<typeof vi.fn> }) {
  const onSend = options?.onSend ?? vi.fn().mockResolvedValue(true);
  function BannerHost() {
    const surface = useHomeGateSurface();
    return (
      <OnboardingHomeBanner
        visible={surface?.phase === 'unconfigured'}
        onConfigure={() => surface?.gate('banner')}
      />
    );
  }
  function SuggestionHost() {
    const surface = useHomeGateSurface();
    return (
      <button
        type="button"
        data-testid="home-suggestion"
        onClick={() =>
          applyHomeSuggestion(surface, (prompt) => {
            saveComposerDraft(DRAFT_KEY, { text: plainTextToTiptapDoc(prompt), attachments: [] });
          }, '把照片整理成时间线')
        }
      >
        把照片整理成时间线
      </button>
    );
  }
  render(
    <ModelGatewayProvider>
      <HomeOnboardingGateProvider>
        <BannerHost />
        <ChatInput {...homeProps} onSend={onSend} />
        <SuggestionHost />
      </HomeOnboardingGateProvider>
    </ModelGatewayProvider>,
  );
  return { onSend };
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: SEND_LABEL }) as HTMLButtonElement;
}

function selectorTrigger(): HTMLButtonElement {
  return screen.getByRole('button', { name: SELECTOR_LABEL }) as HTMLButtonElement;
}

async function setEditorText(text: string) {
  await act(async () => {
    h.editor!.commands.setContent(`<p>${text}</p>`);
  });
}

function editorText(): string {
  return h.editor!.getText();
}

describe('homeOnboardingGate', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.electronAPI = api;
    h.listening = false;
    h.confirm.mockReset();
    h.gatewayProviders = [];
    h.localProviders = [];
    h.connectedSourceLoading = false;
    h.listGatewayProviders = () => Promise.resolve({ providers: h.gatewayProviders });
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => {
    cleanup();
    clearComposerDraft(DRAFT_KEY);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('test_unconfigured_banner_and_selector_present_the_s4b_state', async () => {
    // S4b 两态呈现（FR-HOME-06/08）：横幅文案 + 去配置；选择器红点态 + 「未配置模型」。
    h.gatewayProviders = [];
    renderHomeGate();
    await act(async () => {});

    expect(screen.getByText(BANNER_TEXT)).toBeTruthy();
    expect(screen.getByRole('button', { name: BANNER_ACTION })).toBeTruthy();
    const trigger = selectorTrigger();
    expect(within(trigger).getByText(UNCONFIGURED_LABEL)).toBeTruthy();
    // 二态圆点：未配置 = 红点态（240ms 变色过渡由 --motion-model-dot-flip 承载）。
    expect(screen.getByTestId('chat-model-status-dot').getAttribute('data-state')).toBe('unconfigured');
  });

  it.each([
    ['send', async () => {
      await setEditorText('保留我');
      await act(async () => { fireEvent.click(sendButton()); });
    }],
    ['enter', async () => {
      await setEditorText('保留我');
      // 间接派发（Enter）同样是「发送类动作」：S4b 开弹窗而不是发送。
      await act(async () => { fireEvent.keyDown(h.editor!.view.dom, { key: 'Enter', code: 'Enter' }); });
    }],
    ['selector', async () => {
      await setEditorText('保留我');
      await act(async () => { fireEvent.click(selectorTrigger()); });
    }],
    ['banner', async () => {
      await setEditorText('保留我');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: BANNER_ACTION })); });
    }],
  ])('test_unconfigured_%s_gate_opens_add_model_dialog_and_keeps_input', async (_entry, actOnEntry) => {
    // S4b 门禁（AC-12）：发送 / Enter / 选择器 / 去配置打开添加模型弹窗（origin=home，
    // 无跳过出口）而不动作；输入框原样保留。
    h.gatewayProviders = [];
    const { onSend } = renderHomeGate();
    await act(async () => {});

    await actOnEntry();

    expect(screen.getByRole('dialog')).toBeTruthy();
    // origin=home 证据：没有「跳过，稍后配置」（onboarding 来源才有）。
    expect(screen.queryByRole('button', { name: SKIP_LABEL })).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(editorText()).toBe('保留我');
  });

  it('test_unconfigured_suggestion_fills_input_opens_dialog_without_sending', async () => {
    // S4b 推荐问题（FR-HOME-09）：填入输入框 + 开弹窗，不自动发送。
    h.gatewayProviders = [];
    const { onSend } = renderHomeGate();
    await act(async () => {});

    await act(async () => { fireEvent.click(screen.getByTestId('home-suggestion')); });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    await waitFor(() => expect(editorText()).toBe('把照片整理成时间线'));
  });

  it('test_configured_hides_banner_shows_green_dot_and_suggestion_fills_only', async () => {
    // S4a（AC-11/13）：横幅不显示；选择器绿点 + 模型 ID；推荐只填入不发送不开弹窗。
    h.gatewayProviders = [gatewayEntryProvider()];
    h.localProviders = [gatewayEntryProvider()];
    const { onSend } = renderHomeGate();
    await waitFor(() => expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe('gw-model-alpha'));

    // 横幅折叠不可见：无横幅文案、无「去配置」（aria-hidden 折叠层被无障碍树剔除）。
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
    expect(screen.queryByRole('button', { name: BANNER_ACTION })).toBeNull();
    // 二态圆点：已配置 = 绿点态 + 模型 ID。
    expect(screen.getByTestId('chat-model-status-dot').getAttribute('data-state')).toBe('configured');

    await act(async () => { fireEvent.click(screen.getByTestId('home-suggestion')); });
    await waitFor(() => expect(editorText()).toBe('把照片整理成时间线'));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('test_loading_window_disables_send_and_never_pops_no_source_dialog', async () => {
    // Review Focus #5（冷启动竞态门禁半边）：hydrated === false 时发送按钮置灰、直接 /
    // 间接派发都静默等待——绝不弹「当前模型没有可用来源」、不静默发出、不误开补配弹窗。
    const pending = deferredGatewayLoad();
    h.listGatewayProviders = () => pending.promise;
    h.connectedSourceLoading = true;
    h.localProviders = [];
    const { onSend } = renderHomeGate();
    await waitFor(() => expect(h.editor).not.toBeNull());
    await setEditorText('加载窗口里先写好');

    const send = sendButton();
    expect(send.disabled).toBe(true);
    await act(async () => { fireEvent.click(send); });
    await act(async () => { fireEvent.keyDown(h.editor!.view.dom, { key: 'Enter', code: 'Enter' }); });

    expect(h.confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(editorText()).toBe('加载窗口里先写好');

    // 水合落定 → 门禁进 S4b（零条目）：发送转为「打开补配弹窗」而不是继续静默。
    h.connectedSourceLoading = false;
    await act(async () => { pending.resolve({ providers: [] }); });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => { fireEvent.click(sendButton()); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('test_save_success_collapses_banner_turns_dot_green_and_keeps_input_sendable', async () => {
    // T5/T8（AC-13）：弹窗保存成功 → 横幅折叠消失、圆点变绿 + 模型 ID、输入保留且
    // 可立即发送。保存走真实探测 + 落库链（fake timers 钉 450ms 成功保持，不真实等待）。
    h.gatewayProviders = [];
    // 供应商目录（useProviders）含网关条目镜像（生产里两个 hook 读同一份 listProviders）：
    // 保存成功后的发送要过「有已连接来源」判定，S4b 判据只看网关 store 的 entries。
    h.localProviders = [gatewayEntryProvider('gw-model-alpha', 'gw-entry')];
    vi.useFakeTimers();
    try {
      let releaseProbe!: (result: { ok: boolean; latencyMs?: number }) => void;
      h.testProviderConnection = vi.fn(
        () => new Promise((resolve) => { releaseProbe = resolve; }),
      ) as unknown as typeof h.testProviderConnection;
      const { onSend } = renderHomeGate();
      await act(async () => {});

      await setEditorText('保存后发我');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: BANNER_ACTION })); });
      expect(screen.getByRole('dialog')).toBeTruthy();

      fireEvent.change(screen.getByLabelText('settings.providers.modelDialog.endpoint'), {
        target: { value: 'https://gw.example/anthropic' },
      });
      fireEvent.change(screen.getByLabelText('settings.providers.modelDialog.key'), {
        target: { value: 'sk-ok' },
      });
      fireEvent.change(screen.getByLabelText('settings.providers.modelDialog.model'), {
        target: { value: 'gw-model-alpha' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
      });
      await act(async () => { releaseProbe({ ok: true, latencyMs: 5 }); });
      await act(async () => {});
      // ✓「已保存」450ms 保持后弹窗收尾（onSaved → onClose 双回调合同：都视为弹窗结束）。
      await act(async () => { vi.advanceTimersByTime(500); });
      // 两态翻转驱动横幅折叠；折叠窗口（token 在 jsdom 无值 = 0）走完卸载内容。
      await act(async () => { vi.advanceTimersByTime(500); });
      await act(async () => {});
      vi.useRealTimers();

      // T8：横幅折叠（a11y 树里消失）+ 圆点绿 + 模型 ID。
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByText(BANNER_TEXT)).toBeNull();
      expect(screen.queryByRole('button', { name: BANNER_ACTION })).toBeNull();
      await waitFor(() => expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe('gw-model-alpha'));
      expect(screen.getByTestId('chat-model-status-dot').getAttribute('data-state')).toBe('configured');
      // 输入保留且可立即发送。
      expect(editorText()).toBe('保存后发我');
      await act(async () => { fireEvent.click(sendButton()); });
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      expect(onSend.mock.calls[0][0]).toBe('保存后发我');
    } finally {
      vi.useRealTimers();
    }
  });

  it('test_open_dialog_inerts_home_surface_and_swallows_repeat_triggers', async () => {
    // Review Focus #6（PRD §8.3 / §9.6）：弹窗打开期间首页 inert + aria-hidden；重复
    // 触发门禁入口不二次开弹窗、不发送。
    h.gatewayProviders = [];
    const { onSend } = renderHomeGate();
    await act(async () => {});
    await setEditorText('别丢');

    const surface = screen.getByTestId('home-onboarding-surface');
    expect(surface.hasAttribute('inert')).toBe(false);
    expect(surface.getAttribute('aria-hidden')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: BANNER_ACTION })); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(surface.hasAttribute('inert')).toBe(true);
    expect(surface.getAttribute('aria-hidden')).toBe('true');

    // 重复触发被吞：仍是一个弹窗、不发送、输入保留。（inert 面带 aria-hidden，
    // 隐藏元素要 hidden:true 才能取到——这本身就是「首页已从可访问树摘除」的证据。）
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SEND_LABEL, hidden: true }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: SELECTOR_LABEL, hidden: true }));
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(editorText()).toBe('别丢');

    // 关闭后首页恢复可交互（inert 撤除）。
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'settings.providers.custom.save' }), { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(surface.hasAttribute('inert')).toBe(false);
    expect(surface.getAttribute('aria-hidden')).toBeNull();
  });
});
