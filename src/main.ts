import { basename as nodeBasename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { scanSkillsDir, SkillEntry } from './features/skills/skill-scan';
import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  TFile,
  ToggleComponent,
  WorkspaceLeaf,
} from 'obsidian';
import type { AcpClientConnection } from './acp/connection';
import type { AcpPromptBlock, AcpRequestPermissionParams, AcpRequestPermissionResult } from './acp/types';
import { ActivityTimeoutGuard } from './acp/activity-timeout';
import { BackendSnapshot, DshAcpBackend } from './backend/backend';
import { DshRuntimeInstaller, InstallStatus } from './backend/installer';
import { PermissionModal } from './features/permissions/modal';
import { ChatViewHost, DshChatView } from './features/chat/view';
import { DshSynapseView, SynapseViewHost } from './features/synapse/view';
import { closeSynapseWorkspaceConversations, normalizeSynapsePosition, type SynapsePosition } from './features/synapse/layout';
import {
  appendMessage,
  appendAssistantAfterPrompt,
  appendCumulativeStreamText,
  cancelPendingPrompt,
  ChatMessage,
  Conversation,
  contextTransferOfMessages,
  createConversationBranch,
  createConversation,
  deriveTitle,
  dedupeCumulativeTextBlocks,
  GoalCard,
  isGoalWaitingForUserText,
  isSyntheticContextTitle,
  mergeMirroredStreamText,
  mergeUsageSnapshot,
  markSubagentRunActive,
  messagesBeforePending,
  movePendingPrompt,
  normalizeConversationTitle,
  PendingPrompt,
  NoteAttachment,
  QuoteAttachment,
  reconcileWireText,
  resolveActiveConversationId,
  repairSyntheticContextTitle,
  rewindForAssistantRegeneration,
  SelectionAttachment,
  settleSubagentRun,
  shouldAutoCompact,
  pruneChangeSetSnapshots,
  TodoItem,
  WorkflowAgent,
  WorkflowRun,
} from './features/chat/session';
import { SessionTailer, sessionLogPath } from './features/chat/session-tailer';
import { BlockBuilder } from './features/chat/block-builder';
import { acpImageMimeType, attachmentKind, buildPromptBlocks, NativeImagePayload } from './features/chat/prompt-build';
import {
  DomSelectionTracker,
  SelectionTracker,
  WebViewerSelectionTracker,
  type WebViewerElement,
  type WebViewerSelectionSnapshot,
} from './features/editor/selection-tracker';
import { ConfirmModal } from './features/permissions/confirm-modal';
import { MODEL_CATALOG, visibleModelEntries, type ModelCatalog } from './runtime/templates';
import {
  discoverRuntimeModelCatalog,
  modelCatalogKeys,
  modelEffortsOf,
  preferredEffort,
  reconcileDiscoveredModels,
} from './runtime/model-catalog';
import { FEATURE_REGISTRY, resolveFeatureFlags } from './features/feature-registry';
import { contextWindowOf } from './runtime/model-context-windows';
import { DEFAULT_SETTINGS, DshAgentSettings, resolveDshHome } from './settings/settings';
import { AGENT_PRESETS, agentPresetLabel, applyAgentPreset } from './features/agent-presets';
import {
  archiveSessionLogs,
  backupDataBeforeMigration,
  cleanupSessionLogs,
  collectStorageStats,
  formatBytes,
  PLUGIN_DATA_VERSION,
  redactSensitiveText,
  StorageStats,
} from './persistence/data-lifecycle';
import {
  cloneStorageValue,
  compactConversationForStorage,
  rehydrateConversationForRuntime,
} from './persistence/conversation-storage';
import {
  attributedWorkspacePaths,
  compareWorkspaceSnapshots,
  previewLineDiff,
  revertFileChanges,
  snapshotWorkspaceAsync,
  WorkspaceSnapshot,
} from './features/chat/change-tracker';
import { VIEW_TYPE_DSH_CHAT, VIEW_TYPE_DSH_SYNAPSE } from './constants';

export { VIEW_TYPE_DSH_CHAT } from './constants';

const SUBAGENT_TOOL_NAMES = new Set([
  'subagent',
  'subagent_fork',
  'subagent_codex',
  'subagent_claude_code',
]);

function isSubagentToolName(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

function subagentToolLabel(name: string): string | undefined {
  if (name === 'subagent_codex') return 'Codex';
  if (name === 'subagent_claude_code') return 'Claude Code';
  if (name === 'subagent_fork') return 'Fork';
  return undefined;
}

interface PluginData {
  schemaVersion: number;
  settings?: Partial<DshAgentSettings>;
  conversations: Conversation[];
  deletedConversations: Conversation[];
  activeConversationId?: string;
  synapsePositions?: Record<string, SynapsePosition>;
}

function getVaultPath(app: App): string {
  const adapter = app.vault.adapter as { getBasePath?: () => string };
  if (typeof adapter.getBasePath === 'function') {
    return adapter.getBasePath();
  }
  return '';
}

export default class DshAgentPlugin extends Plugin implements ChatViewHost, SynapseViewHost {
  settings: DshAgentSettings = { ...DEFAULT_SETTINGS };
  private data: PluginData = { schemaVersion: PLUGIN_DATA_VERSION, conversations: [], deletedConversations: [], synapsePositions: {} };
  installer!: DshRuntimeInstaller;
  backend!: DshAcpBackend;
  persistenceRoot = '';
  private listeners = new Set<() => void>();
  private readonly tailers = new Map<string, SessionTailer>();
  private readonly childTailers = new Map<string, SessionTailer>();
  private readonly selectionTracker = new SelectionTracker();
  private domSelectionTracker!: DomSelectionTracker;
  private webSelectionTracker!: WebViewerSelectionTracker;
  private permissionChain: Promise<void> = Promise.resolve();
  private permissionQueueDepth = 0;
  private permissionRenderer: ((request: { toolName: string; prompt: string; argumentsJson: string; risk: string; queueDepth: number }) => Promise<'allow' | 'reject' | 'cancelled'>) | null = null;
  private installState: InstallStatus = { kind: 'not-installed' };
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private pluginDataDir = '';
  private ensureStartPromise: Promise<boolean> | null = null;
  private readonly turnChains = new Map<string, Promise<void>>();
  private readonly activeAssistantMessages = new Map<string, ChatMessage>();
  private readonly turnActivityGuards = new Map<string, ActivityTimeoutGuard>();
  private readonly goalIdleGuardedMessages = new Set<string>();
  private readonly settlingConversations = new Set<string>();
  private unloading = false;
  private backendChangeUnsubscribe: (() => void) | null = null;
  private backendReadyUnsubscribe: (() => void) | null = null;
  private modelCatalog: ModelCatalog = MODEL_CATALOG;
  private modelCatalogHistoryLoaded = false;

  // ---------- lifecycle ----------

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.reinitRuntimePaths();
    if (this.installer.isInstalled()) {
      this.installer.writeRuntimeFiles(this.settings, this.persistenceRoot, this.reasoningOverride());
    }
    this.refreshModelCatalog();
    if (this.settings.sessionLogRetentionDays > 0) {
      try {
        cleanupSessionLogs(this.persistenceRoot, this.settings.sessionLogRetentionDays);
      } catch (error) {
        console.error('dsh-agent: session log cleanup failed', error);
      }
    }

    this.registerView(
      VIEW_TYPE_DSH_CHAT,
      (leaf: WorkspaceLeaf) => new DshChatView(leaf, this),
    );
    this.registerView(
      VIEW_TYPE_DSH_SYNAPSE,
      (leaf: WorkspaceLeaf) => new DshSynapseView(leaf, this),
    );
    this.addRibbonIcon('bot-message-square', '打开 DSH Agent', () => {
      void this.activateView();
    });
    this.addRibbonIcon('network', '打开 DSH 会话地图', () => {
      void this.activateSynapseView();
    });
    this.addCommand({
      id: 'open-dsh-agent-chat',
      name: '打开 DSH Agent 聊天',
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: 'dsh-agent-new-conversation',
      name: '新建 DSH Agent 会话',
      callback: () => {
        const conversation = this.createConversation();
        this.activateConversation(conversation.id);
        void this.activateView();
      },
    });
    this.addCommand({
      id: 'open-dsh-agent-synapse',
      name: '打开 DSH 会话地图',
      callback: () => void this.activateSynapseView(),
    });
    this.addSettingTab(new DshAgentSettingTab(this.app, this));

    this.registerEditorExtension(this.selectionTracker.extension);
    this.selectionTracker.onSelection = (snapshot) => {
      this.handleSelection(snapshot);
    };
    this.domSelectionTracker = new DomSelectionTracker({
      getActiveMarkdownView: () => this.app.workspace.getActiveViewOfType(MarkdownView),
    });
    this.domSelectionTracker.onSelection = (snapshot) => {
      this.handleSelection(snapshot);
    };
    this.domSelectionTracker.attach();
    this.webSelectionTracker = new WebViewerSelectionTracker({
      getActiveWebView: () => this.getActiveWebViewer(),
    });
    this.webSelectionTracker.onSelection = (snapshot) => {
      this.handleWebSelection(snapshot);
    };
    this.webSelectionTracker.attach();
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      this.webSelectionTracker.refresh();
    }));

    if (this.settings.autoStart) {
      void this.ensureStarted();
    }
    // Resume queued messages that survived a reload.
    for (const conversation of this.data.conversations) {
      if (conversation.status !== 'streaming' && (conversation.pendingInput ?? []).length > 0) {
        const next = conversation.pendingInput?.shift();
        if (next !== undefined) void this.dispatchPrompt(conversation, next);
      }
    }

  }

  onunload(): void {
    // Obsidian does not keep its BrowserWindow alive for asynchronous plugin
    // teardown.  Stop every UI callback and detach custom leaves before the
    // first await; otherwise the continuation can touch a destroyed window.
    this.unloading = true;
    this.permissionRenderer = null;
    this.backendChangeUnsubscribe?.();
    this.backendChangeUnsubscribe = null;
    this.backendReadyUnsubscribe?.();
    this.backendReadyUnsubscribe = null;
    try {
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_DSH_CHAT);
      this.app.workspace.detachLeavesOfType(VIEW_TYPE_DSH_SYNAPSE);
    } catch (error) {
      console.warn('dsh-agent: view teardown skipped because the workspace is closing', error);
    }
    this.listeners.clear();
    this.selectionTracker.dispose();
    this.domSelectionTracker.dispose();
    this.webSelectionTracker.dispose();
    for (const tailer of this.tailers.values()) tailer.stop();
    this.tailers.clear();
    for (const tailer of this.childTailers.values()) tailer.stop();
    this.childTailers.clear();
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.activeAssistantMessages.clear();
    for (const guard of this.turnActivityGuards.values()) guard.dispose();
    this.turnActivityGuards.clear();
    this.turnChains.clear();
    // Start the final save immediately, but never resume UI work after it.
    void this.persistData();
    // App shutdown must not wait for the normal two-second graceful backend
    // ladder.  The backend still receives EOF and its process tree is reaped.
    void this.backend.stop(0);
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as PluginData | null;
    this.pluginDataDir = join(getVaultPath(this.app), '.obsidian', 'plugins', 'dsh-agent');
    const loadedVersion = typeof loaded?.schemaVersion === 'number' ? loaded.schemaVersion : 0;
    const needsStorageMigration = loaded !== null && loadedVersion < PLUGIN_DATA_VERSION;
    if (needsStorageMigration) {
      try {
        backupDataBeforeMigration(this.pluginDataDir, loadedVersion);
      } catch (error) {
        console.error('dsh-agent: pre-migration backup failed', error);
        new Notice('DSH Agent: 数据迁移备份失败，已保留原数据并继续加载');
      }
    }
    const loadedSettings = loaded?.settings ?? {};
    this.modelCatalogHistoryLoaded = Array.isArray(loadedSettings.knownModels);
    // Migrate the legacy disabledTools list into the feature registry.
    if (Array.isArray(loadedSettings.disabledTools) && loadedSettings.disabledTools.length > 0) {
      const flags: Record<string, boolean> = { ...(loadedSettings.featureFlags ?? {}) };
      for (const id of loadedSettings.disabledTools) {
        if (typeof id === 'string' && id !== '') flags['tool.' + id] = false;
      }
      loadedSettings.featureFlags = flags;
      loadedSettings.disabledTools = [];
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
    this.settings.hiddenProviders = Array.isArray(this.settings.hiddenProviders)
      ? this.settings.hiddenProviders.filter((entry): entry is string => typeof entry === 'string')
      : [];
    this.settings.hiddenModels = Array.isArray(this.settings.hiddenModels)
      ? this.settings.hiddenModels.filter((entry): entry is string => typeof entry === 'string')
      : [];
    this.settings.knownModels = Array.isArray(this.settings.knownModels)
      ? this.settings.knownModels.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (this.settings.agentPreset !== 'manual'
      && !AGENT_PRESETS.some((preset) => preset.id === this.settings.agentPreset)) {
      this.settings.agentPreset = 'manual';
    }
    this.settings.sessionLogRetentionDays = normalizeNumberSetting(this.settings.sessionLogRetentionDays, 0, 3650, DEFAULT_SETTINGS.sessionLogRetentionDays);
    this.settings.autoCompactPercent = normalizeNumberSetting(this.settings.autoCompactPercent, 0, 100, DEFAULT_SETTINGS.autoCompactPercent);
    this.settings.maxTurnMinutes = normalizeNumberSetting(this.settings.maxTurnMinutes, 0, 24 * 60, DEFAULT_SETTINGS.maxTurnMinutes);
    this.data = {
      schemaVersion: PLUGIN_DATA_VERSION,
      conversations: Array.isArray(loaded?.conversations) ? (loaded as PluginData).conversations : [],
      deletedConversations: Array.isArray(loaded?.deletedConversations) ? loaded.deletedConversations : [],
      activeConversationId: loaded?.activeConversationId,
      synapsePositions: loaded?.synapsePositions !== null && typeof loaded?.synapsePositions === 'object'
        ? loaded.synapsePositions
        : {},
    };
    let repairedSyntheticTitles = false;
    // ACP sessions cannot survive an Obsidian/plugin reload. Normalize stale
    // in-flight state and migrate the old string-only queued-message shape.
    for (const conversation of this.data.conversations) {
      // v0.8.0 stored browser page context and browser selection in the same
      // slot. Split that legacy draft so both chips can coexist.
      if (conversation.selection?.sourceKind === 'web') {
        const legacy = conversation.selection;
        if (legacy.webMode === 'selection') {
          const { contextText: _contextText, contextTruncated: _contextTruncated, ...legacySelection } = legacy;
          conversation.webSelection = legacySelection;
          if (legacy.contextText !== undefined && legacy.contextText.trim() !== '') {
            conversation.webContext = {
              text: legacy.contextText,
              basename: legacy.basename,
              lineStart: 1,
              lineEnd: Math.max(1, legacy.contextText.split('\n').length),
              sourceKind: 'web',
              sourceUrl: legacy.sourceUrl,
              webMode: 'page',
              ...(legacy.contextTruncated === true ? { truncated: true } : {}),
            };
          }
        } else {
          conversation.webContext = legacy;
        }
        conversation.selection = undefined;
      }
      repairedSyntheticTitles = repairSyntheticContextTitle(conversation) || repairedSyntheticTitles;
      rehydrateConversationForRuntime(conversation);
      if (this.settings.redactSensitiveLogs) redactConversationActivities(conversation);
      for (const message of conversation.messages) {
        if (message.role !== 'assistant') continue;
        if (loadedVersion < PLUGIN_DATA_VERSION) dedupeCumulativeTextBlocks(message);
        message.streamedText = undefined;
        message.streamedTextCursor = undefined;
        message.liveReasoning = undefined;
        message.liveReasoningKey = undefined;
      }
      const rawPending = (conversation.pendingInput ?? []) as unknown[];
      conversation.pendingInput = rawPending.map((entry): PendingPrompt => typeof entry === 'string'
        ? { text: entry, attachments: [], quotes: [] }
        : {
            text: typeof (entry as Partial<PendingPrompt>).text === 'string'
              ? (entry as Partial<PendingPrompt>).text as string
              : '',
            attachments: Array.isArray((entry as Partial<PendingPrompt>).attachments)
              ? (entry as Partial<PendingPrompt>).attachments as PendingPrompt['attachments']
              : [],
            quotes: Array.isArray((entry as Partial<PendingPrompt>).quotes)
              ? (entry as Partial<PendingPrompt>).quotes as PendingPrompt['quotes']
              : [],
            ...(typeof (entry as Partial<PendingPrompt>).messageId === 'string'
              ? { messageId: (entry as Partial<PendingPrompt>).messageId }
              : {}),
            ...((entry as Partial<PendingPrompt>).selection !== undefined
              ? { selection: (entry as Partial<PendingPrompt>).selection }
              : {}),
            ...((entry as Partial<PendingPrompt>).webContext !== undefined
              ? { webContext: (entry as Partial<PendingPrompt>).webContext }
              : {}),
            ...((entry as Partial<PendingPrompt>).webSelection !== undefined
              ? { webSelection: (entry as Partial<PendingPrompt>).webSelection }
              : {}),
          });
      // Legacy queue entries stored only text. Link them back to the visible
      // trailing user messages so assistant replies can be inserted in order.
      let messageCursor = conversation.messages.length - 1;
      for (let i = conversation.pendingInput.length - 1; i >= 0; i--) {
        const prompt = conversation.pendingInput[i];
        if (prompt.messageId !== undefined) continue;
        while (messageCursor >= 0) {
          const message = conversation.messages[messageCursor--];
          if (message.role === 'user' && message.text === prompt.text) {
            prompt.messageId = message.id;
            break;
          }
        }
      }
      if (conversation.acpSessionId !== undefined
        || conversation.status === 'preparing'
        || conversation.status === 'streaming') {
        if (conversation.rewindContext === undefined) this.prepareContextTransfer(conversation, messagesBeforePending(conversation));
        conversation.acpSessionId = undefined;
        conversation.status = conversation.messages.length > 0 ? 'disconnected' : 'idle';
      }
      if (conversation.rewindContext !== undefined && conversation.contextTransfer === undefined) {
        const transfer = contextTransferOfMessages(messagesBeforePending(conversation));
        conversation.contextTransfer = transfer.transcript !== '' ? transfer : undefined;
      }
    }
    for (const conversation of this.data.deletedConversations) {
      repairedSyntheticTitles = repairSyntheticContextTitle(conversation) || repairedSyntheticTitles;
      rehydrateConversationForRuntime(conversation);
      if (this.settings.redactSensitiveLogs) redactConversationActivities(conversation);
    }
    this.data.activeConversationId = resolveActiveConversationId(
      this.data.conversations,
      this.data.activeConversationId,
    );
    if (repairedSyntheticTitles || needsStorageMigration) await this.persistData();
  }

  async saveSettings(): Promise<void> {
    await this.persistData();
  }

  /** Build a detached, bounded snapshot before Obsidian serializes data.json. */
  private persistenceSnapshot(): PluginData {
    return {
      schemaVersion: PLUGIN_DATA_VERSION,
      settings: cloneStorageValue(this.settings),
      conversations: this.data.conversations.map(compactConversationForStorage),
      deletedConversations: this.data.deletedConversations.map(compactConversationForStorage),
      activeConversationId: this.data.activeConversationId,
      synapsePositions: cloneStorageValue(this.data.synapsePositions ?? {}),
    };
  }

  async reinitRuntimePaths(): Promise<void> {
    const previous = this.backend as DshAcpBackend | undefined;
    this.backendChangeUnsubscribe?.();
    this.backendChangeUnsubscribe = null;
    this.backendReadyUnsubscribe?.();
    this.backendReadyUnsubscribe = null;
    if (previous !== undefined) await previous.stop();
    this.ensureStartPromise = null;
    const dshHome = resolveDshHome(this.settings);
    this.installer = new DshRuntimeInstaller(dshHome);
    const vaultPath = getVaultPath(this.app);
    this.persistenceRoot = join(vaultPath, '.obsidian', 'plugins', 'dsh-agent', '.sessions');
    const paths = { ...this.installer.paths, persistenceRoot: this.persistenceRoot };
    this.backend = new DshAcpBackend(paths, vaultPath, this.settings);
    this.hookBackend();
  }

  /** Refresh the selector from the installed DSH/pi-ai catalog on every plugin start. */
  private refreshModelCatalog(): void {
    const next = discoverRuntimeModelCatalog(this.installer.paths.profileDir, this.installer.paths.settingsPath);
    this.applyDiscoveredModelCatalog(next);
  }

  private applyDiscoveredModelCatalog(next: ModelCatalog): void {
    const discovered = modelCatalogKeys(next);
    const visibility = reconcileDiscoveredModels(
      discovered,
      this.settings.knownModels,
      this.settings.hiddenModels,
      this.modelCatalogHistoryLoaded,
    );
    let settingsChanged = false;
    if (visibility.knownModels.join('\n') !== this.settings.knownModels.join('\n')) {
      this.settings.knownModels = visibility.knownModels;
      settingsChanged = true;
    }
    if (visibility.hiddenModels.join('\n') !== this.settings.hiddenModels.join('\n')) {
      this.settings.hiddenModels = visibility.hiddenModels;
      settingsChanged = true;
    }
    this.modelCatalogHistoryLoaded = true;
    this.modelCatalog = next;
    const effort = preferredEffort(
      modelEffortsOf(next, this.settings.provider, this.settings.model),
      this.settings.reasoningEffort,
    );
    if (effort !== this.settings.reasoningEffort) {
      this.settings.reasoningEffort = effort;
      settingsChanged = true;
    }
    if (settingsChanged) this.scheduleSave();
    this.emitChange();
  }

  getRuntimeModelCatalog(): ModelCatalog {
    return this.modelCatalog;
  }

  private hookBackend(): void {
    this.backendReadyUnsubscribe = this.backend.onConnectionReady((connection: AcpClientConnection) => {
      if (this.unloading) return;
      connection.onPermissionRequest((request, params) =>
        this.handlePermissionRequest(request, params),
      );
      // A fresh backend knows nothing about previous sessions.
      this.invalidateAcpSessions();
    });
    this.backendChangeUnsubscribe = this.backend.onChange(() => this.emitChange());
  }

  private invalidateAcpSessions(): void {
    let changed = false;
    for (const conversation of this.data.conversations) {
      this.stopTailer(conversation.id);
      if (conversation.acpSessionId !== undefined) {
        if (conversation.rewindContext === undefined) this.prepareContextTransfer(conversation, messagesBeforePending(conversation));
        conversation.acpSessionId = undefined;
        conversation.status = 'disconnected';
        this.activeAssistantMessages.delete(conversation.id);
        changed = true;
      }
    }
    if (changed) {
      this.emitChange();
      this.scheduleSave();
    }
  }

  // ---------- backend ----------

  async ensureStarted(): Promise<boolean> {
    if (this.unloading) return false;
    if (this.backend.currentConnection !== null) return true;
    if (this.ensureStartPromise !== null) return this.ensureStartPromise;
    const start = this.ensureStartedInner();
    this.ensureStartPromise = start;
    try {
      return await start;
    } finally {
      if (this.ensureStartPromise === start) this.ensureStartPromise = null;
    }
  }

  private async ensureStartedInner(): Promise<boolean> {
    if (this.unloading) return false;
    if (!this.installer.isInstalled()) {
      new Notice('DSH Agent: 首次使用需要安装运行时（约 1-3 分钟）…');
      this.installState = { kind: 'installing', detail: '正在安装运行时…' };
      this.emitChange();
      const status = await this.installer.ensureInstalled(
        this.settings,
        this.persistenceRoot,
        (detail) => {
          this.installState = { kind: 'installing', detail };
          this.emitChange();
        },
      );
      if (this.unloading) return false;
      this.installState = status;
      this.emitChange();
      if (status.kind !== 'installed') {
        const detail = 'detail' in status ? status.detail : '';
        new Notice('DSH Agent 运行时安装失败: ' + detail.slice(0, 120));
        return false;
      }
    } else {
      this.installer.writeRuntimeFiles(this.settings, this.persistenceRoot, this.reasoningOverride());
      this.installState = { kind: 'installed', detail: '运行时已就绪' };
      this.emitChange();
    }
    this.refreshModelCatalog();
    const result = await this.backend.start();
    if (this.unloading) return false;
    if (!result.ok) {
      new Notice('DSH Agent 后端启动失败: ' + (result.error ?? '未知错误').slice(0, 200));
      return false;
    }
    return true;
  }

  async applySettingsAndRestart(): Promise<void> {
    this.installer.writeRuntimeFiles(this.settings, this.persistenceRoot, this.reasoningOverride());
    await this.backend.stop();
    void this.ensureStarted();
  }

  // ---------- permission handling ----------

  private async handlePermissionRequest(
    _request: unknown,
    params: AcpRequestPermissionParams,
  ): Promise<AcpRequestPermissionResult> {
    if (this.unloading) return { outcome: { outcome: 'cancelled' } };
    if (this.settings.approvalPolicy === 'never') {
      return { outcome: { outcome: 'selected', optionId: 'reject-once' } };
    }
    this.permissionQueueDepth += 1;
    return new Promise<AcpRequestPermissionResult>((resolve) => {
      const execute = async (): Promise<void> => {
        try {
          resolve(await this.presentPermissionRequest(params));
        } catch {
          resolve({ outcome: { outcome: 'cancelled' } });
        } finally {
          this.permissionQueueDepth = Math.max(0, this.permissionQueueDepth - 1);
        }
      };
      // Permission requests may arrive concurrently from workflow agents. Keep
      // every request and present them sequentially instead of cancelling all
      // but the first one.
      this.permissionChain = this.permissionChain.then(execute, execute);
    });
  }

  private async presentPermissionRequest(params: AcpRequestPermissionParams): Promise<AcpRequestPermissionResult> {
    const activity = this.lookupToolActivity(params.sessionId, params.toolCall.toolCallId);
    const toolName = activity?.name ?? '未知工具';
    const argumentsJson = activity?.argumentsJson ?? '';
    const promptText = (params.toolCall as { title?: string }).title ?? '';
    const risk = permissionRisk(toolName, argumentsJson);
    if (this.permissionRenderer !== null) {
      const decision = await this.permissionRenderer({
        toolName,
        prompt: promptText,
        argumentsJson,
        risk,
        queueDepth: this.permissionQueueDepth,
      });
      if (decision === 'cancelled') return { outcome: { outcome: 'cancelled' } };
      const kind = decision === 'allow' ? 'allow_once' : 'reject_once';
      const fallback = decision === 'allow' ? 'allow-once' : 'reject-once';
      const optionId = params.options.find((option) => option.kind === kind)?.optionId ?? fallback;
      return { outcome: { outcome: 'selected', optionId } };
    }
    const modal = new PermissionModal(
      this.app,
      params,
      120_000,
      toolName,
      argumentsJson,
      risk,
      this.permissionQueueDepth,
    );
    modal.open();
    const decision = await modal.decide();
    if (decision === 'cancelled') return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: modal.pickOptionId(decision) } };
  }

  // ---------- ChatViewHost ----------

  registerPermissionRenderer(
    renderer: ((request: { toolName: string; prompt: string; argumentsJson: string; risk: string; queueDepth: number }) => Promise<'allow' | 'reject' | 'cancelled'>) | null,
  ): void {
    this.permissionRenderer = renderer;
  }

  getApp(): App {
    return this.app;
  }

  getConversations(): Conversation[] {
    return this.data.conversations;
  }

  getActiveConversation(): Conversation | null {
    return this.data.conversations.find(
      (conversation) => conversation.id === this.data.activeConversationId && conversation.closed !== true,
    ) ?? null;
  }

  activateConversation(id: string): void {
    const conversation = this.data.conversations.find(
      (entry) => entry.id === id && entry.closed !== true,
    );
    if (conversation === undefined) return;
    this.data.activeConversationId = id;
    this.emitChange();
    this.scheduleSave();
  }

  createConversation(): Conversation {
    const conversation = createConversation(getVaultPath(this.app));
    this.data.conversations.push(conversation);
    this.data.activeConversationId = conversation.id;
    // Auto-attach the currently active note (silent, per phase-3 UX).
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile !== null) {
      conversation.attachments = [{ name: activeFile.basename, uri: activeFile.path }];
    }
    this.emitChange();
    this.scheduleSave();
    return conversation;
  }

  /** Close (archive) a conversation: hidden from the strip, kept in history. */
  setConversationClosed(id: string, closed: boolean): void {
    const conversation = this.data.conversations.find((c) => c.id === id);
    if (conversation === undefined || conversation.closed === closed) return;
    conversation.closed = closed;
    this.data.activeConversationId = resolveActiveConversationId(
      this.data.conversations,
      this.data.activeConversationId,
    );
    this.emitChange();
    this.scheduleSave();
  }

  closeWorkspaceConversations(workspace: string): number {
    const closed = closeSynapseWorkspaceConversations(this.data.conversations, workspace);
    if (closed === 0) return 0;
    this.data.activeConversationId = resolveActiveConversationId(
      this.data.conversations,
      this.data.activeConversationId,
    );
    this.emitChange();
    this.scheduleSave();
    return closed;
  }

  renameConversation(id: string, title: string): boolean {
    const conversation = this.data.conversations.find((entry) => entry.id === id);
    const normalized = normalizeConversationTitle(title);
    if (conversation === undefined || normalized === '') return false;
    conversation.title = normalized;
    conversation.titleManuallySet = true;
    conversation.titleFromServer = false;
    this.emitChange();
    this.scheduleSave();
    return true;
  }

  removeConversation(id: string): void {
    const conversation = this.data.conversations.find((entry) => entry.id === id);
    if (conversation !== undefined && this.isConversationBusy(conversation)) {
      new Notice('请等待当前请求结束，再删除会话');
      return;
    }
    this.stopTailer(id);
    if (conversation !== undefined) this.prepareContextTransfer(conversation, conversation.messages);
    if (conversation !== undefined && (conversation.sessionLogPaths ?? []).length > 0) {
      try {
        archiveSessionLogs(conversation.sessionLogPaths ?? [], this.persistenceRoot);
      } catch (error) {
        console.error('dsh-agent: failed to archive conversation logs', error);
      }
    }
    this.data.conversations = this.data.conversations.filter((c) => c.id !== id);
    if (this.data.synapsePositions !== undefined) delete this.data.synapsePositions[id];
    if (conversation !== undefined) {
      conversation.deletedAt = Date.now();
      conversation.acpSessionId = undefined;
      conversation.status = conversation.messages.length > 0 ? 'disconnected' : 'idle';
      conversation.sessionLogPaths = [];
      this.data.deletedConversations.push(conversation);
    }
    this.data.activeConversationId = resolveActiveConversationId(
      this.data.conversations,
      this.data.activeConversationId,
    );
    this.emitChange();
    this.scheduleSave();
  }

  getDeletedConversationCount(): number {
    return this.data.deletedConversations.length;
  }

  restoreLastDeletedConversation(): Conversation | undefined {
    const conversation = this.data.deletedConversations.pop();
    if (conversation === undefined) return undefined;
    conversation.deletedAt = undefined;
    conversation.closed = false;
    conversation.acpSessionId = undefined;
    conversation.status = conversation.messages.length > 0 ? 'disconnected' : 'idle';
    // Queued entries are preserved as visible user history but are not
    // executed unexpectedly on restore. The next prompt receives them via
    // the transparent fresh-session transfer.
    conversation.pendingInput = [];
    this.prepareContextTransfer(conversation, conversation.messages);
    this.data.conversations.push(conversation);
    this.data.activeConversationId = conversation.id;
    this.emitChange();
    this.scheduleSave();
    return conversation;
  }

  /** Send a user message (appends it, then dispatches the turn). */
  async sendMessage(conversation: Conversation, text: string): Promise<void> {
    const prompt = this.capturePrompt(conversation, text);
    const messageId = randomId();
    prompt.messageId = messageId;
    appendMessage(conversation, {
      id: messageId,
      role: 'user',
      text,
      time: Date.now(),
      contextMeta: {
        quotes: prompt.quotes.length,
        noted: prompt.quotes.filter((quote) => quote.note.trim() !== '').length,
        attachments: prompt.attachments.length,
        selection: prompt.selection !== undefined
          || prompt.webContext !== undefined
          || prompt.webSelection !== undefined,
      },
      promptSnapshot: clonePrompt(prompt),
    });
    if (conversation.title === '新会话') conversation.title = deriveTitle(conversation);
    this.emitChange();
    this.scheduleSave();
    await this.dispatchPrompt(conversation, prompt);
  }

  /**
   * Send while the model replies: either interrupt the in-flight turn
   * (queuePolicy=interrupt) or queue the message for after it settles.
   */
  async sendOrQueue(conversation: Conversation, text: string): Promise<void> {
    const busy = this.isConversationBusy(conversation);
    if (!busy) {
      await this.sendMessage(conversation, text);
      return;
    }
    // There is no ACP request to cancel while the workspace snapshot is being
    // prepared. Queueing is the only lossless behavior even in interrupt mode.
    if (this.settings.queuePolicy === 'queue' || conversation.status === 'preparing') {
      this.enqueuePrompt(conversation, text);
      return;
    }
    // Interrupt: cancel the in-flight turn, wait for it to settle, then send.
    this.stopActiveTurn();
    const deadline = Date.now() + 10_000;
    while (this.isConversationBusy(conversation) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (this.isConversationBusy(conversation)) {
      // Cancellation did not settle in time. Persist the turn in the same
      // queue shape instead of creating an untracked in-memory chain item.
      this.enqueuePrompt(conversation, text);
      return;
    }
    await this.sendMessage(conversation, text);
  }

  private isConversationBusy(conversation: Conversation): boolean {
    return conversation.status === 'preparing'
      || conversation.status === 'streaming'
      || this.settlingConversations.has(conversation.id);
  }

  private enqueuePrompt(conversation: Conversation, text: string): void {
    const prompt = this.capturePrompt(conversation, text);
    const messageId = randomId();
    prompt.messageId = messageId;
    appendMessage(conversation, {
      id: messageId,
      role: 'user',
      text,
      time: Date.now(),
      contextMeta: {
        quotes: prompt.quotes.length,
        noted: prompt.quotes.filter((quote) => quote.note.trim() !== '').length,
        attachments: prompt.attachments.length,
        selection: prompt.selection !== undefined
          || prompt.webContext !== undefined
          || prompt.webSelection !== undefined,
      },
      promptSnapshot: clonePrompt(prompt),
    });
    if (conversation.title === '新会话') conversation.title = deriveTitle(conversation);
    conversation.pendingInput ??= [];
    conversation.pendingInput.push(prompt);
    this.emitChange();
    this.scheduleSave();
  }

  /** Snapshot and clear one-shot context at the moment the user sends. */
  private capturePrompt(conversation: Conversation, text: string): PendingPrompt {
    const prompt: PendingPrompt = {
      text,
      attachments: JSON.parse(JSON.stringify(conversation.attachments ?? [])) as PendingPrompt['attachments'],
      quotes: JSON.parse(JSON.stringify(conversation.quotes ?? [])) as PendingPrompt['quotes'],
      ...(conversation.selection !== undefined
        ? { selection: { ...conversation.selection } }
        : {}),
      ...(conversation.webContext !== undefined
        ? { webContext: { ...conversation.webContext } }
        : {}),
      ...(conversation.webSelection !== undefined
        ? { webSelection: { ...conversation.webSelection } }
        : {}),
    };
    conversation.attachments = [];
    conversation.selection = undefined;
    conversation.webContext = undefined;
    conversation.webSelection = undefined;
    conversation.quotes = [];
    return prompt;
  }

  setConversationPinned(id: string, pinned: boolean): void {
    const conversation = this.data.conversations.find((c) => c.id === id);
    if (conversation === undefined || conversation.pinned === pinned) return;
    conversation.pinned = pinned;
    this.emitChange();
    this.scheduleSave();
  }

  cancelQueuedPrompt(conversation: Conversation, messageId: string): boolean {
    const changed = cancelPendingPrompt(conversation, messageId);
    if (changed) {
      this.emitChange();
      this.scheduleSave();
    }
    return changed;
  }

  moveQueuedPrompt(conversation: Conversation, messageId: string, delta: -1 | 1): boolean {
    const changed = movePendingPrompt(conversation, messageId, delta);
    if (changed) {
      this.emitChange();
      this.scheduleSave();
    }
    return changed;
  }

  /**
   * Roll the conversation back to BEFORE the given message: that user input
   * and everything after it are dropped. The ACP session cannot truncate its
   * server-side context, so the conversation switches to a fresh session and
   * the kept history is injected as a transcript on the next send.
   */
  rewindConversation(conversation: Conversation, messageId: string): string | undefined {
    const index = conversation.messages.findIndex((msg) => msg.id === messageId);
    if (index === -1) return undefined;
    if (conversation.status === 'streaming') this.stopActiveTurn();
    const removed = conversation.messages[index];
    const kept = conversation.messages.slice(0, index);
    conversation.messages = kept;
    conversation.pendingInput = [];
    this.prepareContextTransfer(conversation, kept);
    conversation.lastUsage = undefined;
    if (conversation.acpSessionId !== undefined) {
      conversation.acpSessionId = undefined;
      conversation.status = 'disconnected';
      this.stopTailer(conversation.id);
    }
    this.emitChange();
    this.scheduleSave();
    return removed.role === 'user' ? removed.text : undefined;
  }

  async retryAssistant(conversation: Conversation, messageId: string): Promise<boolean> {
    return this.recoverAssistant(conversation, messageId, 'retry');
  }

  async regenerateAssistant(conversation: Conversation, messageId: string): Promise<boolean> {
    return this.recoverAssistant(conversation, messageId, 'regenerate');
  }

  async continueAssistant(conversation: Conversation, messageId: string): Promise<boolean> {
    if (this.isConversationBusy(conversation)) return false;
    const assistantIndex = conversation.messages.findIndex((message) => message.id === messageId && message.role === 'assistant');
    if (assistantIndex < 0) return false;
    const interrupted = conversation.messages[assistantIndex];
    if (interrupted.superseded === true || interrupted.continued === true) return false;
    if (interrupted.goalLoopGuardTriggered === true) return false;
    if (interrupted.error === undefined
      && interrupted.stopReason !== 'max_tokens'
      && interrupted.stopReason !== 'cancelled') return false;
    this.prepareContextTransfer(conversation, conversation.messages.slice(0, assistantIndex + 1));
    this.resetConversationSession(conversation);
    const continueMessageId = randomId();
    const prompt: PendingPrompt = {
      text: '请从上次中断处继续，不要重复已经完成的内容。',
      messageId: continueMessageId,
      attachments: [],
      quotes: [],
    };
    const userMessage: ChatMessage = {
      id: continueMessageId,
      role: 'user',
      text: prompt.text,
      time: Date.now(),
      promptSnapshot: clonePrompt(prompt),
    };
    conversation.messages.splice(assistantIndex + 1, 0, userMessage);
    interrupted.continued = true;
    conversation.status = 'preparing';
    this.emitChange();
    this.scheduleSave();
    await this.dispatchPrompt(conversation, prompt);
    const replacement = conversation.messages.find((message, index) => index > assistantIndex + 1 && message.role === 'assistant');
    if (replacement !== undefined) replacement.recoveryKind = 'continue';
    return true;
  }

  private async recoverAssistant(
    conversation: Conversation,
    messageId: string,
    kind: 'retry' | 'regenerate',
  ): Promise<boolean> {
    if (this.isConversationBusy(conversation)) return false;
    const assistantIndex = conversation.messages.findIndex((message) => message.id === messageId && message.role === 'assistant');
    if (assistantIndex < 0) return false;
    if (conversation.messages[assistantIndex].superseded === true) return false;
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && conversation.messages[userIndex].role !== 'user') userIndex -= 1;
    if (userIndex < 0) return false;
    const userMessage = conversation.messages[userIndex];
    const prompt = clonePrompt(userMessage.promptSnapshot ?? {
      text: userMessage.text,
      messageId: userMessage.id,
      attachments: [],
      quotes: [],
    });
    let replacementAnchorIndex = assistantIndex;
    if (kind === 'regenerate') {
      const rewind = rewindForAssistantRegeneration(conversation, messageId);
      if (rewind === undefined) return false;
      prompt.messageId = rewind.userMessage.id;
      replacementAnchorIndex = rewind.userIndex;
      this.prepareContextTransfer(conversation, rewind.contextMessages);
    } else {
      const previousAssistant = conversation.messages[assistantIndex];
      previousAssistant.superseded = true;
      prompt.messageId = previousAssistant.id;
      this.prepareContextTransfer(conversation, conversation.messages.slice(0, userIndex));
    }
    conversation.lastUsage = undefined;
    this.resetConversationSession(conversation);
    // Lock recovery controls synchronously, before dispatchPrompt reaches its
    // first microtask, so repeated clicks cannot create duplicate turns.
    conversation.status = 'preparing';
    this.emitChange();
    this.scheduleSave();
    await this.dispatchPrompt(conversation, prompt);
    const replacement = conversation.messages.find(
      (message, index) => index > replacementAnchorIndex && message.role === 'assistant',
    );
    if (replacement !== undefined) replacement.recoveryKind = kind;
    return true;
  }

  private resetConversationSession(conversation: Conversation): void {
    this.stopTailer(conversation.id);
    conversation.acpSessionId = undefined;
    conversation.status = conversation.messages.length > 0 ? 'disconnected' : 'idle';
    this.activeAssistantMessages.delete(conversation.id);
  }

  private prepareContextTransfer(conversation: Conversation, messages: ChatMessage[]): void {
    const transfer = contextTransferOfMessages(messages);
    conversation.rewindContext = transfer.transcript !== '' ? transfer.transcript : undefined;
    conversation.contextTransfer = transfer.transcript !== '' ? transfer : undefined;
  }

  /**
   * Serialize turns per conversation. The chain includes the JSONL settle
   * grace period, preventing a previous turn from pausing or stealing events
   * from the next one.
   */
  private dispatchPrompt(conversation: Conversation, prompt: PendingPrompt): Promise<void> {
    const previous = this.turnChains.get(conversation.id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.runPromptTurn(conversation, prompt));
    this.turnChains.set(conversation.id, run);
    const cleanup = (): void => {
      if (this.turnChains.get(conversation.id) === run) this.turnChains.delete(conversation.id);
    };
    void run.then(cleanup, cleanup);
    return run;
  }

  /** Dispatch one prompt turn (the user message was appended at capture time). */
  private async runPromptTurn(conversation: Conversation, prompt: PendingPrompt): Promise<void> {
    if (!this.data.conversations.includes(conversation)) return;
    const changeStartedAt = Date.now();
    let beforeSnapshot: WorkspaceSnapshot | undefined;
    conversation.status = 'preparing';
    this.emitChange();
    try {
      beforeSnapshot = await snapshotWorkspaceAsync(conversation.workspace);
    } catch (error) {
      console.error('dsh-agent: failed to snapshot workspace before turn', error);
    }
    let text = prompt.text;
    if (shouldAutoCompact(conversation, this.getModelContextWindow(), this.settings.autoCompactPercent)) {
      const usage = conversation.lastUsage;
      if (usage !== undefined) {
        const percent = ((usage.inputTokens + usage.cacheReadTokens) / this.getModelContextWindow()) * 100;
        conversation.lastAutoCompactUsageTime = usage.time;
        conversation.contextMaintenance = {
          kind: 'auto-compaction',
          percent,
          time: Date.now(),
          preview: '已在本轮请求前注入上下文压缩要求；原始请求保持不变。',
        };
        text = '在处理下面的请求前，请先将当前上下文压缩为关键事实、已完成工作、未完成事项和约束；随后继续完成用户请求，不要只返回摘要。\n\n用户请求：\n' + text;
      }
    }
    if (conversation.rewindContext !== undefined) {
      const prefix = conversation.rewindContext;
      conversation.rewindContext = undefined;
      if (conversation.acpSessionId !== undefined) {
        conversation.acpSessionId = undefined;
        this.stopTailer(conversation.id);
      }
      text = prefix + '\n\n' + text;
    }
    const ok = await this.ensureStarted();
    const connection = this.backend.currentConnection;
    if (!ok || connection === null) {
      appendMessage(conversation, {
        id: randomId(),
        role: 'assistant',
        text: '',
        time: Date.now(),
        error: 'DSH 后端未就绪，请检查设置中的运行时状态。',
      });
      conversation.status = 'error';
      this.emitChange();
      this.scheduleSave();
      return;
    }

    if (conversation.acpSessionId === undefined) {
      try {
        const session = await connection.newSession(conversation.workspace);
        conversation.acpSessionId = session.sessionId;
      } catch (error) {
        appendMessage(conversation, {
          id: randomId(),
          role: 'assistant',
          text: '',
          time: Date.now(),
          error: '创建 ACP 会话失败: ' + String(error),
        });
        conversation.status = 'error';
        this.emitChange();
        this.scheduleSave();
        return;
      }
    }

    const sessionId = conversation.acpSessionId;
    const nativeImages = await this.loadNativeImages(connection, prompt.attachments);
    const promptBlocks: AcpPromptBlock[] = buildPromptBlocks(
      text,
      prompt.attachments,
      prompt.selection,
      prompt.quotes,
      nativeImages,
      prompt.webContext,
      prompt.webSelection,
    );

    const assistantMessage: ChatMessage = {
      id: randomId(), role: 'assistant', text: '', time: Date.now(), streamedTextCursor: 0,
    };
    appendAssistantAfterPrompt(conversation, assistantMessage, prompt.messageId);
    conversation.status = 'streaming';
    this.emitChange();
    this.scheduleSave();

    this.activeAssistantMessages.set(conversation.id, assistantMessage);
    const timeoutMs = this.settings.maxTurnMinutes > 0
      ? this.settings.maxTurnMinutes * 60_000
      : 0;
    const activityGuard = new ActivityTimeoutGuard(
      timeoutMs,
      () => connection.cancel(sessionId),
    );
    this.turnActivityGuards.set(conversation.id, activityGuard);
    const tailer = this.ensureTailer(conversation);
    if (tailer !== undefined) tailer.start(); // resume when paused
    const chunkListener = (chunkSessionId: string, chunkText: string) => {
      if (chunkSessionId !== sessionId) return;
      activityGuard.touch();
      if (conversation.status !== 'streaming') return;
      assistantMessage.text += chunkText;
      this.emitChange();
    };
    const unsubscribe = connection.onMessageChunk(chunkListener);
    let finalStatus: Conversation['status'] = 'idle';
    try {
      // The transport request itself is unlimited. The guard is reset by both
      // ACP text chunks and durable JSONL activity, so a productive deep task
      // may exceed the configured window without being mistaken for a hang.
      const result = await activityGuard.wait(connection.prompt(sessionId, promptBlocks, 0));
      assistantMessage.stopReason = result.stopReason;
    } catch (error) {
      assistantMessage.error = String(error).includes('request inactivity timeout:')
        ? '请求失败：连续 ' + this.settings.maxTurnMinutes + ' 分钟没有检测到后端活动，已自动停止本轮'
        : '请求失败: ' + String(error);
      finalStatus = 'error';
    } finally {
      activityGuard.dispose();
      if (this.turnActivityGuards.get(conversation.id) === activityGuard) {
        this.turnActivityGuards.delete(conversation.id);
      }
      unsubscribe();
      this.settlingConversations.add(conversation.id);
      this.emitChange();
      this.scheduleSave();
      // Keep the turn-to-message binding alive while the JSONL writer flushes.
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 1200));
        await this.settleTailer(conversation, assistantMessage);
        if (beforeSnapshot !== undefined) {
          try {
            const afterSnapshot = await snapshotWorkspaceAsync(conversation.workspace);
            const candidatePaths = new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()]);
            const attributedPaths = attributedWorkspacePaths(
              conversation.workspace,
              assistantMessage.toolActivities ?? [],
              candidatePaths,
            );
            const changeSet = compareWorkspaceSnapshots(
              beforeSnapshot,
              afterSnapshot,
              changeStartedAt,
              Date.now(),
              attributedPaths,
            );
            if (changeSet.files.length > 0 || changeSet.truncated) {
              assistantMessage.changeSet = changeSet;
              pruneChangeSetSnapshots(conversation);
            }
          } catch (error) {
            console.error('dsh-agent: failed to snapshot workspace after turn', error);
          }
        }
      } finally {
        conversation.status = finalStatus;
        assistantMessage.liveReasoning = undefined;
        assistantMessage.liveReasoningKey = undefined;
        this.settlingConversations.delete(conversation.id);
        if (this.activeAssistantMessages.get(conversation.id) === assistantMessage) {
          this.activeAssistantMessages.delete(conversation.id);
        }
        this.goalIdleGuardedMessages.delete(assistantMessage.id);
      }
    }
    // Feed queued messages once this turn has settled.
    if (conversation.status === 'idle') {
      const next = (conversation.pendingInput ?? []).shift();
      if (next !== undefined) {
        void this.dispatchPrompt(conversation, next);
      }
    }
    this.emitChange();
    this.scheduleSave();
  }

  private async loadNativeImages(
    connection: AcpClientConnection,
    attachments: readonly NoteAttachment[],
  ): Promise<Map<string, NativeImagePayload>> {
    const output = new Map<string, NativeImagePayload>();
    if (connection.negotiatedAgentCapabilities?.promptCapabilities.image !== true) return output;
    const maxSourceBytes = 20 * 1024 * 1024;
    for (const attachment of attachments) {
      const kind = attachment.kind ?? attachmentKind(attachment.uri || attachment.name, attachment.mimeType);
      if (kind !== 'image') continue;
      const mimeType = acpImageMimeType(attachment);
      if (mimeType === undefined || (attachment.size ?? 0) > maxSourceBytes) continue;
      try {
        const bytes = await this.app.vault.adapter.readBinary(attachment.uri);
        if (bytes.byteLength > maxSourceBytes) continue;
        output.set(attachment.uri, {
          mimeType,
          data: Buffer.from(bytes).toString('base64'),
        });
      } catch (error) {
        console.warn('dsh-agent: unable to prepare native image block', attachment.uri, error);
      }
    }
    return output;
  }

  private async settleTailer(conversation: Conversation, assistantMessage: ChatMessage): Promise<void> {
    const tailer = this.tailers.get(conversation.id);
    if (tailer !== undefined) {
      await tailer.flush();
    }
    let changed = this.flushPendingText(assistantMessage);
    assistantMessage.streamedText = undefined;
    assistantMessage.streamedTextCursor = undefined;
    // The turn has settled: any activity still marked running has no result
    // event coming — mark it done so cards don't stick on 运行中.
    for (const activity of assistantMessage.toolActivities ?? []) {
      if (activity.status === 'running') {
        activity.status = 'done';
        activity.endTime = Date.now();
        changed = true;
      }
    }
    // The final summary can miss the last log poll; the wire always carried it.
    if (reconcileWireText(assistantMessage)) changed = true;
    const maintenance = conversation.contextMaintenance;
    if (maintenance !== undefined && maintenance.kind !== 'warning'
      && maintenance.time <= assistantMessage.time && assistantMessage.text.trim() !== '') {
      maintenance.preview = '结果预览：' + assistantMessage.text.trim().slice(0, 500);
      changed = true;
    }
    // First settled reply: always ask the model for a concise title
    // (the server-side title, if any, is just an interim placeholder).
    if (conversation.messages.filter((msg) => msg.role === 'assistant' && msg.error === undefined).length === 1) {
      void this.generateTitleFor(conversation);
    }
    this.pauseTailer(conversation.id);
    if (changed) this.emitChange();
  }

  /** Ask the model for a concise conversation title (silent failure-tolerant). */
  private async generateTitleFor(conversation: Conversation): Promise<void> {
    const firstUser = conversation.messages.find((msg) => msg.role === 'user');
    if (firstUser === undefined) return;
    const text = firstUser.text.trim();
    if (text === '') return;
    const connection = this.backend.currentConnection;
    if (connection === null) return;
    try {
      const session = await connection.newSession(conversation.workspace);
      let title = '';
      const unsubscribe = connection.onMessageChunk((sid, chunk) => {
        if (sid !== session.sessionId) return;
        title += chunk;
      });
      try {
        await connection.prompt(session.sessionId, [
          {
            type: 'text',
            text: '为以下对话内容生成一个简洁的中文标题（不超过 12 个字，不含标点与引号），只输出标题本身：\n\n' + text.slice(0, 2000),
          },
        ], 60_000);
      } finally {
        unsubscribe();
      }
      const trimmed = title.replace(/^["「『【]+|[”」』】]+$/g, '').trim();
      if (trimmed !== '') {
        conversation.title = trimmed.length > 24 ? trimmed.slice(0, 24) + '…' : trimmed;
        this.emitChange();
        this.scheduleSave();
      }
    } catch {
      // Keep the derived title on failure.
    }
  }

  getCurrentConfig(): { provider: string; model: string; reasoningEffort: DshAgentSettings['reasoningEffort']; permissionMode: string; agentPreset: string } {
    return {
      provider: this.settings.provider,
      model: this.settings.model,
      reasoningEffort: this.settings.reasoningEffort,
      permissionMode: this.settings.permissionMode,
      agentPreset: this.settings.agentPreset,
    };
  }

  getAgentPresets(): { id: string; name: string; description: string }[] {
    return [
      { id: 'manual', name: '自定义', description: '保留单独选择的模型、Effort、权限与工具' },
      ...AGENT_PRESETS.map((preset) => ({ id: preset.id, name: preset.name, description: preset.description })),
    ];
  }

  getReasoningEfforts(): DshAgentSettings['reasoningEffort'][] {
    return modelEffortsOf(this.modelCatalog, this.settings.provider, this.settings.model);
  }

  /** Context window (tokens) for the selected model, from the pi-ai catalog. */
  getModelContextWindow(): number {
    return this.modelCatalog[this.settings.provider]?.models
      .find((model) => model.id === this.settings.model)?.contextWindow
      ?? contextWindowOf(this.settings.provider, this.settings.model);
  }

  getContextPolicy(): { autoCompactPercent: number } {
    return { autoCompactPercent: this.settings.autoCompactPercent };
  }

  async requestCompaction(conversation: Conversation): Promise<void> {
    const usage = conversation.lastUsage;
    const used = usage === undefined ? 0 : usage.inputTokens + usage.cacheReadTokens;
    const windowTokens = this.getModelContextWindow();
    conversation.contextMaintenance = {
      kind: 'manual-compaction',
      percent: windowTokens > 0 ? (used / windowTokens) * 100 : 0,
      time: Date.now(),
      preview: '已请求总结关键事实、决策、约束、进度与待办，并继续保持可执行上下文。',
    };
    await this.sendOrQueue(conversation, '请压缩当前会话上下文：保留关键事实、已做决策、用户约束、已完成工作、未完成事项和必要路径；给出精简摘要，供后续继续。');
  }

  previewFileChange(message: ChatMessage, path: string): string {
    const change = message.changeSet?.files.find((entry) => entry.path === path);
    return change === undefined ? '' : previewLineDiff(change);
  }

  async undoMessageChanges(conversation: Conversation, messageId: string): Promise<{ reverted: string[]; conflicts: string[]; unavailable: string[] }> {
    const message = conversation.messages.find((entry) => entry.id === messageId);
    if (message?.changeSet === undefined) return { reverted: [], conflicts: [], unavailable: [] };
    const reverted: string[] = [];
    const conflicts: string[] = [];
    const unavailable: string[] = [];
    const nodeChanges = [] as typeof message.changeSet.files;
    const vaultRoot = resolve(getVaultPath(this.app));
    for (const change of message.changeSet.files) {
      if (change.kind !== 'created' || change.reverted) {
        nodeChanges.push(change);
        continue;
      }
      const absolute = resolve(conversation.workspace, change.path);
      const rel = relative(vaultRoot, absolute);
      const insideVault = rel !== '' && rel !== '..' && !rel.startsWith('..' + sep);
      if (!insideVault) {
        nodeChanges.push(change);
        continue;
      }
      const file = this.app.vault.getAbstractFileByPath(rel.replace(/\\/g, '/'));
      if (file === null) {
        change.reverted = true;
        reverted.push(change.path);
        continue;
      }
      if (!(file instanceof TFile) || change.after === undefined) {
        unavailable.push(change.path);
        continue;
      }
      try {
        const current = await this.app.vault.read(file);
        if (current !== change.after) {
          conflicts.push(change.path);
          continue;
        }
        // Obsidian owns its .trash semantics; plugin code never writes there directly.
        await this.app.fileManager.trashFile(file);
        change.reverted = true;
        reverted.push(change.path);
      } catch {
        unavailable.push(change.path);
      }
    }
    const nodeResult = revertFileChanges(
      conversation.workspace,
      { ...message.changeSet, files: nodeChanges },
      join(this.persistenceRoot, '.change-trash'),
    );
    reverted.push(...nodeResult.reverted);
    conflicts.push(...nodeResult.conflicts);
    unavailable.push(...nodeResult.unavailable);
    if (reverted.length > 0) message.changeSet.revertedAt = Date.now();
    this.emitChange();
    this.scheduleSave();
    return { reverted, conflicts, unavailable };
  }

  getStorageStats(): StorageStats {
    try {
      return collectStorageStats(this.pluginDataDir);
    } catch {
      return { totalBytes: 0, dataBytes: 0, sessionBytes: 0, backupBytes: 0, sessionFiles: 0 };
    }
  }

  cleanupStoredLogs(): { removed: number; bytes: number } {
    try {
      return cleanupSessionLogs(this.persistenceRoot, this.settings.sessionLogRetentionDays);
    } catch (error) {
      console.error('dsh-agent: manual session cleanup failed', error);
      return { removed: 0, bytes: 0 };
    }
  }

  /** Unified feature switches resolved over defaults (missing = enabled). */
  getFeatureFlags(): Record<string, boolean> {
    return resolveFeatureFlags(this.settings.featureFlags);
  }

  attachNote(conversation: Conversation, path: string, basename: string): void {
    conversation.attachments ??= [];
    if (!conversation.attachments.some((a) => a.uri === path)) {
      conversation.attachments.push({ name: basename, uri: path, kind: 'note', mimeType: 'text/markdown', extraction: 'resource-link' });
    }
    this.emitChange();
    this.scheduleSave();
  }

  async importFiles(conversation: Conversation, files: File[]): Promise<{ imported: number; failed: string[] }> {
    const folder = '00. 收集箱/DSH 附件';
    const failed: string[] = [];
    let imported = 0;
    try {
      await this.ensureVaultFolder(folder);
    } catch {
      return { imported: 0, failed: files.map((file) => file.name) };
    }
    for (const file of files) {
      try {
        if (file.size > 100 * 1024 * 1024) throw new Error('file too large');
        const safeName = this.safeAttachmentName(file.name);
        const target = this.uniqueVaultPath(folder, safeName);
        await this.app.vault.createBinary(target, await file.arrayBuffer());
        const kind = attachmentKind(safeName, file.type);
        const attachment: NoteAttachment = {
          name: safeName,
          uri: target,
          kind,
          mimeType: file.type || undefined,
          size: file.size,
          extraction: kind === 'pdf' ? 'mineru-fallback'
            : kind === 'image' ? 'vision-fallback'
              : 'resource-link',
        };
        if ((kind === 'text' || kind === 'note') && file.size <= 2 * 1024 * 1024) {
          const text = await file.text();
          attachment.extractedText = text.slice(0, 120_000);
          attachment.extraction = text.length > 120_000 ? 'text-truncated' : 'text-extracted';
        }
        conversation.attachments ??= [];
        conversation.attachments.push(attachment);
        imported += 1;
      } catch (error) {
        console.error('dsh-agent: failed to import attachment', file.name, error);
        failed.push(file.name);
      }
    }
    if (imported > 0) {
      this.emitChange();
      this.scheduleSave();
    }
    return { imported, failed };
  }

  updateAttachmentRange(
    conversation: Conversation,
    uri: string,
    range: NoteAttachment['range'] | undefined,
  ): void {
    const attachment = (conversation.attachments ?? []).find((entry) => entry.uri === uri);
    if (attachment === undefined) return;
    attachment.range = range;
    this.emitChange();
    this.scheduleSave();
  }

  private async ensureVaultFolder(path: string): Promise<void> {
    let current = '';
    for (const part of path.split('/').filter((value) => value !== '')) {
      current = current === '' ? part : current + '/' + part;
      if (this.app.vault.getAbstractFileByPath(current) === null) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private safeAttachmentName(name: string): string {
    const base = nodeBasename(name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
    return base === '' ? '附件-' + Date.now() : base;
  }

  private uniqueVaultPath(folder: string, name: string): string {
    let candidate = folder + '/' + name;
    if (this.app.vault.getAbstractFileByPath(candidate) === null) return candidate;
    const extension = extname(name);
    const stem = extension === '' ? name : nodeBasename(name, extension);
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(candidate) !== null) {
      candidate = folder + '/' + stem + '-' + index + extension;
      index += 1;
    }
    return candidate;
  }

  addQuote(conversation: Conversation, quote: QuoteAttachment): void {
    conversation.quotes ??= [];
    conversation.quotes.push(quote);
    this.emitChange();
    this.scheduleSave();
  }

  updateQuote(conversation: Conversation, index: number, note: string): void {
    const quotes = conversation.quotes ?? [];
    const quote = quotes[index];
    if (quote === undefined) return;
    quote.note = note;
    this.emitChange();
    this.scheduleSave();
  }

  removeQuote(conversation: Conversation, index: number): void {
    conversation.quotes = (conversation.quotes ?? []).filter((_, i) => i !== index);
    this.emitChange();
    this.scheduleSave();
  }

  setWorkspace(conversation: Conversation, folderPath: string): void {
    // ACP session/new requires an absolute cwd; the picker hands us a
    // vault-relative folder path (or the absolute vault root).
    const absolute = isAbsolute(folderPath)
      ? folderPath
      : join(getVaultPath(this.app), folderPath.replace(/^\/+/, ''));
    if (conversation.workspace === absolute) return;
    conversation.workspace = absolute;
    this.prepareContextTransfer(conversation, messagesBeforePending(conversation));
    conversation.lastUsage = undefined;
    // A new workspace means a fresh ACP session (cwd is session-scoped).
    if (conversation.acpSessionId !== undefined) {
      if (conversation.status === 'streaming') this.stopActiveTurn();
      conversation.acpSessionId = undefined;
      conversation.status = 'disconnected';
      this.stopTailer(conversation.id);
    }
    this.emitChange();
    this.scheduleSave();
  }

  getNoteFiles(): { path: string; basename: string }[] {
    const files: { path: string; basename: string }[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      files.push({ path: file.path, basename: file.basename });
    }
    for (const file of this.app.vault.getFiles().filter((f) => f.extension === 'canvas')) {
      files.push({ path: file.path, basename: file.basename });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  getSkillStatus(): { vaultSkills: string[]; homeSkills: string[]; homeDir: string | undefined } {
    const list = (dir: string): string[] => {
      try {
        return readdirSync(dir).filter((name) => !name.startsWith('.') && !name.endsWith('.md')).sort();
      } catch {
        return [];
      }
    };
    const vaultDir = join(getVaultPath(this.app), '.dsh', 'skills');
    const homeDir = this.installer.resolveAgentsSkillsDir();
    return {
      vaultSkills: list(vaultDir),
      homeSkills: homeDir !== undefined ? list(homeDir) : [],
      homeDir,
    };
  }

  /** Merged skill list (vault skills + machine-wide ~/.agents/skills) for the slash menu. */
  getSkillEntries(): SkillEntry[] {
    const entries: SkillEntry[] = [];
    const seen = new Set<string>();
    const push = (list: SkillEntry[]): void => {
      for (const entry of list) {
        if (seen.has(entry.name)) continue;
        seen.add(entry.name);
        entries.push(entry);
      }
    };
    push(scanSkillsDir(join(getVaultPath(this.app), '.dsh', 'skills')));
    const homeDir = this.installer.resolveAgentsSkillsDir();
    if (homeDir !== undefined) push(scanSkillsDir(homeDir));
    return entries;
  }

  getWorkspaceOptions(): { path: string; label: string }[] {
    const vaultPath = getVaultPath(this.app);
    const options: { path: string; label: string }[] = [{ path: vaultPath, label: '库根目录' }];
    const folders = this.app.vault.getAllFolders().map((f) => f.path).filter((p) => p !== '/');
    for (const folder of folders.sort()) {
      options.push({ path: join(vaultPath, folder), label: folder });
    }
    return options;
  }

  /** Codex-style branch: clone through the chosen message into a fresh ACP context. */
  branchConversation(conversation: Conversation, throughMessageId: string): Conversation {
    const branch = createConversationBranch(conversation, throughMessageId);
    this.prepareContextTransfer(branch, branch.messages);
    this.data.conversations.push(branch);
    this.data.activeConversationId = branch.id;
    this.emitChange();
    this.scheduleSave();
    return branch;
  }

  getSynapsePositions(): Record<string, SynapsePosition> {
    return this.data.synapsePositions ?? {};
  }

  setSynapsePosition(id: string, position: SynapsePosition): void {
    const normalized = normalizeSynapsePosition(position);
    if (normalized === undefined) return;
    this.data.synapsePositions ??= {};
    this.data.synapsePositions[id] = normalized;
    this.scheduleSave();
  }

  clearSynapsePositions(ids: string[]): void {
    if (this.data.synapsePositions === undefined) return;
    for (const id of ids) delete this.data.synapsePositions[id];
    this.emitChange();
  }

  openChatView(): Promise<void> {
    return this.activateView();
  }

  openSynapseView(): Promise<void> {
    return this.activateSynapseView();
  }

  clearSelection(kind: 'note' | 'web-context' | 'web-selection'): void {
    const conversation = this.getActiveConversation();
    if (conversation === null) return;
    if (kind === 'note') {
      if (conversation.selection === undefined) return;
      conversation.selection = undefined;
    } else if (kind === 'web-context') {
      if (conversation.webContext === undefined) return;
      conversation.webContext = undefined;
    } else {
      if (conversation.webSelection === undefined) return;
      conversation.webSelection = undefined;
    }
    this.emitChange();
    this.scheduleSave();
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (setting !== undefined) {
      setting.open();
      setting.openTabById('dsh-agent');
    }
  }

  attachCurrentNote(conversation: Conversation): boolean {
    const file = this.app.workspace.getActiveFile();
    if (file === null) {
      new Notice('DSH Agent: 没有打开的笔记可附加');
      return false;
    }
    conversation.attachments ??= [];
    if (conversation.attachments.some((a) => a.uri === file.path)) return true;
    conversation.attachments.push({
      name: file.basename,
      uri: file.path,
      kind: 'note',
      mimeType: 'text/markdown',
      extraction: 'resource-link',
    });
    this.emitChange();
    this.scheduleSave();
    return true;
  }

  removeAttachment(conversation: Conversation, uri: string): void {
    conversation.attachments = (conversation.attachments ?? []).filter((a) => a.uri !== uri);
    this.emitChange();
    this.scheduleSave();
  }

  openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf('tab').openFile(file);
    } else {
      new Notice('DSH Agent: 找不到文件 ' + path);
    }
  }

  private lookupToolActivity(sessionId: string, callId: string): NonNullable<ChatMessage['toolActivities']>[number] | undefined {
    const conversation = this.data.conversations.find((c) => c.acpSessionId === sessionId);
    if (conversation === undefined) return undefined;
    for (let i = conversation.messages.length - 1; i >= 0; i--) {
      const activity = conversation.messages[i].toolActivities?.find((entry) => entry.callId === callId);
      if (activity !== undefined) return activity;
    }
    return undefined;
  }

  /** The assistant message currently receiving streamed/tool events, if any. */
  private activeAssistantMessage(conversation: Conversation): ChatMessage | undefined {
    return this.activeAssistantMessages.get(conversation.id);
  }

  /**
   * Commit the wire text not yet represented in the timeline as a text block.
   * Called right before tool/thinking events land, so the timeline interleaves
   * text and tools in event order (text → its tools → next text).
   */
  private flushPendingText(message: ChatMessage): boolean {
    const wire = mergeMirroredStreamText(message.text, message.streamedText);
    return appendCumulativeStreamText(message, wire);
  }

  /**
   * One tailer per conversation (never restarted per turn): its file offset
   * keeps monotonic progress, so historical events are never re-dispatched.
   */
  private ensureTailer(conversation: Conversation): SessionTailer | undefined {
    const sessionId = conversation.acpSessionId;
    if (sessionId === undefined) return undefined;
    const existing = this.tailers.get(conversation.id);
    if (existing !== undefined) return existing;
    const path = sessionLogPath(this.persistenceRoot, conversation.workspace, sessionId);
    conversation.sessionLogPaths ??= [];
    if (!conversation.sessionLogPaths.includes(path)) conversation.sessionLogPaths.push(path);
    const tailer = new SessionTailer(path, {
      onActivity: () => this.turnActivityGuards.get(conversation.id)?.touch(),
      onToolCall: (callId, name, argumentsJson) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        const storedArguments = this.settings.redactSensitiveLogs
          ? redactSensitiveText(argumentsJson)
          : argumentsJson;
        const activity = {
          callId, name, argumentsJson: storedArguments,
          status: 'running' as const, resultText: '', startTime: Date.now(),
        };
        this.flushPendingText(message);
        message.toolActivities ??= [];
        message.toolActivities.push(activity);
        message.blocks ??= [];
        message.blocks.push({ kind: 'tool', activity });
        if (isSubagentToolName(name)) {
          this.registerSubagentCall(conversation, message, callId, argumentsJson, name);
        }
        this.emitChange();
      },
      onToolResult: (callId, resultText, errorName, errorCode, meta) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        const activity = message.toolActivities?.find((a) => a.callId === callId);
        if (activity !== undefined) {
          activity.status = errorName !== undefined || errorCode !== undefined ? 'error' : 'done';
          activity.resultText = this.settings.redactSensitiveLogs
            ? redactSensitiveText(resultText)
            : resultText;
          activity.errorName = errorName;
          activity.errorCode = errorCode;
          activity.meta = this.settings.redactSensitiveLogs ? redactUnknown(meta) : meta;
          activity.endTime = Date.now();
          if (isSubagentToolName(activity.name)) {
            this.applySubagentResult(
              conversation,
              message,
              callId,
              activity.resultText,
              activity.status === 'error',
            );
          } else if (activity.name === 'workflow') {
            const runs = [...(message.workflowRuns ?? [])].reverse();
            const run = runs.find((entry) => entry.toolCallId === callId)
              ?? runs.find((entry) => entry.kind === 'workflow' && entry.report === undefined);
            if (run !== undefined) run.report = activity.resultText;
          }
          this.emitChange();
        }
      },
      onTodoWrite: (todos: TodoItem[]) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        this.flushPendingText(message);
        message.todos = todos;
        const blocks = message.blocks ?? [];
        const last = blocks[blocks.length - 1];
        if (last !== undefined && last.kind === 'todo') last.todos = todos;
        else blocks.push({ kind: 'todo', todos });
        message.blocks = blocks;
        this.emitChange();
      },
      onTitle: (title) => {
        const normalized = normalizeConversationTitle(title);
        if (normalized !== ''
          && conversation.titleManuallySet !== true
          && !isSyntheticContextTitle(normalized)) {
          conversation.title = normalized;
          conversation.titleFromServer = true;
          this.emitChange();
          this.scheduleSave();
        }
      },
      onReasoningDelta: (text, turn, step) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined || text === '') return;
        const key = turn !== undefined || step !== undefined
          ? String(turn ?? 0) + ':' + String(step ?? 0)
          : message.liveReasoningKey ?? 'live';
        if (message.liveReasoningKey !== key) {
          message.liveReasoningKey = key;
          message.liveReasoning = '';
        }
        const next = (message.liveReasoning ?? '') + text;
        message.liveReasoning = next.length > 100_000 ? next.slice(-100_000) : next;
        this.emitChange();
      },
      onTextDelta: (text) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined || text === '') return;
        message.streamedText = (message.streamedText ?? '') + text;
        this.emitChange();
      },
      onUsage: (usage) => {
        conversation.lastUsage = mergeUsageSnapshot(conversation.lastUsage, usage);
        const windowTokens = this.getModelContextWindow();
        const used = conversation.lastUsage.inputTokens + conversation.lastUsage.cacheReadTokens;
        const percent = windowTokens > 0 ? (used / windowTokens) * 100 : 0;
        if (percent >= 70 && conversation.contextMaintenance?.kind !== 'auto-compaction') {
          conversation.contextMaintenance = {
            kind: 'warning',
            percent,
            time: Date.now(),
            preview: percent >= 90 ? '上下文即将达到上限，建议立即压缩。' : '上下文占用较高，建议在复杂任务前压缩。',
          };
        }
        this.emitChange();
      },
      onStepMessage: (turn, step, reasoning, text) => {
        void text;
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        // Thinking blocks land on the timeline (thinking → text order), while
        // the streamed text stays with the typewriter. Only tool events
        // finalize text so it interleaves before the tool that followed it.
        const builder = BlockBuilder.from(message);
        // Text blocks are suppressed while streaming: the typewriter in the
        // view owns the text (driven by the ACP wire). settleTailer's
        // reconcileWireText adds the committed text as a block afterwards.
        builder.applyStepMessage(reasoning, undefined, { turn, step });
        message.blocks = builder.list();
        this.guardIdleGoalLoop(conversation, message, text);
        this.emitChange();
      },
      onGoalChange: (change) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        const c = change as { operation?: string; goal?: { objective?: string; phase?: string; maxGoalRounds?: number }; roundsStarted?: number; blockedReason?: string };
        if (c.operation === undefined) return;
        const card: GoalCard = {
          operation: c.operation,
          objective: c.goal?.objective,
          phase: c.goal?.phase,
          maxGoalRounds: c.goal?.maxGoalRounds,
          roundsStarted: c.roundsStarted,
          blockedReason: c.blockedReason,
          time: Date.now(),
        };
        this.flushPendingText(message);
        message.goalCards ??= [];
        message.goalCards.push(card);
        message.blocks ??= [];
        message.blocks.push({ kind: 'goal', card });
        this.emitChange();
      },
      onWorkflowRunStart: (run) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        const workflowActivity = [...(message.toolActivities ?? [])].reverse().find(
          (activity) => activity.name === 'workflow' && activity.status === 'running',
        );
        const workflowRun: WorkflowRun = {
          runId: run.runId,
          name: run.name,
          kind: 'workflow',
          rootSessionId: conversation.acpSessionId,
          toolCallId: workflowActivity?.callId,
          startedAt: run.startedAt ?? Date.now(),
          agents: [],
        };
        this.flushPendingText(message);
        message.workflowRuns ??= [];
        message.workflowRuns.push(workflowRun);
        message.blocks ??= [];
        message.blocks.push({ kind: 'workflow', run: workflowRun });
        this.emitChange();
      },
      onWorkflowAgentStart: (agent) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        const runs = message.workflowRuns ?? [];
        let run = runs.find((r) => r.runId === agent.runId);
        if (run === undefined) {
          run = {
            runId: agent.runId,
            name: 'workflow',
            kind: 'workflow',
            rootSessionId: conversation.acpSessionId,
            startedAt: agent.startedAt ?? Date.now(),
            agents: [],
          };
          runs.push(run);
          message.workflowRuns = runs;
          message.blocks ??= [];
          message.blocks.push({ kind: 'workflow', run });
        }
        const entry: WorkflowAgent = {
          seq: agent.seq,
          label: agent.label,
          phase: agent.phase,
          childId: agent.childId,
          parentId: conversation.acpSessionId,
          depth: 1,
          startedAt: agent.startedAt ?? Date.now(),
        };
        run.agents.push(entry);
        this.watchChildAgent(conversation, message, run, entry);
        this.emitChange();
      },
      onWorkflowAgentEnd: (agent) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        const run = (message.workflowRuns ?? []).find((r) => r.runId === agent.runId);
        if (run !== undefined) {
          const entry = run.agents.find((a) => a.seq === agent.seq);
          if (entry !== undefined) {
            entry.outcome = agent.outcome;
            entry.endedAt = agent.endedAt ?? Date.now();
          }
          this.emitChange();
        }
      },
      onWorkflowRunEnd: (run) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        const entry = (message.workflowRuns ?? []).find((r) => r.runId === run.runId);
        if (entry !== undefined) {
          entry.stopReason = run.stopReason;
          entry.endedAt = run.endedAt ?? Date.now();
          new Notice('Workflow「' + entry.name + '」' + (run.stopReason === 'completed' ? '已完成' : '已结束：' + (run.stopReason ?? '未知')));
          this.emitChange();
        }
      },
      onSubagentMessage: (event) => {
        const message = this.activeAssistantMessage(conversation);
        if (message === undefined) return;
        this.applySubagentMessage(message, event);
      },
    });
    tailer.start();
    this.tailers.set(conversation.id, tailer);
    return tailer;
  }

  /** Cancel and let DSH pause an armed Goal when it starts waiting for future input. */
  private guardIdleGoalLoop(
    conversation: Conversation,
    message: ChatMessage,
    text: string | undefined,
  ): void {
    if (text === undefined || !isGoalWaitingForUserText(text)) return;
    const latestGoal = [...(message.goalCards ?? [])].reverse().find((card) => card.phase !== undefined);
    if (latestGoal?.phase !== 'active' || this.goalIdleGuardedMessages.has(message.id)) return;
    const connection = this.backend.currentConnection;
    if (connection === null || conversation.acpSessionId === undefined || conversation.status !== 'streaming') return;
    this.goalIdleGuardedMessages.add(message.id);
    message.goalLoopGuardTriggered = true;
    connection.cancel(conversation.acpSessionId);
    new Notice('DSH Agent：检测到 Goal 正在等待未来输入并空转，已自动暂停');
  }

  private ensureSubagentConsole(conversation: Conversation, message: ChatMessage): WorkflowRun {
    const existing = (message.workflowRuns ?? []).find((run) => run.kind === 'subagent');
    if (existing !== undefined) return existing;
    const run: WorkflowRun = {
      runId: 'subagent-console:' + message.id,
      name: '子代理控制台',
      kind: 'subagent',
      rootSessionId: conversation.acpSessionId,
      startedAt: Date.now(),
      agents: [],
    };
    message.workflowRuns ??= [];
    message.workflowRuns.push(run);
    message.blocks ??= [];
    message.blocks.push({ kind: 'workflow', run });
    return run;
  }

  private subagentArguments(argumentsJson: string): { label: string; prompt?: string } {
    try {
      const args = JSON.parse(argumentsJson) as Record<string, unknown>;
      const prompt = typeof args.prompt === 'string' ? args.prompt : undefined;
      const description = typeof args.description === 'string' ? args.description : undefined;
      return {
        label: description?.trim() || prompt?.trim().slice(0, 100) || '子代理任务',
        ...(prompt !== undefined ? { prompt } : {}),
      };
    } catch {
      return { label: argumentsJson.trim().slice(0, 100) || '子代理任务' };
    }
  }

  private registerSubagentCall(
    conversation: Conversation,
    message: ChatMessage,
    callId: string,
    argumentsJson: string,
    toolName: string,
    run = this.ensureSubagentConsole(conversation, message),
    parentId = conversation.acpSessionId,
    depth = 1,
  ): WorkflowAgent {
    const existing = run.agents.find((agent) => agent.callId === callId);
    if (existing !== undefined) return existing;
    markSubagentRunActive(run);
    const spec = this.subagentArguments(argumentsJson);
    const agent: WorkflowAgent = {
      seq: run.agents.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1,
      label: spec.label,
      phase: subagentToolLabel(toolName),
      prompt: spec.prompt,
      callId,
      parentId,
      depth,
      startedAt: Date.now(),
    };
    run.agents.push(agent);
    return agent;
  }

  private applySubagentResult(
    conversation: Conversation,
    message: ChatMessage,
    callId: string,
    resultText: string,
    isError: boolean,
    preferredRun?: WorkflowRun,
  ): void {
    const runs = preferredRun !== undefined ? [preferredRun] : (message.workflowRuns ?? []);
    const run = runs.find((entry) => entry.agents.some((agent) => agent.callId === callId));
    const agent = run?.agents.find((entry) => entry.callId === callId);
    if (run === undefined || agent === undefined) return;
    const continuable = /started subagent\s+([A-Za-z0-9._~-]+)/i.exec(resultText);
    const background = /started background subagent job\s+([A-Za-z0-9._~-]+)/i.exec(resultText);
    if (continuable !== null) {
      agent.childId = continuable[1];
      this.watchChildAgent(conversation, message, run, agent);
      return;
    }
    if (background !== null) {
      agent.jobId = background[1];
      return;
    }
    agent.outcome = isError ? 'error' : 'completed';
    agent.endedAt = Date.now();
    agent.report = resultText;
    settleSubagentRun(run);
  }

  private applySubagentMessage(
    message: ChatMessage,
    event: { childId: string; kind: 'report' | 'settled'; text: string; stopReason?: string },
  ): void {
    for (const run of message.workflowRuns ?? []) {
      const agent = run.agents.find((entry) => entry.childId === event.childId);
      if (agent === undefined) continue;
      if (event.kind === 'report') {
        agent.report = agent.report === undefined || agent.report === ''
          ? event.text
          : agent.report + '\n\n' + event.text;
      } else {
        agent.outcome = event.stopReason ?? 'completed';
        agent.endedAt = Date.now();
        agent.report = event.text;
        settleSubagentRun(run);
        new Notice('子代理「' + agent.label + '」' + (agent.outcome === 'completed' ? '已完成' : '已结束：' + agent.outcome));
      }
      this.emitChange();
      this.scheduleSave();
      return;
    }
  }

  private watchChildAgent(
    conversation: Conversation,
    message: ChatMessage,
    run: WorkflowRun,
    agent: WorkflowAgent,
  ): void {
    const childId = agent.childId;
    if (childId === undefined || childId === '' || this.childTailers.has(childId)) return;
    const childPath = sessionLogPath(this.persistenceRoot, conversation.workspace, childId);
    const childTailer = new SessionTailer(childPath, {
      onToolCall: (callId, name, argumentsJson) => {
        if (!isSubagentToolName(name)) return;
        this.registerSubagentCall(
          conversation,
          message,
          callId,
          argumentsJson,
          name,
          run,
          childId,
          (agent.depth ?? 1) + 1,
        );
        this.emitChange();
      },
      onToolResult: (callId, resultText, errorName, errorCode) => {
        this.applySubagentResult(
          conversation,
          message,
          callId,
          resultText,
          errorName !== undefined || errorCode !== undefined,
          run,
        );
        this.emitChange();
      },
      onTodoWrite: () => { /* child todo stays in its own session */ },
      onTitle: (title) => {
        if (agent.label === '' && title.trim() !== '') agent.label = title.trim();
      },
      onReasoningDelta: () => { /* detailed child reasoning stays out of parent context */ },
      onTextDelta: (text) => {
        agent.lastOutput = ((agent.lastOutput ?? '') + text).slice(-20_000);
      },
      onUsage: (usage) => {
        agent.inputTokens = usage.inputTokens ?? agent.inputTokens ?? 0;
        agent.outputTokens = usage.outputTokens ?? agent.outputTokens ?? 0;
        agent.cacheReadTokens = usage.cacheReadTokens ?? agent.cacheReadTokens ?? 0;
        this.emitChange();
      },
      onStepMessage: (_turn, _step, _reasoning, text) => {
        if (text !== undefined && text.trim() !== '') agent.lastOutput = text.slice(-20_000);
      },
      onGoalChange: () => { /* child goal remains in child log */ },
      onWorkflowRunStart: () => { /* child workflow agents are added below */ },
      onWorkflowAgentStart: (nested) => {
        const nestedAgent: WorkflowAgent = {
          seq: run.agents.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1,
          label: nested.label,
          phase: nested.phase,
          childId: nested.childId,
          parentId: childId,
          depth: (agent.depth ?? 1) + 1,
          callId: 'workflow:' + nested.runId + ':' + nested.seq,
          startedAt: nested.startedAt ?? Date.now(),
        };
        run.agents.push(nestedAgent);
        this.watchChildAgent(conversation, message, run, nestedAgent);
        this.emitChange();
      },
      onWorkflowAgentEnd: (nested) => {
        const entry = run.agents.find((candidate) => candidate.callId === 'workflow:' + nested.runId + ':' + nested.seq);
        if (entry !== undefined) {
          entry.outcome = nested.outcome;
          entry.endedAt = nested.endedAt ?? Date.now();
          settleSubagentRun(run);
          this.emitChange();
        }
      },
      onWorkflowRunEnd: () => { /* represented by the nested agent rows */ },
      onSubagentMessage: (event) => this.applySubagentMessage(message, event),
      onTurnEnd: (reason, time) => {
        if (agent.outcome === undefined) agent.outcome = reason === 'completed' ? 'idle' : reason;
        agent.endedAt = time ?? Date.now();
        settleSubagentRun(run, agent.endedAt);
        this.emitChange();
      },
    });
    childTailer.start();
    this.childTailers.set(childId, childTailer);
  }

  private pauseTailer(conversationId: string): void {
    this.tailers.get(conversationId)?.pause();
  }

  private stopTailer(conversationId: string): void {
    const tailer = this.tailers.get(conversationId);
    if (tailer !== undefined) {
      tailer.stop();
      this.tailers.delete(conversationId);
    }
  }

  private getActiveWebViewer(): WebViewerElement | null {
    const container = this.app.workspace.activeLeaf?.view.containerEl;
    const webview = container?.querySelector('webview') as WebViewerElement | null | undefined;
    return webview !== undefined && webview !== null && typeof webview.executeJavaScript === 'function'
      ? webview
      : null;
  }

  private handleSelection(snapshot: { text: string; lineStart: number; lineEnd: number } | null): void {
    const conversation = this.getActiveConversation();
    if (conversation === null) return;
    if (snapshot === null) {
      if (conversation.selection !== undefined && conversation.selection.sourceKind !== 'web') {
        conversation.selection = undefined;
        this.emitChange();
        this.scheduleSave();
      }
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    const basename = activeFile?.basename ?? '笔记';
    conversation.selection = {
      text: snapshot.text,
      basename,
      ...(activeFile !== null ? { path: activeFile.path } : {}),
      lineStart: snapshot.lineStart,
      lineEnd: snapshot.lineEnd,
      sourceKind: 'note',
    };
    this.emitChange();
    this.scheduleSave();
  }

  private handleWebSelection(snapshot: WebViewerSelectionSnapshot | null): void {
    const conversation = this.getActiveConversation();
    if (conversation === null) return;
    if (snapshot === null) {
      if (conversation.webContext !== undefined || conversation.webSelection !== undefined) {
        conversation.webContext = undefined;
        conversation.webSelection = undefined;
        this.emitChange();
        this.scheduleSave();
      }
      return;
    }
    if (snapshot.mode === 'page') {
      conversation.webContext = {
        text: snapshot.text,
        basename: snapshot.title,
        lineStart: snapshot.lineStart,
        lineEnd: snapshot.lineEnd,
        sourceKind: 'web',
        sourceUrl: snapshot.url,
        webMode: 'page',
        ...(snapshot.truncated === true ? { truncated: true } : {}),
      };
      conversation.webSelection = undefined;
    } else {
      conversation.webSelection = {
        text: snapshot.text,
        basename: snapshot.title,
        lineStart: snapshot.lineStart,
        lineEnd: snapshot.lineEnd,
        sourceKind: 'web',
        sourceUrl: snapshot.url,
        webMode: 'selection',
        ...(snapshot.truncated === true ? { truncated: true } : {}),
      };
      const pageText = snapshot.contextText?.trim() ?? '';
      if (pageText !== '') {
        conversation.webContext = {
          text: pageText,
          basename: snapshot.title,
          lineStart: 1,
          lineEnd: Math.max(1, pageText.split('\n').length),
          sourceKind: 'web',
          sourceUrl: snapshot.url,
          webMode: 'page',
          ...(snapshot.contextTruncated === true ? { truncated: true } : {}),
        };
      } else if (conversation.webContext?.sourceUrl !== snapshot.url) {
        conversation.webContext = undefined;
      }
    }
    this.emitChange();
    this.scheduleSave();
  }

  private reasoningOverride(): { provider: string; effort: DshAgentSettings['reasoningEffort'] } | undefined {
    return { provider: this.settings.provider, effort: this.settings.reasoningEffort };
  }

  /** Apply the current provider/model/effort settings to the runtime. */
  private async applyRuntimeConfig(_changed: 'provider' | 'model' | 'effort', forceRestart = false): Promise<{ restart: boolean }> {
    if (forceRestart) {
      this.installer.writeRuntimeFiles(this.settings, this.persistenceRoot, this.reasoningOverride());
      await this.backend.stop();
      void this.ensureStarted();
      return { restart: true };
    }
    const revision = this.installer.writeRuntimeModelSettings(this.settings, this.reasoningOverride());
    if (this.backend.currentConnection !== null) {
      const applied = await this.backend.waitForRuntimeRevision(revision);
      if (!applied) new Notice('DSH Agent: 模型配置已保存，但运行时确认超时；下一条消息前请稍候片刻');
    }
    this.emitChange();
    return { restart: false };
  }

  async selectProvider(provider: string): Promise<{ restart: boolean }> {
    if (provider === this.settings.provider) return { restart: false };
    this.settings.provider = provider;
    const catalog = this.modelCatalog[provider];
    if (catalog !== undefined && catalog.models.length > 0
      && !catalog.models.some((model) => model.id === this.settings.model)) {
      const visible = catalog.models.find((model) => !this.settings.hiddenModels.includes(provider + '::' + model.id));
      this.settings.model = (visible ?? catalog.models[0]).id;
    }
    this.settings.reasoningEffort = preferredEffort(
      modelEffortsOf(this.modelCatalog, this.settings.provider, this.settings.model),
      this.settings.reasoningEffort,
    );
    await this.saveSettings();
    return this.applyRuntimeConfig('provider');
  }

  async selectModel(model: string): Promise<{ restart: boolean }> {
    if (model === this.settings.model) return { restart: false };
    this.settings.model = model;
    this.settings.reasoningEffort = preferredEffort(
      modelEffortsOf(this.modelCatalog, this.settings.provider, model),
      this.settings.reasoningEffort,
    );
    await this.saveSettings();
    return this.applyRuntimeConfig('model');
  }

  async selectEffort(effort: DshAgentSettings['reasoningEffort']): Promise<{ restart: boolean }> {
    if (effort === this.settings.reasoningEffort) return { restart: false };
    const supported = modelEffortsOf(this.modelCatalog, this.settings.provider, this.settings.model);
    if (!supported.includes(effort)) return { restart: false };
    this.settings.reasoningEffort = effort;
    await this.saveSettings();
    // pi-ai effort is hot-published, so no backend state transition would
    // otherwise trigger a view refresh for the composer chip.
    this.emitChange();
    return this.applyRuntimeConfig('effort');
  }

  async selectPermissionMode(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<{ restart: boolean }> {
    if (mode === this.settings.permissionMode) return { restart: false };
    this.settings.permissionMode = mode;
    this.settings.agentPreset = 'manual';
    await this.saveSettings();
    // DSH_PERMISSION_MODE is read at backend launch — a restart is required.
    this.installer.writeRuntimeFiles(this.settings, this.persistenceRoot, this.reasoningOverride());
    await this.backend.stop();
    void this.ensureStarted();
    return { restart: true };
  }

  async selectAgentPreset(id: string): Promise<{ restart: boolean }> {
    if (id === 'manual') {
      if (this.settings.agentPreset === 'manual') return { restart: false };
      this.settings.agentPreset = 'manual';
      await this.saveSettings();
      this.installer.writeRuntimeFiles(this.settings, this.persistenceRoot, this.reasoningOverride());
      await this.backend.stop();
      void this.ensureStarted();
      this.emitChange();
      return { restart: true };
    }
    const preset = AGENT_PRESETS.find((entry) => entry.id === id);
    if (preset === undefined) return { restart: false };
    applyAgentPreset(this.settings, preset.id);
    await this.saveSettings();
    this.installer.writeRuntimeFiles(this.settings, this.persistenceRoot, this.reasoningOverride());
    await this.backend.stop();
    void this.ensureStarted();
    this.emitChange();
    return { restart: true };
  }

  getModelCatalog(): {
    providers: { id: string; name: string; hidden: boolean }[];
    models: { id: string; name: string; providerId: string; providerName: string; reasoningEfforts: DshAgentSettings['reasoningEffort'][] }[];
  } {
    const hiddenSet = new Set(this.settings.hiddenProviders);
    const providers = Object.keys(this.modelCatalog).map((id) => ({
      id,
      name: this.modelCatalog[id].name,
      hidden: hiddenSet.has(id),
    }));
    return {
      providers,
      models: visibleModelEntries(this.settings.hiddenProviders, this.settings.hiddenModels, this.modelCatalog),
    };
  }

  /** Toggle whether a single model appears in the chat composer list. */
  setModelVisibility(providerId: string, modelId: string, visible: boolean): void {
    const key = providerId + '::' + modelId;
    const rest = this.settings.hiddenModels.filter((entry) => entry !== key);
    if (!visible) rest.push(key);
    this.settings.hiddenModels = rest.sort();
    void this.saveSettings();
    this.emitChange();
  }

  /** Toggle whether a provider's models appear in the chat composer list. */
  setProviderVisibility(providerId: string, visible: boolean): void {
    const hidden = new Set(this.settings.hiddenProviders);
    if (visible) hidden.delete(providerId);
    else hidden.add(providerId);
    this.settings.hiddenProviders = [...hidden].sort();
    void this.saveSettings();
    this.emitChange();
  }

  /** Switch provider + model in one step without restarting the ACP backend. */
  async selectModelCombo(provider: string, model: string): Promise<{ restart: boolean }> {
    const providerChanged = provider !== this.settings.provider;
    const modelChanged = model !== this.settings.model;
    if (!providerChanged && !modelChanged) return { restart: false };
    this.settings.provider = provider;
    this.settings.model = model;
    this.settings.reasoningEffort = preferredEffort(
      modelEffortsOf(this.modelCatalog, provider, model),
      this.settings.reasoningEffort,
    );
    await this.saveSettings();
    return this.applyRuntimeConfig('provider');
  }

  confirmRestart(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, message, (ok) => resolve(ok));
      modal.open();
    });
  }

  stopActiveTurn(): void {
    const conversation = this.getActiveConversation();
    const connection = this.backend.currentConnection;
    if (conversation === null || connection === null) return;
    if (conversation.status !== 'streaming' || conversation.acpSessionId === undefined) return;
    connection.cancel(conversation.acpSessionId);
  }

  requestAgentControl(childId: string, action: 'stop' | 'retry', label: string, prompt?: string): void {
    const conversation = this.getActiveConversation();
    if (conversation === null || (action === 'stop' && childId.trim() === '')) {
      new Notice('子代理尚未返回可控制的会话 ID');
      return;
    }
    const instruction = action === 'stop'
      ? '请立即使用 interrupt_agent 工具单独停止子代理 ' + childId + '（任务：' + label + '），不要停止其他子代理。执行后只简短确认结果。'
      : childId.trim() !== ''
        ? '请重试子代理 ' + childId + ' 的任务「' + label + '」。优先使用 send_message 向该可继续子代理发送新的重试轮次；如果它不可继续，再使用 subagent 新建等价任务。原始任务：' + (prompt ?? label)
        : '请使用 subagent 新建一个子代理并重试任务「' + label + '」。原始任务：' + (prompt ?? label);
    void this.sendOrQueue(conversation, instruction);
    new Notice(action === 'stop' ? '已提交单独停止请求' : '已提交子代理重试请求');
  }

  getBackendSnapshot(): BackendSnapshot {
    return this.backend.snapshot();
  }

  getInstallState(): InstallStatus {
    return this.installState;
  }

  onChange(listener: () => void): () => void {
    if (this.unloading) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitChange(): void {
    if (this.unloading) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // ignore
      }
    }
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.unloading) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    const hasActiveTurn = this.data.conversations.some(
      (conversation) => conversation.status === 'preparing' || conversation.status === 'streaming',
    );
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persistData();
    }, hasActiveTurn ? 5_000 : 800);
  }

  /** Serialize writes so a slow older save can never overwrite a newer snapshot. */
  private persistData(): Promise<void> {
    const snapshot = this.persistenceSnapshot();
    const write = async (): Promise<void> => {
      try {
        await this.saveData(snapshot);
      } catch (error) {
        console.error('dsh-agent: failed to persist plugin data', error);
        if (!this.unloading) new Notice('DSH Agent: 保存会话失败，请检查磁盘空间或文件权限');
      }
    };
    this.saveChain = this.saveChain.then(write, write);
    return this.saveChain;
  }

  // ---------- view ----------

  async activateView(): Promise<void> {
    if (this.unloading) return;
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_DSH_CHAT)[0] ?? null;
    if (leaf === null) {
      leaf = workspace.getRightLeaf(false);
      if (leaf === null) return;
      await leaf.setViewState({ type: VIEW_TYPE_DSH_CHAT, active: true });
    }
    if (this.unloading) return;
    await workspace.revealLeaf(leaf);
  }

  async activateSynapseView(): Promise<void> {
    if (this.unloading) return;
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_DSH_SYNAPSE)[0] ?? null;
    if (leaf === null) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE_DSH_SYNAPSE, active: true });
    }
    if (this.unloading) return;
    await workspace.revealLeaf(leaf);
  }
}

// ---------- settings tab ----------

class DshAgentSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: DshAgentPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const settings = this.plugin.settings;
    const modelCatalog = this.plugin.getRuntimeModelCatalog();

    containerEl.createEl('h2', { text: 'DeepSeek Harness Agent 设置' });

    this.statusSection(containerEl);

    new Setting(containerEl)
      .setName('Agent 预设')
      .setDesc('一次应用 persona、默认模型与 Effort、权限范围、可用工具和子代理/Workflow 调度策略。当前：' + agentPresetLabel(settings.agentPreset) + '。深度任务底层仍是 max，不伪造 Ultra 等级。')
      .addDropdown((dropdown) => {
        dropdown.addOption('manual', '自定义');
        for (const preset of AGENT_PRESETS) dropdown.addOption(preset.id, preset.name);
        dropdown.setValue(settings.agentPreset);
        dropdown.onChange(async (value) => {
          await this.plugin.selectAgentPreset(value);
          if (value !== 'manual') {
            new Notice('DSH Agent: 已应用「' + agentPresetLabel(value as DshAgentSettings['agentPreset']) + '」预设并重启后端');
          }
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('LLM 提供方路由。opencode-go 走托管网关，deepseek-official 走官方 API，local-qwen 连接本机 127.0.0.1:8081。')
      .addDropdown((dropdown) => {
        for (const providerId of Object.keys(modelCatalog)) {
          dropdown.addOption(providerId, modelCatalog[providerId].name);
        }
        dropdown.setValue(settings.provider);
        dropdown.onChange(async (value) => {
          await this.plugin.selectProvider(value);
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('模型')
      .setDesc('模型列表在每次启动时从当前 DSH/provider 目录刷新；新发现的模型默认不显示在聊天选择器。')
      .addDropdown((dropdown) => {
        const catalog = modelCatalog[settings.provider];
        if (catalog !== undefined) {
          for (const model of catalog.models) {
            dropdown.addOption(model.id, model.name);
          }
        }
        const known = catalog?.models.some((m) => m.id === settings.model) ?? false;
        if (!known) dropdown.addOption(settings.model, settings.model);
        dropdown.setValue(settings.model);
        dropdown.onChange(async (value) => {
          await this.plugin.selectModel(value);
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('功能列表')
      .setDesc('统一开关 DSH 智能体能力与插件界面功能;运行时类(工具)更改会重写 cordis 并重启后端,界面类即时生效。goal/skill 内置于智能体栈,不在此列表。');

    {
      const group = containerEl.createDiv({ cls: 'dsh-agent-settings-provider' });
      const search = group.createEl('input', {
        cls: 'dsh-agent-settings-search',
        attr: { type: 'search', placeholder: '搜索功能…' },
      });
      const list = group.createDiv({ cls: 'dsh-agent-settings-model-list' });
      const renderRows = (): void => {
        const q = search.value.trim().toLowerCase();
        const flags = this.plugin.getFeatureFlags();
        list.empty();
        let lastCategory = '';
        for (const feature of FEATURE_REGISTRY) {
          if (q !== '' && !feature.label.toLowerCase().includes(q) && !feature.id.toLowerCase().includes(q)) continue;
          if (feature.category !== lastCategory) {
            list.createDiv({ cls: 'dsh-agent-inline-group', text: feature.category });
            lastCategory = feature.category;
          }
          const row = list.createDiv({ cls: 'dsh-agent-settings-model-row' });
          const label = row.createDiv({ cls: 'dsh-agent-settings-model-label' });
          label.createSpan({ text: feature.label + (feature.kind === 'runtime' ? '' : '') });
          label.createSpan({ cls: 'dsh-agent-settings-model-id', text: feature.description });
          const toggle = new ToggleComponent(row);
          toggle.setValue(flags[feature.id] !== false);
          toggle.onChange(async (value) => {
            const stored = { ...(settings.featureFlags ?? {}) };
            stored[feature.id] = value;
            settings.featureFlags = stored;
            if (feature.kind === 'runtime') settings.agentPreset = 'manual';
            await this.plugin.saveSettings();
            if (feature.kind === 'runtime') {
              new Notice(value ? '已启用 ' + feature.label + ',重启后端中…' : '已禁用 ' + feature.label + ',重启后端中…');
              await this.plugin.applySettingsAndRestart();
              new Notice('DSH Agent: 功能配置已应用');
              this.display();
            } else {
              this.plugin.emitChange();
            }
          });
        }
      };
      search.addEventListener('input', () => renderRows());
      renderRows();
    }

    new Setting(containerEl)
      .setName('聊天框模型列表')
      .setDesc('逐个选择各模型商的模型是否出现在聊天框底部 Model 气泡的切换列表中（当前已选中的模型即使隐藏也保持生效）。');

    for (const providerId of Object.keys(modelCatalog)) {
      const catalog = modelCatalog[providerId];
      const group = containerEl.createDiv({ cls: 'dsh-agent-settings-provider' });
      const header = group.createDiv({ cls: 'dsh-agent-settings-provider-header' });
      header.createDiv({ cls: 'dsh-agent-settings-provider-name', text: catalog.name });
      header.createDiv({ cls: 'dsh-agent-settings-provider-count', text: String(catalog.models.length) + ' 个模型' });
      const showAll = header.createEl('button', { cls: 'dsh-agent-icon-btn' });
      setIcon(showAll, 'check-check');
      showAll.setAttr('aria-label', '全部显示');
      showAll.onclick = () => {
        settings.hiddenModels = settings.hiddenModels.filter((entry) => !entry.startsWith(providerId + '::'));
        void this.plugin.saveSettings();
        this.plugin.emitChange();
        this.display();
      };
      const hideAll = header.createEl('button', { cls: 'dsh-agent-icon-btn' });
      setIcon(hideAll, 'ban');
      hideAll.setAttr('aria-label', '全部隐藏');
      hideAll.onclick = () => {
        const rest = settings.hiddenModels.filter((entry) => !entry.startsWith(providerId + '::'));
        for (const model of catalog.models) rest.push(providerId + '::' + model.id);
        settings.hiddenModels = [...new Set(rest)].sort();
        void this.plugin.saveSettings();
        this.plugin.emitChange();
        this.display();
      };
      const search = group.createEl('input', {
        cls: 'dsh-agent-settings-search',
        attr: { type: 'search', placeholder: '搜索模型…' },
      });
      const list = group.createDiv({ cls: 'dsh-agent-settings-model-list' });
      const renderRows = (): void => {
        const q = search.value.trim().toLowerCase();
        list.empty();
        for (const model of catalog.models) {
          if (q !== '' && !model.name.toLowerCase().includes(q) && !model.id.toLowerCase().includes(q)) continue;
          const row = list.createDiv({ cls: 'dsh-agent-settings-model-row' });
          const label = row.createDiv({ cls: 'dsh-agent-settings-model-label' });
          label.createSpan({ text: model.name });
          label.createSpan({ cls: 'dsh-agent-settings-model-id', text: model.id });
          const toggle = new ToggleComponent(row);
          toggle.setValue(!settings.hiddenModels.includes(providerId + '::' + model.id));
          toggle.onChange(async (value) => {
            const key = providerId + '::' + model.id;
            const rest = settings.hiddenModels.filter((entry) => entry !== key);
            if (!value) rest.push(key);
            settings.hiddenModels = rest.sort();
            await this.plugin.saveSettings();
            this.plugin.emitChange();
          });
        }
      };
      search.addEventListener('input', () => renderRows());
      renderRows();
    }

    new Setting(containerEl)
      .setName('思考强度')
      .setDesc('选项来自当前模型的实际能力；default 使用模型或供应商默认值。切换后热更新，无需重启。')
      .addDropdown((dropdown) => {
        for (const effort of this.plugin.getReasoningEfforts()) {
          dropdown.addOption(effort, effort === 'default' ? 'default（模型默认）' : effort);
        }
        dropdown.setValue(settings.reasoningEffort);
        dropdown.onChange(async (value) => {
          await this.plugin.selectEffort(value as DshAgentSettings['reasoningEffort']);
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('权限模式')
      .setDesc('read-only: 真实禁止写入；workspace-write: 写入限制在笔记库内；danger-full-access: 全量放行（危险）。')
      .addDropdown((dropdown) => {
        dropdown.addOption('read-only', 'read-only');
        dropdown.addOption('workspace-write', 'workspace-write');
        dropdown.addOption('danger-full-access', 'danger-full-access');
        dropdown.setValue(settings.permissionMode);
        dropdown.onChange(async (value) => {
          settings.permissionMode = value as DshAgentSettings['permissionMode'];
          settings.agentPreset = 'manual';
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('审批策略')
      .setDesc('ask: 沙箱升权时弹窗询问；never: 自动拒绝升权重试。')
      .addDropdown((dropdown) => {
        dropdown.addOption('ask', 'ask');
        dropdown.addOption('never', 'never');
        dropdown.setValue(settings.approvalPolicy);
        dropdown.onChange(async (value) => {
          settings.approvalPolicy = value as DshAgentSettings['approvalPolicy'];
          settings.agentPreset = 'manual';
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('回复期间发送消息')
      .setDesc('插队:立即停止当前回复并发送新消息;排队:当前回复完成后再自动发送(可连续输入多条)。')
      .addDropdown((dropdown) => {
        dropdown.addOption('interrupt', '插队（interrupt）');
        dropdown.addOption('queue', '排队（queue）');
        dropdown.setValue(settings.queuePolicy);
        dropdown.onChange(async (value) => {
          settings.queuePolicy = value as DshAgentSettings['queuePolicy'];
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('上下文自动压缩阈值')
      .setDesc('达到阈值后，在下一轮请求前自动注入压缩要求；状态栏会显示压缩记录和新会话上下文转移明细。')
      .addDropdown((dropdown) => {
        dropdown.addOption('0', '关闭');
        dropdown.addOption('70', '70%');
        dropdown.addOption('80', '80%（推荐）');
        dropdown.addOption('90', '90%');
        dropdown.setValue(String(settings.autoCompactPercent));
        dropdown.onChange(async (value) => {
          settings.autoCompactPercent = Number(value);
          await this.plugin.saveSettings();
          this.plugin.emitChange();
        });
      });

    new Setting(containerEl)
      .setName('单轮无活动超时')
      .setDesc('只有连续一段时间没有推理、文本、工具或重试活动才会停止；持续有进展的深度任务不受总时长限制。')
      .addDropdown((dropdown) => {
        dropdown.addOption('0', '不限制');
        dropdown.addOption('10', '10 分钟');
        dropdown.addOption('30', '30 分钟（推荐）');
        dropdown.addOption('60', '60 分钟');
        dropdown.setValue(String(settings.maxTurnMinutes));
        dropdown.onChange(async (value) => {
          settings.maxTurnMinutes = Number(value);
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('原始会话日志保留期')
      .setDesc('只清理插件自己的 .sessions 原始 JSONL 日志；聊天记录仍保存在 data.json。已删除会话的日志会先进入插件内部回收区。')
      .addDropdown((dropdown) => {
        dropdown.addOption('0', '永久保留');
        dropdown.addOption('7', '7 天');
        dropdown.addOption('30', '30 天');
        dropdown.addOption('90', '90 天（推荐）');
        dropdown.addOption('180', '180 天');
        dropdown.setValue(String(settings.sessionLogRetentionDays));
        dropdown.onChange(async (value) => {
          settings.sessionLogRetentionDays = Number(value);
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('保存前脱敏工具日志')
      .setDesc('在 data.json 中遮蔽 token、API key、password、Authorization 和 Cookie 等常见敏感字段；原始后端 JSONL 由上方保留期控制。')
      .addToggle((toggle) => {
        toggle.setValue(settings.redactSensitiveLogs);
        toggle.onChange(async (value) => {
          settings.redactSensitiveLogs = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('DSH 主目录（$DSH_HOME）')
      .setDesc('留空使用环境变量 DSH_HOME，其次 ~/.dsh。凭据从该目录的 .credentials.yaml 解析。')
      .addText((text) => {
        text.setPlaceholder(resolveDshHome(settings));
        text.setValue(settings.dshHome);
        text.onChange(async (value) => {
          settings.dshHome = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Node 命令')
      .setDesc('用于启动 DSH 后端的 node 可执行命令（PATH 上为 node 即可）。')
      .addText((text) => {
        text.setValue(settings.nodeCommand);
        text.onChange(async (value) => {
          settings.nodeCommand = value.trim() === '' ? 'node' : value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('启动时自动运行后端')
      .addToggle((toggle) => {
        toggle.setValue(settings.autoStart);
        toggle.onChange(async (value) => {
          settings.autoStart = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('重新生成运行配置并重启后端')
      .setDesc('模型、供应商和思考强度会自动热更新；仅权限、工具、预设、Node 命令等启动配置需要重启。进行中的会话会断开（历史保留）。')
      .addButton((button) => {
        button.setButtonText('重新生成并重启').setCta();
        button.onClick(async () => {
          await this.plugin.saveSettings();
          await this.plugin.reinitRuntimePaths();
          await this.plugin.ensureStarted();
          new Notice('DSH Agent: 配置已应用');
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('从主配置重新导入')
      .setDesc('把用户 $DSH_HOME/settings.yaml 中的 llm-pi-ai / agent-default-model 分节重新复制到插件运行配置（只读主配置）。')
      .addButton((button) => {
        button.setButtonText('重新导入');
        button.onClick(() => {
          this.plugin.installer.seedSettings(this.plugin.settings);
          new Notice('DSH Agent: 已重新导入配置种子');
        });
      });
  }

  private statusSection(containerEl: HTMLElement): void {
    const install = this.plugin.getInstallState();
    const backend = this.plugin.getBackendSnapshot();

    const statusEl = containerEl.createDiv({ cls: 'dsh-agent-status-card' });
    statusEl.createEl('h3', { text: '运行时状态' });
    const installLine = statusEl.createDiv({});
    installLine.appendText('安装: ');
    const installText = install.kind === 'installed' ? '✅ 已安装'
      : install.kind === 'installing' ? '⏳ ' + install.detail
      : install.kind === 'error' ? '❌ ' + install.detail
      : '⚠️ 未安装（首次对话时自动安装）';
    installLine.createSpan({ text: installText });

    const skills = this.plugin.getSkillStatus();
    const skillsLine = statusEl.createDiv({});
    skillsLine.appendText('技能: ');
    skillsLine.createSpan({
      text: '库内 ' + skills.vaultSkills.length + ' 个 · 电脑 DSH ' + skills.homeSkills.length + ' 个' + (skills.homeDir !== undefined ? '（' + skills.homeDir + '，自动同步）' : '（未发现 ~/.agents/skills）'),
    });

    const backendLine = statusEl.createDiv({});
    backendLine.appendText('后端: ');
    backendLine.createSpan({
      text: backend.state === 'running' ? '✅ 运行中'
        : backend.state === 'starting' ? '⏳ 启动中'
        : backend.state === 'error' ? '❌ 异常'
        : '⏹ 已停止',
    });

    const storage = this.plugin.getStorageStats();
    const storageLine = statusEl.createDiv({});
    storageLine.appendText('存储: ');
    storageLine.createSpan({
      text: formatBytes(storage.totalBytes)
        + '（会话 ' + formatBytes(storage.dataBytes)
        + ' · 原始日志 ' + formatBytes(storage.sessionBytes)
        + ' · 备份 ' + formatBytes(storage.backupBytes) + '）',
    });

    if (backend.stderrTail.trim() !== '') {
      const details = statusEl.createEl('details');
      details.createEl('summary', { text: '后端诊断输出（stderr）' });
      details.createEl('pre', { cls: 'dsh-agent-log', text: backend.stderrTail });
    }

    const actions = statusEl.createDiv({ cls: 'dsh-agent-status-actions' });
    const startButton = actions.createEl('button', { text: '启动后端' });
    startButton.onclick = () => {
      void this.plugin.ensureStarted().then((ok) => {
        new Notice(ok ? 'DSH Agent: 后端已启动' : 'DSH Agent: 后端启动失败');
        this.display();
      });
    };
    const stopButton = actions.createEl('button', { text: '停止后端' });
    stopButton.onclick = () => {
      void this.plugin.backend.stop().then(() => this.display());
    };
    const reinstall = actions.createEl('button', { text: '重新生成配置' });
    reinstall.onclick = () => {
      this.plugin.installer.writeRuntimeFiles(this.plugin.settings, this.plugin.persistenceRoot);
      new Notice('DSH Agent: 已重新生成 cordis.yml / settings.yaml');
    };
    const cleanup = actions.createEl('button', { text: '清理过期日志' });
    cleanup.disabled = this.plugin.settings.sessionLogRetentionDays <= 0;
    cleanup.onclick = () => {
      const result = this.plugin.cleanupStoredLogs();
      new Notice('DSH Agent: 已清理 ' + result.removed + ' 项，释放 ' + formatBytes(result.bytes));
      this.display();
    };
  }
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function clonePrompt(prompt: PendingPrompt): PendingPrompt {
  return JSON.parse(JSON.stringify(prompt)) as PendingPrompt;
}

function redactUnknown(value: unknown): unknown {
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value))) as unknown;
  } catch {
    return '[REDACTED: 无法安全序列化]';
  }
}

function permissionRisk(toolName: string, argumentsJson: string): string {
  const text = (toolName + ' ' + argumentsJson).toLowerCase();
  if (/danger|delete|remove|unlink|rm\s|format|reset|credential|password|token|outside|\.\.[\\/]/.test(text)) return '高风险';
  if (/bash|shell|exec|write|edit|move|rename|install|network|http/.test(text)) return '中风险';
  return '低风险';
}

function redactConversationActivities(conversation: Conversation): void {
  for (const message of conversation.messages) {
    const activities = new Set([
      ...(message.toolActivities ?? []),
      ...(message.blocks ?? []).filter((block) => block.kind === 'tool').map((block) => block.activity),
    ]);
    for (const activity of activities) {
      activity.argumentsJson = redactSensitiveText(activity.argumentsJson);
      activity.resultText = redactSensitiveText(activity.resultText);
      if (activity.meta !== undefined) activity.meta = redactUnknown(activity.meta);
    }
  }
}

function normalizeNumberSetting(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
