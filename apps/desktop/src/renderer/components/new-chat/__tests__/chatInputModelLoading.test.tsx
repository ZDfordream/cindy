// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState, type ComponentProps, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { ProviderView } from '@cindy/model-providers';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { sshNativeCodexProvider, sshModel } from '@/features/cc-agent/__tests__/sshModelFixtures';
import { ChatInput } from '../ChatInput';
import * as providerMemory from '@/state/providerModelMemory';
import * as draftMemory from '@/state/newMakerDraft';
import { getEffortChangeCoordinator } from '../effortChangeQueue';
import { clearDraft } from '@/lib/composerDraftStore';
import { peekComposerSubmitRequest, requestComposerSubmit, takeComposerSubmitRequest } from '@/lib/composerActionsBus';
import { makerChatStore } from '@/lib/makerChatStore';
import {
  __testing as promptRecommendations,
  beginPromptRecommendationPrediction,
  clearPromptRecommendationSession,
  resolvePromptRecommendationPrediction,
} from '@/lib/promptRecommendationStore';

const h = vi.hoisted(() => ({ t: (key: string) => key, confirm: vi.fn(), editor: null as Editor | null, listening: false, stop: vi.fn().mockResolvedValue(undefined),
  setModel: vi.fn(), selectModel: undefined as undefined | ((id: string) => Promise<void | boolean>), selectEffort: undefined as string | null | undefined, remoteProviders: [] as ProviderView[],
  localProviders: [] as ProviderView[],
  // ModelGatewayProvider（ChatInput 外层）经 maker:listProviders 读网关条目目录。
  gatewayProviders: [] as ProviderView[],
  remoteStatus: 'ready' as 'ready' | 'loading' | 'error',
  platform: 'darwin',
  processing: null as 'submitting' | 'refining' | null,
}));
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: h.t }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: h.confirm }) }));
vi.mock('@/components/sidebar/SortableList', () => ({
  SortableList: ({
    items,
    renderItem,
    role,
    ariaLabel,
    className,
  }: {
    items: readonly unknown[];
    renderItem: (item: unknown, index: number) => ReactNode;
    role?: string;
    ariaLabel?: string;
    className?: string;
  }) => (
    <div role={role} aria-label={ariaLabel} className={className}>
      {items.map((item, index) => (
        <div key={index}>{renderItem(item, index)}</div>
      ))}
    </div>
  ),
}));
vi.mock('../ModelSelector', async (original) => ({ ...await original<typeof import('../ModelSelector')>(), ModelSelector: ({ modelId, onModelChange, disabled, effort }: { modelId: string; onModelChange: typeof h.selectModel; disabled?: boolean; effort?: string | null }) => {
  h.selectModel = onModelChange;
  h.selectEffort = effort;
  return <button data-testid="model-selector" disabled={disabled}>{modelId}</button>;
} }));
vi.mock('@/hooks/useSshCodexProviders', () => ({ useSshCodexProviders: () => ({ providers: h.remoteProviders, status: h.remoteStatus, refresh: () => {} }) }));
vi.mock('../ExtraDirsButton', () => ({ ExtraDirsButton: () => null }));
vi.mock('../PermissionSelector', () => ({ PermissionSelector: () => <span data-testid="permission-selector" /> }));
vi.mock('../NewGoalDialog', () => ({ NewGoalDialog: () => null }));
vi.mock('../FolderPickerPopover', () => ({ FolderPickerPopover: () => null, addRecentFolder: vi.fn() }));
vi.mock('../AtMentionPanel', () => ({ AtMentionPanel: () => null }));
vi.mock('../SlashCommandPalette', () => ({ SlashCommandPalette: () => null }));
vi.mock('@/voice-input/VoiceInputPointerHintLayer', () => ({ VoiceInputPointerHintLayer: ({ children }: { children: import('react').ReactNode }) => <>{children}</> }));
vi.mock('@/voice-input/VoiceInputStatusNotice', () => ({ VoiceInputStatusNotice: () => null }));
vi.mock('@/voice-input/useVoiceInput', () => ({ useVoiceInput: (editor: Editor | null) => {
  h.editor = editor;
  return { state: h.processing ?? (h.listening ? 'listening' : 'idle'), isListening: h.listening, isBusy: h.listening || h.processing !== null, draftText: '', start: vi.fn(), stop: h.stop, cancel: vi.fn() };
} }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: h.localProviders, loading: false }) }));
vi.mock('@/hooks/useDeviceProviders', () => ({ useDeviceProviders: () => ({ providers: [], loading: false, unsupported: false }) }));
vi.mock('@/hooks/useConnectedSource', () => ({ useConnectedSource: () => ({ hasConnectedSource: true, loading: false }) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({ agents: [], loading: false }) }));
vi.mock('@/hooks/useAgentCapabilities', async (original) => ({ ...await original<typeof import('@/hooks/useAgentCapabilities')>(), useAgentCapabilities: () => ({ capabilities: null, loading: false }) }));

vi.mock('@/state/newMakerDraft', async (original) => {
  const actual = await original<typeof import('@/state/newMakerDraft')>();
  return { ...actual, getDraft: () => {
    const draft = actual.getDraft();
    return { ...draft, lastByVendor: { ...draft.lastByVendor, codex: { ...draft.lastByVendor.codex, model: 'claude-fable-5-1' } } };
  } };
});

const noOp = () => {};
// External host services are inert; the editor, composer state, and send dispatch run unchanged.
const api: typeof window.electronAPI = new Proxy({} as typeof window.electronAPI, { get: (_obj, key) => {
  if (key === 'setModel') return h.setModel;
  if (key === 'listSync') return () => ({ ghosts: [] });
  if (key === 'listProviders') return () => Promise.resolve({ providers: h.gatewayProviders });
  if (key === 'getDataSnapshot') return () => { throw new Error('test bridge unavailable'); };
  if (key === 'setGlobalShortcut') return () => Promise.resolve({ ok: true });
  if (key === 'platform') return h.platform;
  if (key === 'then') return undefined;
  if (String(key).startsWith('on')) return () => noOp;
  return new Proxy(() => Promise.resolve(undefined), { get: (_fn, nested) => Reflect.get(api, nested) });
} });
const attachments: ComponentProps<typeof ChatInput>['attachmentState'] = {
  attachments: [], hasAttachments: false, addFiles: vi.fn(), addClipboardImage: vi.fn(),
  rejections: [], dismissRejection: noOp, clearRejections: noOp, addFolderPath: noOp,
  pendingFoldersVersion: 0, consumePendingFolders: () => [], addFileMention: noOp,
  pendingFileMentionsVersion: 0, consumePendingFileMentions: () => [],
  removeFile: noOp, updateFile: noOp, discardFiles: noOp, clearFiles: noOp, restoreFiles: (files) => [...files],
};
beforeEach(() => { h.platform = 'darwin'; h.listening = false; h.processing = null; h.stop.mockClear(); h.selectEffort = undefined; window.electronAPI = api; window.localStorage.removeItem('hrbuddy.currentModel'); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); clearDraft('queue-shortcut'); clearPromptRecommendationSession('queue-shortcut'); h.remoteProviders = []; h.localProviders = []; h.gatewayProviders = []; h.remoteStatus = 'ready'; h.setModel.mockReset(); h.confirm.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const props = {
  sessionId: 'loading-test', initialWorkingDir: '/workspace', runtimeAgentKind: 'codex' as const,
  vendorKey: 'codex' as const, deviceLinkDeviceId: 'test-host', attachmentState: attachments,
  hideRuntimeControls: true, showFolderPicker: false, disableAutofocus: true,
};

it.each(['removed-source', 'removed-model'])('sends the first message through host baseline recovery (%s)', async (reason) => {
  h.localProviders = reason === 'removed-model'
    ? [sshNativeCodexProvider([sshModel('different-model')])] : [];
  const onSend = vi.fn().mockResolvedValue(true);
  const route = { agentKind: 'codex' as const, model: 'retired-model', providerId: 'removed', effort: null, fastMode: false };
  render(<ChatInput {...props} sessionId={'recovery-' + reason} deviceLinkDeviceId={null}
    initialModel={route.model} initialProviderId={route.providerId} runtimeEffective={route}
    allowBaselineRecovery onSend={onSend} />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Retry companion</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' });
  expect((send as HTMLButtonElement).disabled).toBe(false);
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][0]).toBe('Retry companion');
  expect(onSend.mock.calls[0][6]).toMatchObject({ baselineRecovery: true, providerId: route.providerId });
  expect(h.confirm).not.toHaveBeenCalled();
});

it.each([false, undefined])('keeps disconnected ordinary sessions blocked without a host recovery offer (%s)', async (allowBaselineRecovery) => {
  const onSend = vi.fn();
  const route = { agentKind: 'codex' as const, model: 'retired-model', providerId: 'removed', effort: null, fastMode: false };
  render(<ChatInput {...props} deviceLinkDeviceId={null} initialModel={route.model}
    initialProviderId={route.providerId} runtimeEffective={route}
    allowBaselineRecovery={allowBaselineRecovery} onSend={onSend} />);
  await act(async () => { h.editor!.commands.setContent('<p>Must stay blocked</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' });
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(send);
  expect(onSend).not.toHaveBeenCalled();
});

it('does not use baseline recovery to bypass a pending selection source check', async () => {
  const onSend = vi.fn();
  const route = { agentKind: 'codex' as const, model: 'retired-model', providerId: 'removed', effort: null, fastMode: false };
  render(<ChatInput {...props} deviceLinkDeviceId={null} initialModel={route.model}
    initialProviderId={route.providerId} runtimeEffective={route} allowBaselineRecovery
    runtimePending={{ generation: 1, source: 'agent', profile: { ...route, providerId: 'new-disconnected-choice' } }}
    onSend={onSend} />);
  await act(async () => { h.editor!.commands.setContent('<p>Do not bypass the new choice</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  expect(onSend).not.toHaveBeenCalled();
});

it.each([null, 'test-host'])('preserves no-effort after creation when sending the second message (%s)', async (deviceLinkDeviceId) => {
  h.localProviders = [sshNativeCodexProvider([sshModel('qwen3:14b', { efforts: [], defaultEffort: null })])];
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId={undefined} deviceLinkDeviceId={null}
    initialModel="qwen3:14b" initialEffort={null} onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>First message</p>'); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][2]).toBe('');

  view.rerender(<ChatInput {...props} sessionId={`no-effort-created-${deviceLinkDeviceId}`} deviceLinkDeviceId={deviceLinkDeviceId}
    initialModel="qwen3:14b" initialEffort={onSend.mock.calls[0][2]} onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Second message</p>'); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
  expect(onSend.mock.calls[1][0]).toBe('Second message');
  expect(onSend.mock.calls[1][2]).toBe('');
});

it.each([null, ''])('adopts an explicit no-effort session snapshot without reusing a stale committed tier (%j)', async (initialEffort) => {
  h.localProviders = [sshNativeCodexProvider([sshModel('qwen3:14b', { efforts: [], defaultEffort: null })])];
  const sessionId = `no-effort-existing-${initialEffort === null ? 'null' : 'empty'}`;
  getEffortChangeCoordinator().setCommittedEffort(sessionId, 'high');
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId={sessionId} deviceLinkDeviceId={null}
    initialModel="qwen3:14b" initialEffort={initialEffort} onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue without effort</p>'); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' })); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][2]).toBe('');
});

// 2026-10-31 Task 6（设计稿 §5.3）换入口：原意图「guest 模型可见但不可改选」拆两半——
// 「菜单入口对 guest 可见 + 消息输入不锁」仍成立，本例钉住；「不可改选」在新 UI 下
// 暂无禁用态承载（deferred：ChatModelMenu 无 disabled 态，且触发器显示的是全局当前
// 模型而非会话 guest 模型 initialModel），现状是 guest 也能点开选型、只落全局当前
// 模型（localStorage），不走 legacy 会话模型 IPC。恢复 ModelSelector 入口后本例按旧
// 合同回钉 disabled。
it('keeps the model menu visible and the shared-guest message input unlocked (selection lock deferred)', async () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  h.gatewayProviders = [gatewayEntryProvider('gpt-6-sol', 'gw-entry-sol'), gatewayEntryProvider('other-model', 'gw-entry-other')];
  const inputProps = { ...props, hideRuntimeControls: false, initialModel: 'gpt-6-sol', onSend };
  const view = render(<ChatInput {...inputProps} deviceLinkDeviceId={sharedTaskHostPeer('shared', 'host')} />);
  const menuRoot = () => screen.getByTestId('chat-model-menu-root');
  const trigger = () => menuRoot().querySelector('button') as HTMLButtonElement;
  // 模型入口对 guest 可见（触发器文案 = 全局当前模型，非会话模型）。
  await waitFor(() =>
    expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe('gpt-6-sol'),
  );
  // deferred：无禁用态承载 —— 现状 trigger 不带 disabled（见用例头注）。
  expect(trigger().disabled).toBe(false);
  // 消息输入不锁（原意图后半，新旧一致）。
  expect(h.editor?.isEditable).toBe(true);
  // 点开选型：落在全局当前模型（触发器换名），不碰 legacy 会话模型 IPC / 记忆表。
  await act(async () => { fireEvent.click(trigger()); });
  const nextModel = await screen.findByRole('option', { name: /other-model/ });
  await act(async () => {
    nextModel.focus();
    fireEvent.click(nextModel);
  });
  await waitFor(() => expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe('other-model'));
  expect(h.setModel).not.toHaveBeenCalled();

  // 切回自己的 host：入口与输入保持同一可见 / 可编辑口径（旧「解锁 disabled」无对应承载）。
  await act(async () => { view.rerender(<ChatInput {...inputProps} deviceLinkDeviceId="host" />); });
  expect(screen.getByTestId('chat-model-menu-root')).toBeTruthy();
  expect(h.editor?.isEditable).toBe(true);
});

const queuedMessage = {
  clientId: 'queue-edit-test',
  text: 'Queued message',
  persistedContent: 'Queued message',
  model: 'gpt-6-astra',
  effort: 'medium',
  permissionMode: 'default',
  workingDir: '/workspace',
  chatMessage: { clientId: 'queue-edit-test', role: 'user' as const, content: 'Queued message' },
  createOpts: {
    agentKind: 'codex' as const,
    model: 'gpt-6-astra',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/workspace',
  },
} as NonNullable<ComponentProps<typeof ChatInput>['pendingQueue']>[number];

// PR #6422: helper-only coverage cannot detect a disconnected window capture
// handler or a visible recommendation being bypassed. Exercise the real editor
// keydown and its outgoing queue/send callbacks. Minimal unit inputs: one/two
// queued rows, a typed draft, or an empty document with a ready recommendation.
// Reuse this jsdom harness; no additional module loads or real timer waits.
// Single-file run: 10.10s (7.68s existing ChatInput import collection, 1.57s tests).
const queueShortcutProps = {
  ...props,
  sessionId: 'queue-shortcut', draftKey: 'queue-shortcut', deviceLinkDeviceId: null,
  initialModel: 'gpt-6-astra', initialProviderId: 'openai', initialEffort: 'medium',
  pendingQueue: [queuedMessage],
};
const queueShortcuts = [
  { platform: 'darwin', metaKey: true, ctrlKey: false },
  { platform: 'win32', metaKey: false, ctrlKey: true },
];

it.each(queueShortcuts)('steers the sole queued message from the empty focused composer on $platform', async shortcut => {
  h.platform = shortcut.platform;
  h.localProviders = [sshNativeCodexProvider([sshModel('gpt-6-astra')])];
  const onQueueSteer = vi.fn().mockResolvedValue(true);
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ChatInput {...queueShortcutProps} onQueueSteer={onQueueSteer} onSend={onSend} />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  const editor = h.editor!.view.dom;
  editor.focus();
  expect(document.activeElement).toBe(editor);
  expect(h.editor!.getText()).toBe('');

  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', ...shortcut }); });

  expect(onQueueSteer).toHaveBeenCalledExactlyOnceWith(queuedMessage.clientId);
  expect(onSend).not.toHaveBeenCalled();
});

it.each(['two queued messages', 'typed draft'] as const)('preserves composer dispatch with %s', async scenario => {
  h.localProviders = [sshNativeCodexProvider([sshModel('gpt-6-astra')])];
  const onQueueSteer = vi.fn().mockResolvedValue(true);
  const onSend = vi.fn().mockResolvedValue(true);
  const pendingQueue = scenario === 'typed draft' ? [queuedMessage] : [queuedMessage, { ...queuedMessage, clientId: 'queue-2' }];
  render(<ChatInput {...queueShortcutProps} pendingQueue={pendingQueue} onQueueSteer={onQueueSteer} onSend={onSend} />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  if (scenario === 'typed draft') {
    await act(async () => { h.editor!.commands.setContent('<p>Send this draft</p>'); });
  }
  const editor = h.editor!.view.dom;
  editor.focus();
  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', metaKey: true }); });

  expect(onQueueSteer).not.toHaveBeenCalled();
  if (scenario === 'typed draft') {
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('Send this draft');
  } else {
    expect(onSend).not.toHaveBeenCalled();
  }
});

it.each(queueShortcuts)('sends the visible recommendation ahead of a queued message on $platform', async shortcut => {
  h.platform = shortcut.platform;
  h.localProviders = [sshNativeCodexProvider([sshModel('gpt-6-astra')])];
  const onQueueSteer = vi.fn().mockResolvedValue(true);
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ChatInput {...queueShortcutProps} onQueueSteer={onQueueSteer} onSend={onSend} />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  vi.spyOn(makerChatStore, 'getPromptRecommendationCompletionStatus').mockReturnValue({
    turnStoppedByUser: false, hasTerminalError: false, sideTask: false,
    hasBackgroundAgentWork: false, hasAutoDrainingQueue: false,
  });
  await act(async () => {
    promptRecommendations.applyRunningSnapshot(new Map([['queue-shortcut', { isRunning: true }]]));
    promptRecommendations.noteTurnEnded('queue-shortcut', 200);
    promptRecommendations.applyRunningSnapshot(new Map());
    promptRecommendations.settleCompletion('queue-shortcut');
    const seq = beginPromptRecommendationPrediction('queue-shortcut', 200)!;
    resolvePromptRecommendationPrediction('queue-shortcut', 200, seq, 'Continue with the recommendation');
  });
  expect(screen.getByText('Continue with the recommendation')).toBeTruthy();
  expect(h.editor!.getText()).toBe('');
  const editor = h.editor!.view.dom;
  editor.focus();
  await act(async () => { fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter', ...shortcut }); });

  expect(onQueueSteer).not.toHaveBeenCalled();
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(onSend.mock.calls[0][0]).toBe('Continue with the recommendation');
  expect(promptRecommendations.getSessionSnapshot('queue-shortcut')).toBeUndefined();
});

function QueueEditHarness({
  onCancel,
  onRemove,
  onSubmit = async () => true,
  onStartVoiceConversation,
}: {
  onCancel: () => void;
  onRemove: () => void;
  onSubmit?: NonNullable<ComponentProps<typeof ChatInput>['onQueueEditSubmit']>;
  onStartVoiceConversation?: () => void;
}) {
  const [editingClientId, setEditingClientId] = useState<string | null>(queuedMessage.clientId);

  return (
    <ChatInput
      {...props}
      onSend={() => undefined}
      onStartVoiceConversation={onStartVoiceConversation}
      pendingQueue={[queuedMessage]}
      queueExpanded={false}
      onQueueExpandedChange={vi.fn()}
      onQueueRemove={onRemove}
      queueEditingClientId={editingClientId}
      onQueueEditBegin={vi.fn()}
      onQueueEditSubmit={onSubmit}
      onQueueEditCancel={() => {
        onCancel();
        setEditingClientId(null);
      }}
    />
  );
}

// 2026-10-31 Task 6（设计稿 §5.3）换入口：原意图「SSH 无窗口任务的选型报到 main、失败
// 回滚并重试」在新 UI 下无承载——ChatModelMenu 选型 = 全局当前模型 →
// localStorage(hrbuddy.currentModel)，不经 maker.setModel；原 setModel 报告/回滚/重试
// 链（handleModelChange）随 ModelSelector 入口 dormant（836d22d541，owner「藏起来以后
// 再说」保留为恢复路径）。本例钉现状仍成立的可观察行为：新 SSH 任务（无窗口）里真实
// 菜单选型落到全局当前模型与持久键，且不碰 legacy 报告链与记忆表（原 not-called 边界）。
it('lets a new SSH task with no window select a model through the menu without the legacy setModel report chain', async () => {
  const remember = vi.spyOn(providerMemory, 'setProviderModelChoice');
  const draft = vi.spyOn(draftMemory, 'patchVendorPrefs');
  const effortPrefs = vi.spyOn(draftMemory, 'setEffortForModel');
  h.remoteProviders = [sshNativeCodexProvider([sshModel('old'), sshModel('remote-new')])];
  h.gatewayProviders = [gatewayEntryProvider('gw-model-alpha', 'gw-entry-alpha'), gatewayEntryProvider('gw-model-beta', 'gw-entry-beta')];
  render(<ChatInput {...props} sessionId="ssh-empty" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="old" initialProviderId="openai" initialEffort="low" hideRuntimeControls={false} onSend={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe('gw-model-alpha'),
  );
  await act(async () => {
    fireEvent.click(screen.getByTestId('chat-model-menu-root').querySelector('button')!);
  });
  const nextModel = await screen.findByRole('option', { name: /gw-model-beta/ });
  await act(async () => {
    nextModel.focus();
    fireEvent.click(nextModel);
  });
  // 选型落全局当前模型（触发器换名）并写持久键 —— 新契约的持久化落点。
  await waitFor(() =>
    expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe('gw-model-beta'),
  );
  expect(window.localStorage.getItem('hrbuddy.currentModel')).toBeTruthy();
  // legacy 会话模型报告链与记忆表全部不碰（原意图的 not-called 边界，防误接回 dormant 链）。
  expect(h.setModel).not.toHaveBeenCalled();
  expect(remember).not.toHaveBeenCalled();
  expect(draft).not.toHaveBeenCalled();
  expect(effortPrefs).not.toHaveBeenCalled();
});

it('sends a remote-only Codex model when the controller has no connected providers', async () => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId="ssh-send" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-only" initialProviderId="openai" initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Hello remote</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][1]).toBe('remote-only');
  expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId: 'openai' }));
});

// 测试价值
// - 生产入口与可观察结果：真实 ChatInput 发送（editor + Send → onSend 的 model /
//   opts.providerId）。全局当前模型（网关条目，经 ModelGatewayStore 真实 hydrate +
//   currentModelStore 自动选中首条 enabled）在 claude-code 发送时套用（Ruling 18 保持），
//   在 codex 发送时不得替换（Ruling 20）。
// - Bug／规则依据：最终全分支 review F3 + Ruling 20——sendRoute 曾不看 agent kind，
//   任一启用网关条目会把本机 codex/pi 会话的后续消息钉到网关 modelId + 自定义
//   provider（该 provider 只有 claude-code runtime）。
// - 现有覆盖缺口：chatInputModelSelectorRouting 是 guard 级源码合同锁（Ruling 18 的
//   钉子），没有可观察的发送行为用例；本文件族已有 onSend model/provider 断言先例。
// - 最小失败输入：gatewayProviders 一条启用网关条目 + 本地一条 codex 来源，codex
//   会话发送即被劫持（旧码 RED）；同夹具 claude-code 会话必须仍走网关路由。
// - tier：unit（jsdom，真实 store + 组件，无网络 / 真实计时）。
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
        {
          id: modelId,
          name: modelId,
          catalogPresetId: 'hrbuddy-gateway',
          contextWindow: 200_000,
          efforts: [],
          defaultEffort: null,
        },
      ],
    },
  };
}

// 等全局当前模型生效（store hydrate + currentModelStore 回落选中）：模型菜单胶囊
// 与 sendRoute 读同一份 (currentId, entries)，标签变成网关 modelId 即路由已就绪。
async function waitForGatewayCurrentModel() {
  await waitFor(() =>
    expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe('gw-model-alpha'),
  );
}

it('routes a claude-code send through the gateway global current model (Ruling 18)', async () => {
  h.gatewayProviders = [gatewayEntryProvider()];
  h.localProviders = [gatewayEntryProvider()];
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ChatInput {...props} sessionId="cc-gw-send" vendorKey="cc" runtimeAgentKind="claude-code"
    deviceLinkDeviceId={null} hideRuntimeControls={false}
    initialModel="cc-native-model" initialProviderId="xd" onSend={onSend} />);
  await waitForGatewayCurrentModel();
  await act(async () => { h.editor!.commands.setContent('<p>Hello from claude-code</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][1]).toBe('gw-model-alpha');
  expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId: 'gw-entry' }));
});

it('keeps a codex send on its own route despite a gateway current model (Ruling 20)', async () => {
  h.gatewayProviders = [gatewayEntryProvider()];
  h.localProviders = [gatewayEntryProvider(), sshNativeCodexProvider([sshModel('gpt-6-astra')])];
  const onSend = vi.fn().mockResolvedValue(true);
  render(<ChatInput {...props} sessionId="codex-gw-send" deviceLinkDeviceId={null} hideRuntimeControls={false}
    initialModel="gpt-6-astra" initialProviderId="openai" initialEffort="low" onSend={onSend} />);
  // 先确认全局当前模型已生效（旧码正是在这之后被劫持），再发送。
  await waitForGatewayCurrentModel();
  await act(async () => { h.editor!.commands.setContent('<p>Hello from codex</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  // Ruling 20：非 claude-code 引擎路由保持原状，不被网关 modelId / provider 顶掉。
  expect(onSend.mock.calls[0][1]).toBe('gpt-6-astra');
  expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId: 'openai' }));
});

// 回归：投影 effort 为 null（目录误判/不可调档）时回落会话已持久化档位，
// 不能兜底成字面量 'low'。（原 it.each 第二行「投影有值时优先投影值」见下。）
// 2026-10-31 Task 6（设计稿 §5.3）换入口：原载体是 ModelSelector 的 effort 档位
// 显示（h.selectEffort 捕获 prop，#5780「渲染档位」回归）；ChatModelMenu 不带
// effort 档 UI，「显示档位」意图暂无承载（deferred）。本例改钉发送路径的可观察
// 结果：投影为 null 时本 turn 的 effort（onSend 第 3 参）仍是会话已持久化档，
// 不落字面量 'low'。
// 裁剪（不属偷懒）：原第二行「投影有值时优先投影值」是显示层规则，新 UI 无档位
// 显示载体；发送层又自有一套（#692：turn 用已提交档，投影差异不改本 turn），
// 无法无损承托该意图，故不改写钉发送（钉了会把相反语义冻成合同）。见 fix-14 报告。
it('sends with the persisted session effort instead of a literal low when the projection is null', async () => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-only')])];
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} hideRuntimeControls={false} sessionId="ssh-effort-fallback" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-only" initialProviderId="openai" initialEffort="high"
    runtimeEffective={{ agentKind: 'codex', model: 'remote-only', providerId: 'openai', effort: null, fastMode: false }}
    onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][2]).toBe('high');
});

it.each([
  ['button', 'openai'], ['Enter', 'openai'], ['button', null], ['Enter', null],
] as const)('sends a hidden existing SSH model through %s with provider %s', async (entry, providerId) => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-new')])];
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} sessionId="ssh-hidden" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-old" initialProviderId={providerId} initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue old task</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  await act(async () => {
    if (entry === 'button') fireEvent.click(send);
    else fireEvent.keyDown(view.container.querySelector('[contenteditable]')!, { key: 'Enter', code: 'Enter' });
  });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][1]).toBe('remote-old');
  expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId }));
  expect(h.confirm).not.toHaveBeenCalled();
});

it.each(['loading', 'error'] as const)('keeps SSH catalog %s blocked for an existing hidden model', async (status) => {
  h.remoteStatus = status;
  const onSend = vi.fn();
  const view = render(<ChatInput {...props} sessionId="ssh-hidden" deviceLinkDeviceId={null} remoteHostId="builder"
    initialModel="remote-old" initialProviderId="openai" initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue old task</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    fireEvent.keyDown(view.container.querySelector('[contenteditable]')!, { key: 'Enter', code: 'Enter' });
  });
  expect(onSend).not.toHaveBeenCalled();
});

it.each(['draft', 'other-provider'] as const)('does not exempt a hidden SSH model for %s', async (kind) => {
  h.remoteProviders = [sshNativeCodexProvider([sshModel('remote-new')])];
  const onSend = vi.fn();
  const view = render(<ChatInput {...props} sessionId={kind === 'draft' ? undefined : 'ssh-hidden'}
    deviceLinkDeviceId={null} remoteHostId="builder" initialModel="remote-old"
    initialProviderId={kind === 'draft' ? 'openai' : 'custom'} initialEffort="low" onSend={onSend} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>New route</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    fireEvent.keyDown(view.container.querySelector('[contenteditable]')!, { key: 'Enter', code: 'Enter' });
  });
  expect(onSend).not.toHaveBeenCalled();
});

it.each(['button', 'Enter', 'voice'] as const)(
  'blocks %s while metadata is absent, retains input, and sends Astra when metadata arrives', async (entry) => {
    const onSend = vi.fn().mockResolvedValue(true);
    const view = render(<ChatInput {...props} onSend={onSend} />);
    await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
    await act(async () => { h.editor!.commands.setContent('<p>Continue the task</p>'); });
    const editor = view.container.querySelector('[contenteditable]') as HTMLElement;
    const send = () => screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
    if (entry === 'voice') {
      h.listening = true;
      view.rerender(<ChatInput {...props} onSend={onSend} />);
    }
    const trigger = async () => {
      await act(async () => {
        if (entry === 'button') fireEvent.click(send());
        else fireEvent.keyDown(editor, { key: 'Enter', code: 'Enter' });
      });
    };
    expect(screen.getByTestId('permission-selector')).toBeTruthy();
    expect(screen.queryByTestId('model-selector')).toBeNull();
    expect(send().disabled).toBe(true);
    await trigger();
    expect(onSend).not.toHaveBeenCalled();
    expect(h.editor!.getText()).toBe('Continue the task');
    view.rerender(<ChatInput {...props} onSend={onSend}
      initialModel="gpt-6-astra" initialProviderId="openai" initialEffort="medium" />);
    await waitFor(() => expect(send().disabled).toBe(false));
    await trigger();
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    if (entry === 'voice') expect(h.stop).toHaveBeenCalled();
    expect(onSend.mock.calls[0][0]).toBe('Continue the task');
    expect(onSend.mock.calls[0][1]).toBe('gpt-6-astra');
    expect(onSend.mock.calls[0][2]).toBe('medium');
    expect(onSend.mock.calls[0][6]).toEqual(expect.objectContaining({ providerId: 'openai' }));
  },
);

// PR #7300: manual-send coverage missed automatic actions consuming a request
// while metadata/Send is disabled. Unit through real ChatInput: one screenshot,
// one blocked request, then enable Send; retain it and dispatch exactly once.
it.each(['metadata', 'disabled'] as const)('retains screenshot submission until %s is ready', async gate => {
  const key = `screenshot-wait-${gate}`;
  const onSend = vi.fn().mockResolvedValue(true);
  const inputProps = { ...props, sessionId: key, draftKey: key, onSend,
    attachmentState: { ...attachments, hasAttachments: true, attachments: [{
      id: 'shot', name: 'shot.png', path: 'clipboard://shot', ext: '.png',
      size: 16, category: 'image' as const, url: 'image:shot', mimeType: 'image/png',
    }] },
  };
  const loaded = { initialModel: 'gpt-6-astra', initialProviderId: 'openai', initialEffort: 'medium' as const };
  const view = render(<ChatInput {...inputProps} {...(gate === 'disabled' ? loaded : {})} disabled={gate === 'disabled'} />);
  await waitFor(() => expect(h.editor).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Explain screenshot</p>'); });
  vi.useFakeTimers();
  try {
    await act(async () => {
      requestComposerSubmit({ storageKey: key, attachmentUrl: 'image:shot' });
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(peekComposerSubmitRequest(key)).not.toBeNull();
    view.rerender(<ChatInput {...inputProps} {...loaded} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0]).toBe('Explain screenshot');
    expect(peekComposerSubmitRequest(key)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(onSend).toHaveBeenCalledTimes(1);
  } finally {
    view.unmount();
    takeComposerSubmitRequest(key);
    clearDraft(key);
    vi.useRealTimers();
  }
});

// 2026-10-31 Task 6（设计稿 §5.3）换入口：原「模型名显示在选择器上」（缺模型隐藏 /
// runtime 恢复显示 / 新草稿默认显示）随 ModelSelector 显示入口下线——ChatModelMenu
// 的触发器显示的是全局当前模型目录，不承载会话模型名。本例把三条意图钉在仍然成立的
// 可观察面上：缺失模型不显示幻影模型名（占位）、不放行发送；runtime 恢复后发送路径
// 拿到恢复出的模型（onSend 第 2 参）；新草稿默认模型同样落在发送参数。
it('hides a missing existing model, recovers from the effective runtime, and preserves new-draft defaults', async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  const view = render(<ChatInput {...props} hideRuntimeControls={false} onSend={onSend} />);
  // 缺失既有模型：菜单只给占位（不显示不存在的模型名），发送不放行。
  await waitFor(() =>
    expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe(
      'newChat.chatModelMenu.placeholder',
    ),
  );
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  // 从 effective runtime 恢复：模型值落点 = 发送参数（原选择器显示恢复的替代承载）。
  view.rerender(<ChatInput {...props} hideRuntimeControls={false} onSend={onSend}
    runtimeEffective={{ agentKind: 'codex', model: 'gpt-6-astra', providerId: 'openai', effort: 'medium', fastMode: false }} />);
  await waitFor(() => expect(view.container.querySelector('[contenteditable]')).not.toBeNull());
  await act(async () => { h.editor!.commands.setContent('<p>Continue</p>'); });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(false),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.send' }));
  });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][1]).toBe('gpt-6-astra');
  // 恢复来源撤回：模型再次缺失，发送回到不放行态。
  view.rerender(<ChatInput {...props} hideRuntimeControls={false} onSend={onSend} />);
  await act(async () => { h.editor!.commands.setContent('<p>Continue again</p>'); });
  expect((screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement).disabled).toBe(true);
  // 新草稿默认：草稿层记忆的默认模型（claude-fable-5-1）进发送参数。
  // 本机新草稿（deviceLinkDeviceId 清空）+ 该模型的已连接来源（noConnectedSource 门）。
  h.localProviders = [sshNativeCodexProvider([sshModel('claude-fable-5-1')])];
  view.rerender(<ChatInput {...props} sessionId={undefined} deviceLinkDeviceId={null} hideRuntimeControls={false} onSend={onSend} />);
  // 先落效果（新 draftKey 的草稿恢复会清空编辑器），再写正文，保证 canSend 走内容判据。
  await act(async () => {});
  await act(async () => { h.editor!.commands.setContent('<p>New draft</p>'); });
  expect(h.editor!.getText()).toBe('New draft');
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  await waitFor(() => expect(send.disabled).toBe(false));
  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
  expect(onSend.mock.calls[1][1]).toBe('claude-fable-5-1');
});

it('hides queue removal while editing and exits editing from the composer cancel button', async () => {
  const onCancel = vi.fn();
  const onRemove = vi.fn();
  render(<QueueEditHarness onCancel={onCancel} onRemove={onRemove} />);

  const cancel = await screen.findByRole('button', {
    name: 'newChat.pendingQueue.editCancelAria',
  });
  expect(screen.getByRole('listitem')).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'newChat.pendingQueue.removeAria' }),
  ).toBeNull();

  fireEvent.click(cancel);

  await waitFor(() => {
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: 'newChat.pendingQueue.editCancelAria' }),
    ).toBeNull();
  });
  fireEvent.mouseEnter(screen.getByRole('listitem'));
  expect(screen.getByRole('button', { name: 'newChat.pendingQueue.removeAria' })).toBeTruthy();
  expect(onRemove).not.toHaveBeenCalled();
});

it('blocks queue edit saves while voice capture is active', async () => {
  h.listening = true;
  const onSubmit = vi.fn().mockResolvedValue(true);
  render(<QueueEditHarness onCancel={vi.fn()} onRemove={vi.fn()} onSubmit={onSubmit} />);

  const save = (await screen.findByRole('button', {
    name: 'newChat.pendingQueue.editSaveAria',
  })) as HTMLButtonElement;
  expect(save.disabled).toBe(true);

  fireEvent.click(save);
  expect(onSubmit).not.toHaveBeenCalled();
});

// The slot survives missing metadata across hydration; the model menu keeps its
// placeholder (no phantom model name) while the model is unknown.
// 2026-10-31 Task 6（设计稿 §5.3）换入口：原「缺元数据时槽内空、只保留占位几何」在
// ChatModelMenu 常驻后不再有「空槽」态——菜单自带 placeholder 且无禁用态，缺元数据
// 时以占位文案呈现而不是隐藏入口。槽位节点与几何（水合占位宽 / 就绪后收拢）的意图
// 原样保留；「有模型才出控制」由「菜单常驻、不显示幻影模型名」承接。
it.each([320, 480, 800])('preserves the model slot across hydration (width=%s)', async (width) => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  const narrowToolbar = width < 600;
  const onSend = vi.fn();
  const inputProps = { ...props, hideRuntimeControls: false, narrowToolbar, onSend };
  const view = render(<ChatInput {...inputProps} />);
  const slot = view.container.querySelector('[data-session-model-slot]') as HTMLElement;
  expect(slot).not.toBeNull();
  const geometry = slot.className;
  // 水合未就绪：菜单以占位呈现（不显示不存在的模型名），入口常驻在槽内。
  expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe(
    'newChat.chatModelMenu.placeholder',
  );
  expect(slot.contains(screen.getByTestId('chat-model-menu-root'))).toBe(true);
  view.rerender(<ChatInput {...inputProps} initialModel="gpt-6-astra" />);
  expect(view.container.querySelector('[data-session-model-slot]')).toBe(slot);
  if (narrowToolbar) {
    expect(slot.className).toBe(geometry);
  } else {
    // Loaded wide toolbars must not inherit the loading placeholder's width.
    expect(slot.classList.contains('w-[148px]')).toBe(false);
    expect(slot.classList.contains('h-[30px]')).toBe(true);
    expect(slot.classList.contains('min-w-0')).toBe(true);
  }
  // 菜单入口一直在槽内（常驻菜单取代旧「有模型才出控制」）。
  expect(slot.contains(screen.getByTestId('chat-model-menu-root'))).toBe(true);
  view.rerender(<ChatInput {...inputProps} />);
  expect(view.container.querySelector('[data-session-model-slot]')).toBe(slot);
  expect(slot.className).toBe(geometry);
  // 模型再次缺失：回到占位文案，不显示幻影模型名。
  expect(screen.getByTestId('chat-model-trigger-label').textContent).toBe(
    'newChat.chatModelMenu.placeholder',
  );
  view.rerender(<ChatInput {...inputProps} hideRuntimeControls />);
  expect(view.container.querySelector('[data-session-model-slot]')).toBeNull();
  expect(screen.getByTestId('permission-selector')).toBeTruthy();
  await act(async () => {});
  expect(onSend).not.toHaveBeenCalled();
});

// Real editor/send regression: companion mode replaces the idle action, not the
// dispatch pipeline. The previous three-button behavior did not exercise these transitions.
function companionProps() {
  h.localProviders = [sshNativeCodexProvider([sshModel('fixture-chat')])];
  return { ...props, deviceLinkDeviceId: null, initialModel: 'fixture-chat', initialProviderId: 'openai' };
}

it('switches one companion action between call and send, retaining focus and dispatching the draft once', async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  const onStartVoiceConversation = vi.fn();
  const inputProps = { ...companionProps(), onSend, onStartVoiceConversation };
  const view = render(<ChatInput {...inputProps} />);
  await act(async () => { h.editor?.commands.clearContent(); });
  const call = screen.getByRole('button', { name: 'bots.voiceMode.startConversation' }) as HTMLButtonElement;
  const dictation = screen.getByRole('button', { name: 'newChat.chatInput.voiceInput.start' });
  expect(dictation.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'newChat.sendButton.send' })).toBeNull();
  expect(call.disabled).toBe(false);
  fireEvent.click(call);
  expect(onStartVoiceConversation).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => { h.editor?.commands.setContent('<p>   </p>'); });
  expect(screen.getByRole('button', { name: 'bots.voiceMode.startConversation' })).toBe(call);
  act(() => { call.focus(); });
  await act(async () => { h.editor?.commands.setContent('<p>Keep this draft</p>'); });
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' });
  expect(send).toBe(call);
  expect(document.activeElement).toBe(send);
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  view.rerender(<ChatInput {...inputProps} disabled />);
  expect(screen.getByRole('button', { name: 'newChat.sendButton.send' })).toBe(call);
  expect(call.disabled).toBe(true);

  view.rerender(<ChatInput {...inputProps} voiceConversationDisabled />);
  // Voice availability cannot disable a valid text send.
  expect(call.disabled).toBe(false);
  view.rerender(<ChatInput {...inputProps} voiceConversationActive />);
  // The call now leaves the composer visible. Its production mutation lock
  // must reject text sends (not just dim the controls) while retaining drafts.
  expect(h.editor?.isEditable).toBe(false);
  expect((send as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(send);
  expect(onSend).not.toHaveBeenCalled();
  expect(h.editor?.getText()).toBe('Keep this draft');
  view.rerender(<ChatInput {...inputProps} voiceConversationActive={false} />);
  expect(h.editor?.isEditable).toBe(true);
  expect(h.editor?.getText()).toBe('Keep this draft');
  expect(document.activeElement).toBe(call);

  await act(async () => { fireEvent.click(send); });
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend.mock.calls[0][0]).toBe('Keep this draft');
  expect(screen.getByRole('button', { name: 'bots.voiceMode.startConversation' })).toBe(call);
  expect(fireEvent.keyDown(call, { key: 'Enter', repeat: true })).toBe(false);
  expect(onStartVoiceConversation).toHaveBeenCalledOnce();
  view.rerender(<ChatInput {...inputProps} voiceConversationDisabled />);
  expect(call.disabled).toBe(true);

  view.rerender(<ChatInput {...props} onSend={onSend} />);
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  expect(screen.getByRole('button', { name: 'newChat.sendButton.send' })).toBeTruthy();
  await act(async () => {});
});

it.each(['pointer', 'Space'] as const)('does not activate a changed companion action after a %s press', async (input) => {
  const onStartVoiceConversation = vi.fn();
  const onSend = vi.fn();
  render(<ChatInput {...companionProps()} onSend={onSend} onStartVoiceConversation={onStartVoiceConversation} />);
  await act(async () => { h.editor?.commands.clearContent(); });
  const action = screen.getByRole('button', { name: 'bots.voiceMode.startConversation' });
  const press = () => input === 'pointer'
    ? fireEvent.pointerDown(action)
    : fireEvent.keyDown(action, { key: ' ' });
  press();
  await act(async () => { h.editor?.commands.setContent('<p>Arrived during press</p>'); });
  fireEvent.click(action);
  expect(onSend).not.toHaveBeenCalled();
  press();
  await act(async () => { h.editor?.commands.clearContent(); });
  fireEvent.click(action);
  expect(onStartVoiceConversation).not.toHaveBeenCalled();
  // A fresh activation of the currently displayed action still works.
  fireEvent.click(action);
  expect(onStartVoiceConversation).toHaveBeenCalledOnce();
});

it('keeps attachment-only sends and the running stop/queue actions available for companions', async () => {
  const onStop = vi.fn();
  const inputProps = { ...companionProps(), onSend: vi.fn(), onStop, onStartVoiceConversation: vi.fn() };
  const view = render(<ChatInput {...inputProps} />);
  await act(async () => { h.editor?.commands.clearContent(); });
  const call = screen.getByRole('button', { name: 'bots.voiceMode.startConversation' });
  const attached = { ...attachments, hasAttachments: true, attachments: [{
    id: 'voice-switch-file', name: 'notes.txt', path: '/fixture/notes.txt', ext: '.txt',
    size: 12, category: 'text' as const, mimeType: 'text/plain',
  }] };
  view.rerender(<ChatInput {...inputProps} attachmentState={attached} />);
  expect(screen.getByRole('button', { name: 'newChat.sendButton.send' })).toBe(call);
  view.rerender(<ChatInput {...inputProps} />);
  expect(screen.getByRole('button', { name: 'bots.voiceMode.startConversation' })).toBe(call);
  view.rerender(<ChatInput {...inputProps} isStreaming />);
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'newChat.sendButton.stop' }));
  expect(onStop).toHaveBeenCalledOnce();
  await act(async () => { h.editor?.commands.setContent('<p>Next message</p>'); });
  expect(screen.getByRole('button', { name: 'newChat.sendButton.queue' })).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'newChat.sendButton.stop' })).toHaveLength(1);
});

it.each(['listening', 'submitting', 'refining'] as const)('retains the send target during companion dictation %s', async (state) => {
  const inputProps = { ...companionProps(), onSend: vi.fn(), onStartVoiceConversation: vi.fn() };
  const view = render(<ChatInput {...inputProps} />);
  await act(async () => { h.editor?.commands.clearContent(); });
  h.listening = state === 'listening';
  h.processing = state === 'listening' ? null : state;
  view.rerender(<ChatInput {...inputProps} />);
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  const send = screen.getByRole('button', { name: 'newChat.sendButton.send' }) as HTMLButtonElement;
  expect(send.disabled).toBe(state !== 'listening');
});

it('keeps save/cancel when editing a queued companion message', async () => {
  const onStartVoiceConversation = vi.fn();
  const onSubmit = vi.fn().mockResolvedValue(true);
  render(<QueueEditHarness onCancel={vi.fn()} onRemove={vi.fn()}
    onSubmit={onSubmit} onStartVoiceConversation={onStartVoiceConversation} />);
  await act(async () => { h.editor?.commands.setContent('<p>Edited queued message</p>'); });
  expect(screen.queryByRole('button', { name: 'bots.voiceMode.startConversation' })).toBeNull();
  expect(screen.getByRole('button', { name: 'newChat.pendingQueue.editCancelAria' })).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'newChat.pendingQueue.editSaveAria' })); });
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(onStartVoiceConversation).not.toHaveBeenCalled();
});
