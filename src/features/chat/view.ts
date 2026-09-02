// Chat view: conversation sidebar, messages (tool cards + todos + markdown),
// composer with attachments and model chips.
import { App, ItemView, MarkdownRenderer, Notice, renderMath, setIcon, WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_DSH_CHAT } from '../../constants';
import type { BackendSnapshot } from '../../backend/backend';
import { canReuseRenderedMessageDom, compareConversationsByRecent, isMessageIdPrefix, latestAssistantMessageIndex, mergeMirroredStreamText, uncommittedStreamText } from './session';
import type { ChatMessage, Conversation, NoteAttachment, QuoteAttachment, SelectionAttachment, ToolActivity } from './session';
import { addCopyButtons, renderGoalCard, renderThinkingBlock, renderTodoList, renderToolCard, renderWorkflowCard } from './renderers';
import { expandSlashCommand, selectionLabel } from './prompt-build';
import type { SlashCommand } from './pickers';
import { openHoverMenu, openInlinePicker, renderPermissionCard } from './inline-picker';
import type { HoverMenuOption } from './inline-picker';
import { nextTypewriterVisibleChars, TYPEWRITER_FRAME_INTERVAL_MS, TypewriterProgressStore } from './typewriter';
import type { ReasoningEffort } from '../../settings/settings';

export interface ChatViewHost {
  getApp(): App;
  getConversations(): Conversation[];
  getActiveConversation(): Conversation | null;
  activateConversation(id: string): void;
  createConversation(): Conversation;
  removeConversation(id: string): void;
  getDeletedConversationCount(): number;
  restoreLastDeletedConversation(): Conversation | undefined;
  setConversationClosed(id: string, closed: boolean): void;
  setConversationPinned(id: string, pinned: boolean): void;
  sendMessage(conversation: Conversation, text: string): void;
  sendOrQueue(conversation: Conversation, text: string): Promise<void>;
  cancelQueuedPrompt(conversation: Conversation, messageId: string): boolean;
  moveQueuedPrompt(conversation: Conversation, messageId: string, delta: -1 | 1): boolean;
  rewindConversation(conversation: Conversation, messageId: string): string | undefined;
  retryAssistant(conversation: Conversation, messageId: string): Promise<boolean>;
  regenerateAssistant(conversation: Conversation, messageId: string): Promise<boolean>;
  continueAssistant(conversation: Conversation, messageId: string): Promise<boolean>;
  stopActiveTurn(): void;
  getBackendSnapshot(): BackendSnapshot;
  getCurrentConfig(): { provider: string; model: string; reasoningEffort: ReasoningEffort; permissionMode: string; agentPreset: string };
  getAgentPresets(): { id: string; name: string; description: string }[];
  getFeatureFlags(): Record<string, boolean>;
  getModelContextWindow(): number;
  getContextPolicy(): { autoCompactPercent: number };
  requestCompaction(conversation: Conversation): Promise<void>;
  previewFileChange(message: ChatMessage, path: string): string;
  undoMessageChanges(conversation: Conversation, messageId: string): Promise<{ reverted: string[]; conflicts: string[]; unavailable: string[] }>;
  getModelCatalog(): {
    providers: { id: string; name: string; hidden: boolean }[];
    models: { id: string; name: string; providerId: string; providerName: string; reasoningEfforts: ReasoningEffort[] }[];
  };
  getReasoningEfforts(): ReasoningEffort[];
  selectModelCombo(provider: string, model: string): Promise<{ restart: boolean }>;
  clearSelection(kind: 'note' | 'web-context' | 'web-selection'): void;
  selectProvider(provider: string): Promise<{ restart: boolean }>;
  selectModel(model: string): Promise<{ restart: boolean }>;
  selectEffort(effort: ReasoningEffort): Promise<{ restart: boolean }>;
  selectPermissionMode(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): Promise<{ restart: boolean }>;
  selectAgentPreset(id: string): Promise<{ restart: boolean }>;
  confirmRestart(message: string): Promise<boolean>;
  openSettings(): void;
  openSynapseView(): Promise<void>;
  attachCurrentNote(conversation: Conversation): boolean;
  removeAttachment(conversation: Conversation, uri: string): void;
  attachNote(conversation: Conversation, path: string, basename: string): void;
  importFiles(conversation: Conversation, files: File[]): Promise<{ imported: number; failed: string[] }>;
  updateAttachmentRange(conversation: Conversation, uri: string, range: NoteAttachment['range'] | undefined): void;
  addQuote(conversation: Conversation, quote: QuoteAttachment): void;
  updateQuote(conversation: Conversation, index: number, note: string): void;
  removeQuote(conversation: Conversation, index: number): void;
  branchConversation(conversation: Conversation, throughMessageId: string): Conversation;
  setWorkspace(conversation: Conversation, path: string): void;
  getNoteFiles(): { path: string; basename: string }[];
  getWorkspaceOptions(): { path: string; label: string }[];
  getSkillEntries(): { name: string; description: string }[];
  openNote(path: string): void;
  requestAgentControl(childId: string, action: 'stop' | 'retry', label: string, prompt?: string): void;
  registerPermissionRenderer(renderer: ((request: { toolName: string; prompt: string; argumentsJson: string; risk: string; queueDepth: number }) => Promise<'allow' | 'reject' | 'cancelled'>) | null): void;
  onChange(listener: () => void): () => void;
}

const STREAM_RENDER_INTERVAL_MS = 220;
const CONVERSATION_DOM_CACHE_LIMIT = 6;

interface ConversationDomCache {
  holder: HTMLDivElement;
  renderedMessages: ChatMessage[];
  scrollTop: number;
  stickToBottom: boolean;
}

export class DshChatView extends ItemView {
  private listEl!: HTMLElement;
  private messageEl!: HTMLElement;
  private composerEl!: HTMLTextAreaElement;
  private fileInputEl!: HTMLInputElement;
  private stopButtonEl!: HTMLButtonElement;
  private chipsEl!: HTMLElement;
  private chipsSignature = '';
  private expandedIds = new Set<string>();
  private quoteButtonEl!: HTMLElement;
  private quoteRange: Range | null = null;
  private selectionChangeHandler: (() => void) | null = null;
  private documentDownHandler: ((event: MouseEvent) => void) | null = null;
  private stripHidden = false;
  private historyOpen = false;
  private lastStreamRender = 0;
  private featureFlags: Record<string, boolean> = {};
  private flagsSignature = '';
  private typewriterRendering = false;
  private readonly typewriterProgress = new TypewriterProgressStore();
  private typewriter: { messageId: string; segmentKey: string; visibleChars: number; targetText: string; timer: number | null } = {
    messageId: '',
    segmentKey: '',
    visibleChars: 0,
    targetText: '',
    timer: null,
  };
  private statusEl!: HTMLElement;
  private statusSignature = '';
  private statusRefreshPending = false;
  private sidebarSignature = '';
  private attachmentEl!: HTMLElement;
  private jumpEl!: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private renderedMessages: ChatMessage[] = [];
  private renderedConversationId: string | null = null;
  private messageRenderGeneration = 0;
  private rendering = false;
  private pendingRerender = false;
  private stickToBottom = true;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStreamedId: string | null = null;
  private viewContainer!: HTMLElement;
  private panelEl!: HTMLElement;
  private composerWrapEl!: HTMLElement;
  private contentObserver: MutationObserver | null = null;
  private permissionCancel: (() => void) | null = null;
  private elapsedTimer: number | null = null;
  private closed = true;
  private readonly conversationDomCache = new Map<string, ConversationDomCache>();

  constructor(leaf: WorkspaceLeaf, private readonly host: ChatViewHost) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_DSH_CHAT;
  }

  getDisplayText(): string {
    return 'DSH Agent';
  }

  getIcon(): string {
    return 'bot-message-square';
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('dsh-agent-view');
    this.viewContainer = container;

    const header = container.createDiv({ cls: 'dsh-agent-header' });
    const title = header.createDiv({ cls: 'dsh-agent-title' });
    title.createSpan({ text: 'DSH Agent' });
    this.statusEl = header.createDiv({ cls: 'dsh-agent-status' });
    const spacer = header.createDiv({ cls: 'dsh-agent-header-spacer' });
    const mapButton = header.createEl('button', { cls: 'dsh-agent-icon-btn' });
    setIcon(mapButton, 'network');
    mapButton.setAttr('aria-label', '会话地图');
    mapButton.onclick = () => void this.host.openSynapseView();
    const historyButton = header.createEl('button', { cls: 'dsh-agent-icon-btn' });
    setIcon(historyButton, 'history');
    historyButton.setAttr('aria-label', '历史对话');
    historyButton.onclick = () => this.toggleHistoryPanel();
    const newButton = header.createEl('button', { cls: 'dsh-agent-icon-btn' });
    setIcon(newButton, 'plus');
    newButton.setAttr('aria-label', '新会话');
    newButton.onclick = () => {
      const conversation = this.host.createConversation();
      this.host.activateConversation(conversation.id);
    };

    const body = container.createDiv({ cls: 'dsh-agent-body' });
    const main = body.createDiv({ cls: 'dsh-agent-main' });
    this.messageEl = main.createDiv({ cls: 'dsh-agent-messages' });
    this.jumpEl = main.createDiv({ cls: 'dsh-agent-jump' });
    this.panelEl = main.createDiv({ cls: 'dsh-agent-inline-panel' });
    this.listEl = main.createDiv({ cls: 'dsh-agent-conversation-strip' });
    this.quoteButtonEl = document.body.createDiv({ cls: 'dsh-agent-quote-button' });
    this.quoteButtonEl.style.display = 'none';
    this.quoteButtonEl.dataset.mode = 'none';
    this.selectionChangeHandler = () => this.maybeShowQuoteButton();
    document.addEventListener('selectionchange', this.selectionChangeHandler);
    this.messageEl.addEventListener('mouseup', this.selectionChangeHandler);
    this.messageEl.addEventListener('keyup', this.selectionChangeHandler);
    this.documentDownHandler = (event) => {
      if (!this.quoteButtonEl.contains(event.target as Node)) this.hideQuoteBubble();
    };
    document.addEventListener('mousedown', this.documentDownHandler);
    const jumpButton = this.jumpEl.createEl('button', { cls: 'dsh-agent-btn' });
    setIcon(jumpButton, 'arrow-down');
    jumpButton.setAttr('aria-label', '跳转到最新消息');
    jumpButton.onclick = () => {
      this.stickToBottom = true;
      this.jumpEl.removeClass('is-visible');
      this.scrollToBottom();
    };
    this.messageEl.addEventListener('scroll', () => {
      const nearBottom = this.messageEl.scrollHeight - this.messageEl.scrollTop - this.messageEl.clientHeight < 48;
      this.stickToBottom = nearBottom;
      this.jumpEl.toggleClass('is-visible', !nearBottom);
    });
    // Content that lands after a render pass (async markdown/math, image
    // loads) grows scrollHeight below the viewport; keep following while
    // the user is stuck to the bottom.
    const contentObserver = new MutationObserver(() => {
      if (this.stickToBottom) this.scrollToBottom();
    });
    contentObserver.observe(this.messageEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.contentObserver = contentObserver;
    // Esc stops the in-flight reply.
    this.scope?.register([], 'Escape', () => {
      const conversation = this.host.getActiveConversation();
      if (conversation !== null && conversation.status === 'streaming') {
        this.host.stopActiveTurn();
        return true;
      }
      return false;
    });

    const composer = main.createDiv({ cls: 'dsh-agent-composer' });
    this.composerWrapEl = composer;
    this.attachmentEl = composer.createDiv({ cls: 'dsh-agent-attachments' });
    this.composerEl = composer.createEl('textarea', {
      cls: 'dsh-agent-input',
      attr: { placeholder: '输入消息，Enter 发送，Shift+Enter 换行…' },
    });
    this.fileInputEl = composer.createEl('input', {
      cls: 'dsh-agent-file-input',
      attr: { type: 'file', multiple: 'true' },
    });
    this.fileInputEl.addEventListener('change', () => {
      const files = Array.from(this.fileInputEl.files ?? []);
      this.fileInputEl.value = '';
      if (files.length > 0) void this.importFiles(files);
    });
    composer.addEventListener('dragover', (event) => {
      if ((event.dataTransfer?.files.length ?? 0) === 0) return;
      event.preventDefault();
      composer.addClass('is-dragging');
    });
    composer.addEventListener('dragleave', () => composer.removeClass('is-dragging'));
    composer.addEventListener('drop', (event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      composer.removeClass('is-dragging');
      if (files.length === 0) return;
      event.preventDefault();
      void this.importFiles(files);
    });
    this.composerEl.addEventListener('paste', (event) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void this.importFiles(files);
    });
    this.composerEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.submit();
        return;
      }
      if (event.key === '@') {
        event.preventDefault();
        this.openNotePicker();
        return;
      }
      if (event.key === '/') {
        const value = this.composerEl.value;
        const atTokenStart = value === '' || /\s$/.test(value);
        if (atTokenStart) {
          event.preventDefault();
          this.openSlashMenu();
        }
      }
    });
    const footer = composer.createDiv({ cls: 'dsh-agent-composer-footer' });
    const attachButton = footer.createEl('button', { cls: 'dsh-agent-btn dsh-agent-attach' });
    setIcon(attachButton, 'paperclip');
    attachButton.setAttr('aria-label', '添加笔记、PDF、图片或文件');
    attachButton.onclick = () => this.openAttachmentMenu();
    this.chipsEl = footer.createDiv({ cls: 'dsh-agent-chips' });
    const buttons = footer.createDiv({ cls: 'dsh-agent-composer-buttons' });
    this.stopButtonEl = buttons.createEl('button', { cls: 'dsh-agent-btn dsh-agent-stop' });
    setIcon(this.stopButtonEl, 'square');
    this.stopButtonEl.setAttr('aria-label', '停止回复（Esc）');
    this.stopButtonEl.onclick = () => this.host.stopActiveTurn();

    this.unsubscribe = this.host.onChange(() => this.render());
    this.host.registerPermissionRenderer((request) => this.renderInlinePermission(request));
    this.render();
    this.elapsedTimer = window.setInterval(() => this.refreshElapsedTimers(), 1000);
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.messageRenderGeneration += 1;
    this.pendingRerender = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.streamTimer !== null) clearTimeout(this.streamTimer);
    if (this.elapsedTimer !== null) window.clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    this.clearTypewriter();
    this.typewriterProgress.clear();
    this.clearConversationDomCache();
    this.contentObserver?.disconnect();
    this.contentObserver = null;
    this.host.registerPermissionRenderer(null);
    this.permissionCancel?.();
    this.permissionCancel = null;
    this.panelEl?.removeClass('is-open');
    this.panelEl?.empty();
    this.hideQuoteBubble();
    this.quoteButtonEl?.remove();
    if (this.selectionChangeHandler !== null) {
      document.removeEventListener('selectionchange', this.selectionChangeHandler);
    }
    if (this.documentDownHandler !== null) {
      document.removeEventListener('mousedown', this.documentDownHandler);
    }
  }

  private attachCurrentNote(): void {
    const conversation = this.host.getActiveConversation();
    if (conversation === null) return;
    this.host.attachCurrentNote(conversation);
  }

  private openAttachmentMenu(): void {
    let conversation = this.host.getActiveConversation();
    if (conversation === null) {
      conversation = this.host.createConversation();
      this.host.activateConversation(conversation.id);
    }
    this.positionInlinePanel();
    openInlinePicker(this.panelEl, {
      placeholder: '选择附件来源…',
      anchor: this.composerWrapEl,
      items: [
        { id: 'current-note', label: '附加当前笔记', description: '把正在阅读或编辑的笔记加入上下文', icon: 'file-text' },
        { id: 'local-files', label: '选择本地文件', description: '支持 PDF、图片、文本和普通文件，可多选', icon: 'files' },
      ],
      onChoose: (item) => {
        if (item.id === 'current-note') this.host.attachCurrentNote(conversation);
        else this.fileInputEl.click();
        this.composerEl.focus();
      },
    });
  }

  private async importFiles(files: File[]): Promise<void> {
    let conversation = this.host.getActiveConversation();
    if (conversation === null) {
      conversation = this.host.createConversation();
      this.host.activateConversation(conversation.id);
    }
    const result = await this.host.importFiles(conversation, files);
    if (result.imported > 0) new Notice('已添加 ' + result.imported + ' 个附件');
    if (result.failed.length > 0) new Notice('以下附件添加失败：' + result.failed.slice(0, 3).join('、'));
    this.composerEl.focus();
  }

  private refreshElapsedTimers(): void {
    const now = Date.now();
    for (const el of Array.from(this.messageEl?.querySelectorAll<HTMLElement>('.dsh-agent-elapsed[data-start]') ?? [])) {
      const start = Number(el.dataset.start);
      const end = Number(el.dataset.end || now);
      if (!Number.isFinite(start) || start <= 0) continue;
      const seconds = Math.max(0, Math.floor((end - start) / 1000));
      const text = seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
      if (el.textContent !== text) el.setText(text);
    }
  }

  private openNotePicker(): void {
    const conversation = this.host.getActiveConversation();
    if (conversation === null) {
      new Notice('先打开或新建一个会话');
      return;
    }
    this.positionInlinePanel();
    openInlinePicker(this.panelEl, {
      placeholder: '搜索笔记（@ 附件）…',
      anchor: this.composerWrapEl,
      items: this.host.getNoteFiles().map((file) => ({
        id: file.path,
        label: file.basename,
        description: file.path,
        icon: 'file-text',
      })),
      onChoose: (item) => {
        this.host.attachNote(conversation, item.id, item.label);
        this.composerEl.focus();
      },
    });
  }

  private openWorkspacePicker(): void {
    let conversation = this.host.getActiveConversation();
    if (conversation === null) {
      conversation = this.host.createConversation();
      this.host.activateConversation(conversation.id);
    }
    this.positionInlinePanel();
    openInlinePicker(this.panelEl, {
      placeholder: '选择工作区目录…',
      anchor: this.composerWrapEl,
      items: this.host.getWorkspaceOptions().map((option) => ({
        id: option.path,
        label: option.label,
        description: option.path,
        icon: 'folder',
      })),
      onChoose: (item) => {
        this.host.setWorkspace(conversation, item.id);
        new Notice('工作区已切换: ' + item.label + '（下次发送将使用新工作区）');
        this.composerEl.focus();
      },
    });
  }

  private openSlashMenu(): void {
    const commands: SlashCommand[] = [
      { id: '/new', label: '/new 新会话', description: '创建并切换到新会话' },
      { id: '/clear', label: '/clear 清空输入', description: '清空当前输入框' },
      { id: '/stop', label: '/stop 停止生成', description: '停止当前回复' },
      { id: '/attach', label: '/attach 附加当前笔记', description: '把当前活跃笔记作为上下文' },
      { id: '/settings', label: '/settings 打开设置', description: '打开插件设置页' },
      { id: '/goal', label: '/goal 创建目标（DSH）', description: '让 DSH 用 goal 工具创建并执行目标' },
      { id: '/workflow', label: '/workflow 多智能体编排（DSH）', description: '让 DSH 用 workflow 工具并行编排 agent' },
      { id: '/compact', label: '/compact 压缩上下文（DSH）', description: '让 DSH 总结当前会话要点' },
    ];
    // Skills: invoked by the same slash-token path the harness recognizes
    // (typing /name loads the skill at the pre-step boundary).
    for (const skill of this.host.getSkillEntries()) {
      commands.push({
        id: 'skill:' + skill.name,
        label: '/' + skill.name + ' 技能',
        description: skill.description !== '' ? skill.description : '加载技能 ' + skill.name,
      });
    }
    openInlinePicker(this.panelEl, {
      placeholder: '选择命令或技能…',
      anchor: this.composerWrapEl,
      items: commands.map((command) => ({
        id: command.id,
        label: command.label,
        description: command.description,
        icon: command.id.startsWith('skill:') ? 'sparkles' : 'command',
      })),
      onChoose: (item) => {
        const command = commands.find((c) => c.id === item.id);
        if (command !== undefined) this.runSlashCommand(command);
      },
    });
  }

  private runSlashCommand(command: SlashCommand): void {
    switch (command.id) {
      case '/new': {
        const conversation = this.host.createConversation();
        this.host.activateConversation(conversation.id);
        break;
      }
      case '/clear':
        this.composerEl.value = '';
        break;
      case '/stop':
        this.host.stopActiveTurn();
        break;
      case '/attach': {
        const conversation = this.host.getActiveConversation();
        if (conversation !== null) this.host.attachCurrentNote(conversation);
        break;
      }
      case '/settings':
        this.host.openSettings();
        break;
      case '/goal':
        this.composerEl.value = '/goal ';
        this.composerEl.focus();
        break;
      case '/workflow':
        this.composerEl.value = '/workflow ';
        this.composerEl.focus();
        break;
      case '/compact': {
        const conversation = this.host.getActiveConversation();
        if (conversation === null) {
          new Notice('先打开或新建一个会话');
          return;
        }
        if (conversation.status === 'preparing' || conversation.status === 'streaming') return;
        this.host.sendMessage(conversation, '/compact');
        break;
      }
      default:
        if (command.id.startsWith('skill:')) {
          const name = command.id.slice('skill:'.length);
          this.composerEl.value = '/' + name + ' ';
          this.composerEl.focus();
        }
        break;
    }
  }

  private makeChip(text: string, icon: string): HTMLButtonElement {
    const chip = this.chipsEl.createEl('button', { cls: 'dsh-agent-chip' });
    chip.tabIndex = 0;
    chip.addEventListener('focus', () => this.positionInlinePanel());
    const iconEl = chip.createSpan({ cls: 'dsh-agent-chip-icon' });
    setIcon(iconEl, icon);
    chip.createSpan({ cls: 'dsh-agent-chip-text', text });
    chip.setAttr('aria-label', text);
    return chip;
  }

  /** Position the inline panel as an overlay above the composer (no layout shift). */
  private positionInlinePanel(): void {
    const stripH = this.stripHidden ? 0 : this.listEl.offsetHeight;
    const composerH = this.composerWrapEl.offsetHeight;
    this.panelEl.style.bottom = (stripH + composerH + 8) + 'px';
  }

  /** Bottom chips: Agent preset / Model / Effort / Mode / Workspace. */
  private renderChips(): void {
    const config = this.host.getCurrentConfig();
    const conversation = this.host.getActiveConversation();
    const catalog = this.host.getModelCatalog();
    const reasoningEfforts = this.host.getReasoningEfforts();
    const signature = config.agentPreset + '|' + config.provider + '|' + config.model + '|' + config.reasoningEffort + '|' + config.permissionMode
      + '|' + (conversation?.workspace ?? '')
      + '|' + catalog.models.map((entry) => entry.providerId + ':' + entry.id).join(',')
      + '|' + reasoningEfforts.join(',');
    if (signature === this.chipsSignature) return;
    this.chipsSignature = signature;
    this.chipsEl.empty();
    this.chipsEl.onmouseenter = () => this.positionInlinePanel();

    const currentModel = catalog.models.find(
      (entry) => entry.providerId === config.provider && entry.id === config.model,
    );
    const modelLabel = currentModel?.name ?? config.model;

    // --- Agent preset chip: a behavior bundle, not a fake reasoning level ---
    const presets = this.host.getAgentPresets();
    const selectedPreset = presets.find((preset) => preset.id === config.agentPreset);
    const agentChip = this.makeChip('Agent: ' + (selectedPreset?.name ?? '自定义'), 'sparkles');
    openHoverMenu(this.panelEl, {
      chip: agentChip,
      options: presets.map((preset) => ({
        id: preset.id,
        label: preset.name,
        description: preset.description,
        selected: preset.id === config.agentPreset,
      })),
      onChoose: (id) => void this.chooseAgentPreset(id),
    });

    // --- Model chip: provider · model, grouped hover menu ---
    const modelChip = this.makeChip('Model: ' + config.provider + ' · ' + modelLabel, 'bot');
    const modelOptions: HoverMenuOption[] = [];
    let lastProvider = '';
    for (const entry of catalog.models) {
      modelOptions.push({
        id: entry.providerId + '\u0000' + entry.id,
        label: entry.name,
        group: entry.providerId,
        groupTitle: entry.providerId === lastProvider ? '' : entry.providerId,
        selected: entry.providerId === config.provider && entry.id === config.model,
      });
      lastProvider = entry.providerId;
    }
    openHoverMenu(this.panelEl, {
      chip: modelChip,
      options: modelOptions,
      onChoose: (id) => void this.chooseModelCombo(id),
    });

    // --- Effort chip ---
    const effortChip = this.makeChip('Effort: ' + config.reasoningEffort, 'brain');
    openHoverMenu(this.panelEl, {
      chip: effortChip,
      options: reasoningEfforts.map((effort) => ({
        id: effort,
        label: effort === 'default' ? 'Effort: 模型默认' : 'Effort: ' + effort,
        selected: effort === config.reasoningEffort,
      })),
      onChoose: (id) => void this.chooseEffort(id),
    });

    // --- Mode chip (permission scope) ---
    const modeChip = this.makeChip(
      'Mode: ' + (config.permissionMode === 'read-only' ? '只读' : config.permissionMode === 'workspace-write' ? '库内' : '全量'),
      'shield',
    );
    openHoverMenu(this.panelEl, {
      chip: modeChip,
      options: [
        { id: 'read-only', label: '只读（read-only）', description: '真实沙箱禁止修改文件', selected: config.permissionMode === 'read-only' },
        { id: 'workspace-write', label: '库内（workspace-write）', description: '写入限制在笔记库内', selected: config.permissionMode === 'workspace-write' },
        { id: 'danger-full-access', label: '全量（danger-full-access）', description: '无写入限制（危险）', selected: config.permissionMode === 'danger-full-access' },
      ],
      onChoose: (id) => void this.chooseMode(id),
    });

    // --- Workspace chip: shows the current working directory ---
    const workspaceLabel = this.workspaceLabelFor(conversation);
    const workspaceChip = this.makeChip('Workspace: ' + workspaceLabel, 'folder');
    workspaceChip.setAttr('aria-label', '切换工作区');
    workspaceChip.onclick = () => this.openWorkspacePicker();
  }

  private async chooseAgentPreset(id: string): Promise<void> {
    const config = this.host.getCurrentConfig();
    if (id === config.agentPreset) return;
    const ok = await this.host.confirmRestart('切换 Agent 预设会同时应用 persona、默认模型、Effort、权限和工具范围，并重启 DSH 后端。是否继续？');
    if (!ok) return;
    await this.host.selectAgentPreset(id);
    new Notice('Agent 预设已应用，后端已重启');
  }

  /** Short label for the conversation's workspace (vault-relative). */
  private workspaceLabelFor(conversation: Conversation | null): string {
    if (conversation !== null) {
      const hit = this.host.getWorkspaceOptions().find((option) => option.path === conversation.workspace);
      if (hit !== undefined) return hit.label;
    }
    return '库根目录';
  }

  private async chooseModelCombo(id: string): Promise<void> {
    const sep = id.indexOf('\u0000');
    if (sep === -1) return;
    const providerId = id.slice(0, sep);
    const modelId = id.slice(sep + 1);
    const config = this.host.getCurrentConfig();
    if (providerId === config.provider && modelId === config.model) return;
    await this.host.selectModelCombo(providerId, modelId);
    new Notice('模型已热切换，将从下一次模型调用开始生效');
  }

  private async chooseEffort(id: string): Promise<void> {
    const config = this.host.getCurrentConfig();
    if (id === config.reasoningEffort) return;
    const result = await this.host.selectEffort(id as ReasoningEffort);
    new Notice(result.restart ? '思考强度已生效（后端已重启）' : '思考强度已生效（热更新，无需重启）');
  }

  private async chooseMode(id: string): Promise<void> {
    const config = this.host.getCurrentConfig();
    if (id === config.permissionMode) return;
    const ok = await this.host.confirmRestart('切换工作模式（权限范围）需要重启 DSH 后端，进行中的会话将断开（历史保留），是否继续？');
    if (!ok) return;
    await this.host.selectPermissionMode(id as 'read-only' | 'workspace-write' | 'danger-full-access');
    new Notice('工作模式已切换，后端已重启');
  }

  private renderInlinePermission(request: { toolName: string; prompt: string; argumentsJson: string; risk: string; queueDepth: number }): Promise<'allow' | 'reject' | 'cancelled'> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: 'allow' | 'reject' | 'cancelled'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        document.removeEventListener('keydown', onKey, true);
        this.panelEl.empty();
        this.panelEl.removeClass('is-open');
        this.permissionCancel = null;
        resolve(decision);
      };
      this.permissionCancel = () => finish('cancelled');
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish('reject');
        }
      };
      document.addEventListener('keydown', onKey, true);
      const timer = setTimeout(() => {
        new Notice('权限请求超时，已自动拒绝');
        finish('reject');
      }, 120_000);
      renderPermissionCard(this.panelEl, {
        toolName: request.toolName,
        prompt: request.prompt,
        argumentsJson: request.argumentsJson,
        risk: request.risk,
        queueDepth: request.queueDepth,
        onAllow: () => finish('allow'),
        onReject: () => finish('reject'),
      });
    });
  }

  private clearTypewriter(): void {
    if (this.typewriter.timer !== null) {
      window.clearTimeout(this.typewriter.timer);
      this.typewriter.timer = null;
    }
    this.typewriter.messageId = '';
    this.typewriter.segmentKey = '';
    this.typewriter.visibleChars = 0;
    this.typewriter.targetText = '';
  }

  /** Reveal buffered text fast enough to stay close to the live model output. */
  private tickTypewriter(message: ChatMessage): void {
    if (this.closed) return;
    const tw = this.typewriter;
    if (tw.messageId !== message.id) return;
    if (this.typewriterRendering) {
      tw.timer = window.setTimeout(() => {
        tw.timer = null;
        this.tickTypewriter(message);
      }, TYPEWRITER_FRAME_INTERVAL_MS);
      return;
    }
    const target = this.messageEl.querySelector<HTMLElement>('.dsh-agent-streaming-text');
    if (target === null) {
      tw.timer = window.setTimeout(() => {
        tw.timer = null;
        this.tickTypewriter(message);
      }, TYPEWRITER_FRAME_INTERVAL_MS);
      return;
    }
    const full = tw.targetText;
    const remaining = full.length - tw.visibleChars;
    if (remaining <= 0) {
      target.dataset.text = full;
      target.setText(full);
      const conversation = this.host.getActiveConversation();
      if (conversation !== null && !this.isStreamingAssistant(conversation, message)) {
        this.finishTypewriter(message, target);
      }
      return;
    }
    tw.visibleChars = nextTypewriterVisibleChars(full, tw.visibleChars);
    this.typewriterProgress.remember(tw.messageId, tw.segmentKey, tw.visibleChars, full);
    const shown = full.slice(0, tw.visibleChars);
    target.dataset.text = shown;
    // Plain text during the animation avoids rebuilding Markdown/MathJax for
    // every character. The completed segment is rendered as Markdown once.
    target.setText(shown);
    tw.timer = window.setTimeout(() => {
      tw.timer = null;
      this.tickTypewriter(message);
    }, TYPEWRITER_FRAME_INTERVAL_MS);
  }

  private finishTypewriter(message: ChatMessage, target: HTMLElement): void {
    if (this.closed || this.typewriterRendering || this.typewriter.messageId !== message.id) return;
    const full = this.typewriter.targetText;
    this.typewriterRendering = true;
    void this.renderMarkdownInto(target, full, true).finally(() => {
      this.typewriterRendering = false;
      if (this.closed) return;
      if (this.typewriter.messageId !== message.id || this.typewriter.visibleChars < this.typewriter.targetText.length) return;
      const wrapper = target.closest<HTMLElement>('.dsh-agent-message');
      this.typewriterProgress.forgetMessage(message.id);
      this.clearTypewriter();
      if (wrapper !== null) wrapper.dataset.blocksSignature = '__typewriter-complete__';
      void this.renderMessages();
    });
  }

  private renderThinkingLineInto(holder: HTMLElement, message: ChatMessage): void {
    holder.removeClass('is-leaving');
    const line = holder.createDiv({ cls: 'dsh-agent-thinking-line' });
    line.tabIndex = 0;
    line.setAttr('role', 'button');
    line.setAttr('aria-expanded', 'false');
    const icon = line.createSpan({ cls: 'dsh-agent-thinking-icon' });
    setIcon(icon, 'brain');
    line.createSpan({ cls: 'dsh-agent-thinking-label', text: 'thinking...' });
    const dots = line.createSpan({ cls: 'dsh-agent-thinking-dots' });
    for (let i = 0; i < 3; i++) dots.createSpan();
    const chevron = line.createSpan({ cls: 'dsh-agent-thinking-chevron' });
    setIcon(chevron, 'chevron-down');
    const body = holder.createDiv({ cls: 'dsh-agent-thinking-live-body dsh-collapsed' });
    body.createDiv({ cls: 'dsh-agent-thinking-live-text' });
    const toggle = (): void => {
      const expanded = body.hasClass('dsh-collapsed');
      body.toggleClass('dsh-collapsed', !expanded);
      holder.toggleClass('is-expanded', expanded);
      line.setAttr('aria-expanded', String(expanded));
      setIcon(chevron, expanded ? 'chevron-up' : 'chevron-down');
      this.syncThinkingLine(holder, message);
    };
    line.onclick = toggle;
    line.onkeydown = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    };
    this.syncThinkingLine(holder, message);
  }

  private syncThinkingLine(holder: HTMLElement, message: ChatMessage): void {
    const textEl = holder.querySelector<HTMLElement>('.dsh-agent-thinking-live-text');
    if (textEl === null) return;
    const text = message.liveReasoning?.trim() ?? '';
    const shown = text === '' ? '正在等待思考内容…' : text;
    if (textEl.textContent !== shown) textEl.setText(shown);
    if (holder.hasClass('is-expanded')) textEl.scrollTop = textEl.scrollHeight;
  }

  /** Show a floating "add to context" button above a selection in AI replies. */
  private maybeShowQuoteButton(): void {
    if (this.quoteButtonEl === undefined) return;
    if (this.featureFlags['ui.quote-context'] === false) {
      this.hideQuoteBubble();
      return;
    }
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      if (this.quoteButtonEl.dataset.mode !== 'bubble') this.hideQuoteBubble();
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node instanceof Element ? node : node.parentElement;
    if (el === null || el.closest('.dsh-agent-message.is-assistant') === null) {
      if (this.quoteButtonEl.dataset.mode !== 'bubble') this.hideQuoteBubble();
      return;
    }
    if (this.quoteButtonEl.dataset.mode === 'bubble') return;
    if (range.toString().trim() === '') {
      this.hideQuoteBubble();
      return;
    }
    this.quoteRange = range;
    this.quoteButtonEl.dataset.mode = 'button';
    this.quoteButtonEl.empty();
    this.quoteButtonEl.removeClass('is-bubble');
    const btn = this.quoteButtonEl.createEl('button', { cls: 'dsh-agent-quote-action' });
    const icon = btn.createSpan();
    setIcon(icon, 'quote');
    btn.createSpan({ text: ' 加入上下文' });
    btn.onclick = () => this.openQuoteBubble();
    this.quoteButtonEl.style.display = 'flex';
    const rect = range.getBoundingClientRect();
    const width = this.quoteButtonEl.offsetWidth || 120;
    this.quoteButtonEl.style.left = Math.max(8, rect.left + rect.width / 2 - width / 2) + 'px';
    this.quoteButtonEl.style.top = Math.max(8, rect.top - 36) + 'px';
  }

  /** Render the annotation bubble body; returns the confirm handler setup. */
  private renderQuoteBubbleBody(text: string, note: string, confirmLabel: string, onConfirm: (note: string) => void): void {
    this.quoteButtonEl.dataset.mode = 'bubble';
    this.quoteButtonEl.addClass('is-bubble');
    this.quoteButtonEl.empty();

    const header = this.quoteButtonEl.createDiv({ cls: 'dsh-agent-quote-header' });
    header.createSpan({ text: '引用到下一次对话' });
    const closeBtn = header.createEl('button', { cls: 'dsh-agent-quote-close' });
    setIcon(closeBtn, 'x');
    closeBtn.setAttr('aria-label', '关闭');
    closeBtn.onclick = () => this.hideQuoteBubble();

    const preview = this.quoteButtonEl.createDiv({ cls: 'dsh-agent-quote-preview' });
    preview.setText(text.length > 80 ? text.slice(0, 80) + '…' : text);
    const noteEl = this.quoteButtonEl.createEl('textarea', {
      cls: 'dsh-agent-quote-note',
      attr: { placeholder: '添加注释（可选）…' },
    });
    noteEl.value = note;
    noteEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.hideQuoteBubble();
      }
    });
    const actions = this.quoteButtonEl.createDiv({ cls: 'dsh-agent-quote-actions' });
    const cancel = actions.createEl('button', { cls: 'dsh-agent-btn', text: '取消' });
    cancel.onclick = () => this.hideQuoteBubble();
    const confirm = actions.createEl('button', { cls: 'dsh-agent-btn mod-cta', text: confirmLabel });
    confirm.onclick = () => {
      this.hideQuoteBubble();
      onConfirm(noteEl.value.trim());
    };
    noteEl.focus();
  }

  private openQuoteBubble(): void {
    const range = this.quoteRange;
    if (range === null) return;
    const text = range.toString().trim();
    if (text === '') return;
    this.renderQuoteBubbleBody(text, '', '加入上下文', (note) => {
      const conversation = this.host.getActiveConversation();
      if (conversation !== null) {
        this.host.addQuote(conversation, { text, note });
        new Notice('已加入下一次对话的上下文');
      }
    });
    this.quoteButtonEl.style.display = 'flex';
    const rect = range.getBoundingClientRect();
    this.quoteButtonEl.style.left = Math.min(Math.max(8, rect.left), window.innerWidth - 300) + 'px';
    this.quoteButtonEl.style.top = (rect.bottom + 8) + 'px';
    const height = this.quoteButtonEl.offsetHeight;
    if (rect.bottom + 8 + height > window.innerHeight - 8) {
      this.quoteButtonEl.style.top = Math.max(8, rect.top - height - 8) + 'px';
    }
  }

  /** Double-click a quoted chip to edit its annotation. */
  private editQuoteBubble(conversation: Conversation, index: number, anchorEl: HTMLElement): void {
    const quote = (conversation.quotes ?? [])[index];
    if (quote === undefined) return;
    this.renderQuoteBubbleBody(quote.text, quote.note, '保存注释', (note) => {
      this.host.updateQuote(conversation, index, note);
      new Notice('注释已更新');
    });
    this.quoteButtonEl.style.display = 'flex';
    const rect = anchorEl.getBoundingClientRect();
    this.quoteButtonEl.style.left = Math.min(Math.max(8, rect.left), window.innerWidth - 300) + 'px';
    this.quoteButtonEl.style.top = (rect.bottom + 8) + 'px';
    const height = this.quoteButtonEl.offsetHeight;
    if (rect.bottom + 8 + height > window.innerHeight - 8) {
      this.quoteButtonEl.style.top = Math.max(8, rect.top - height - 8) + 'px';
    }
  }

  private hideQuoteBubble(): void {
    if (this.quoteButtonEl === undefined) return;
    this.quoteButtonEl.empty();
    this.quoteButtonEl.removeClass('is-bubble');
    this.quoteButtonEl.dataset.mode = 'none';
    this.quoteButtonEl.style.display = 'none';
    this.quoteRange = null;
  }

  private submit(): void {
    let text = this.composerEl.value.trim();
    let conversation = this.host.getActiveConversation();
    if (conversation === null) {
      conversation = this.host.createConversation();
      this.host.activateConversation(conversation.id);
    }
    const hasContext = (conversation.attachments?.length ?? 0) > 0
      || (conversation.quotes?.length ?? 0) > 0
      || conversation.selection !== undefined
      || conversation.webContext !== undefined
      || conversation.webSelection !== undefined;
    if (text === '' && !hasContext) return;
    if (text === '') text = '请结合我附加的上下文回答';
    this.composerEl.value = '';
    const expanded = expandSlashCommand(text) ?? text;
    void this.host.sendOrQueue(conversation, expanded);
  }

  private render(): void {
    if (this.closed) return;
    const flags = this.host.getFeatureFlags();
    const signature = JSON.stringify(flags);
    if (signature !== this.flagsSignature) {
      // Feature switches changed: force a full rebuild so flag-gated UI
      // (footer buttons, badges) updates immediately.
      this.flagsSignature = signature;
      this.renderedMessages = [];
      this.clearConversationDomCache();
      this.chipsSignature = '';
    }
    this.featureFlags = flags;
    this.renderStatus();
    this.renderSidebar();
    this.renderAttachments();
    this.renderComposerState();
    this.renderChips();
    void this.renderMessages();
  }

  private renderStatus(force = false): void {
    if (this.closed) return;
    const snapshot = this.host.getBackendSnapshot();
    const conversation = this.host.getActiveConversation();
    const usage = conversation?.lastUsage;
    const ctx = usage !== undefined ? usage.inputTokens + usage.cacheReadTokens : 0;
    const windowTokens = this.host.getModelContextWindow();
    const ratio = Math.min(1, windowTokens > 0 ? ctx / windowTokens : 0);
    const percent = ratio * 100;
    const policy = this.host.getContextPolicy();
    const transfer = conversation?.contextTransfer;
    const maintenance = conversation?.contextMaintenance;
    const signature = JSON.stringify({
      backend: [snapshot.state, snapshot.detail],
      conversation: conversation === null ? null : [conversation.id, conversation.status],
      usage: usage === undefined ? null : [usage.inputTokens, usage.cacheReadTokens, usage.outputTokens, usage.time],
      windowTokens,
      autoCompactPercent: policy.autoCompactPercent,
      transfer: transfer === undefined ? null : [
        transfer.includedMessages,
        transfer.omittedMessages,
        transfer.truncatedMessages,
        transfer.preview,
      ],
      droppedMessageCount: conversation?.droppedMessageCount ?? 0,
      maintenance: maintenance === undefined ? null : [maintenance.kind, maintenance.percent, maintenance.time, maintenance.preview],
    });
    if (!force && signature === this.statusSignature) return;

    // Usage and child-agent events can arrive several times per second. Never
    // replace the hovered/focused popover beneath the pointer: doing so resets
    // :hover and its transition, which presents as continuous flickering.
    const currentMeter = this.statusEl.querySelector<HTMLElement>('.dsh-agent-context-meter');
    if (!force && currentMeter !== null
      && (currentMeter.matches(':hover') || currentMeter.contains(document.activeElement))) {
      const currentRing = currentMeter.querySelector<HTMLElement>('.dsh-agent-context-ring');
      currentRing?.style.setProperty('--dsh-ctx-angle', (ratio * 360).toFixed(2) + 'deg');
      if (currentRing !== null) {
        currentRing.dataset.level = percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : 'normal';
        currentRing.setAttr('aria-label', '上下文占用 ' + percent.toFixed(1) + '%');
      }
      this.statusRefreshPending = true;
      return;
    }

    this.statusSignature = signature;
    this.statusRefreshPending = false;
    this.statusEl.empty();
    const dot = this.statusEl.createSpan({ cls: 'dsh-agent-dot' });
    dot.dataset.state = snapshot.state;
    this.statusEl.appendText(
      snapshot.state === 'running' ? '运行中'
        : snapshot.state === 'starting' ? '启动中'
        : snapshot.state === 'error' ? '异常'
        : '已停止',
    );
    // Context usage ring (WebUI-style): always visible for the active
    // conversation, filled proportionally to the model's context window.
    if (conversation !== null) {
      if (conversation.status === 'preparing') {
        this.statusEl.appendText(' · 正在准备文件改动追踪…');
      }
      const fmt = (value: number): string => value >= 1000 ? (value / 1000).toFixed(1) + 'k' : String(value);
      const meter = this.statusEl.createSpan({ cls: 'dsh-agent-context-meter' });
      const ring = meter.createSpan({ cls: 'dsh-agent-context-ring' });
      // Avoid CSS typed multiplication (var * deg), which is unsupported in
      // some Obsidian Electron builds and made the conic fill disappear.
      ring.style.setProperty('--dsh-ctx-angle', (ratio * 360).toFixed(2) + 'deg');
      ring.dataset.level = percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : 'normal';
      ring.tabIndex = 0;
      ring.setAttr('role', 'button');
      ring.setAttr('aria-haspopup', 'dialog');
      ring.setAttr('aria-label', '上下文占用 ' + percent.toFixed(1) + '%');
      const popup = meter.createSpan({ cls: 'dsh-agent-context-popover' });
      popup.setAttr('role', 'dialog');
      popup.setAttr('aria-label', '上下文使用情况');
      popup.addEventListener('pointerdown', (event) => event.stopPropagation());
      popup.addEventListener('click', (event) => event.stopPropagation());
      const refreshAfterInteraction = (): void => {
        window.setTimeout(() => {
          if (!this.statusRefreshPending) return;
          if (meter.matches(':hover') || meter.contains(document.activeElement)) return;
          this.renderStatus(true);
        }, 0);
      };
      meter.addEventListener('pointerleave', refreshAfterInteraction);
      meter.addEventListener('focusout', refreshAfterInteraction);
      popup.createSpan({ cls: 'dsh-agent-context-popover-title', text: '上下文使用情况' });
      const details = popup.createSpan({ cls: 'dsh-agent-context-popover-grid' });
      const row = (label: string, value: string): void => {
        details.createSpan({ cls: 'dsh-agent-context-popover-label', text: label });
        details.createSpan({ cls: 'dsh-agent-context-popover-value', text: value });
      };
      row('已使用', fmt(ctx) + ' tokens（' + percent.toFixed(1) + '%）');
      row('输入', fmt(usage?.inputTokens ?? 0) + ' tokens');
      row('缓存读取', fmt(usage?.cacheReadTokens ?? 0) + ' tokens');
      row('本轮输出', fmt(usage?.outputTokens ?? 0) + ' tokens');
      row('上下文窗口', fmt(windowTokens) + ' tokens');
      row('自动压缩', policy.autoCompactPercent > 0 ? policy.autoCompactPercent + '% 触发' : '已关闭');
      if (transfer !== undefined) {
        row('新会话转移', '保留 ' + transfer.includedMessages + ' 条 · 省略 ' + transfer.omittedMessages + ' 条 · 截断 ' + transfer.truncatedMessages + ' 条');
        if (transfer.preview !== '') {
          const preview = popup.createEl('details', { cls: 'dsh-agent-context-preview' });
          preview.createEl('summary', { text: '查看转移摘要' });
          preview.createEl('pre', { text: transfer.preview });
        }
      }
      if ((conversation.droppedMessageCount ?? 0) > 0) {
        row('本地历史上限', '最早 ' + conversation.droppedMessageCount + ' 条消息已从活动会话移除');
      }
      if (maintenance !== undefined) {
        const notice = popup.createDiv({ cls: 'dsh-agent-context-notice' });
        notice.setText(maintenance.preview ?? (maintenance.kind === 'warning' ? '上下文占用较高。' : '已执行上下文维护。'));
      }
      const compact = popup.createEl('button', { cls: 'dsh-agent-btn dsh-agent-context-compact', text: '立即压缩上下文' });
      compact.disabled = conversation.status === 'preparing' || conversation.status === 'streaming';
      compact.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.host.requestCompaction(conversation);
      };
    }
    if (snapshot.detail !== '') {
      this.statusEl.setAttr('aria-label', snapshot.detail);
      dot.setAttr('title', snapshot.detail);
    }
  }

  private renderSidebar(): void {
    const conversations = this.host.getConversations()
      .filter((c) => c.closed !== true)
      .sort((a, b) => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0));
    const activeId = this.host.getActiveConversation()?.id;
    const signature = JSON.stringify({
      hidden: this.stripHidden,
      activeId,
      conversations: conversations.map((conversation) => [
        conversation.id,
        conversation.title,
        conversation.status,
        conversation.pinned === true,
        this.expandedIds.has(conversation.id),
      ]),
    });
    if (signature === this.sidebarSignature) return;
    this.sidebarSignature = signature;
    this.listEl.toggleClass('is-hidden', this.stripHidden);
    this.listEl.empty();
    if (this.stripHidden) return;
    for (let i = 0; i < conversations.length; i++) {
      const conversation = conversations[i];
      const expanded = this.expandedIds.has(conversation.id);
      const chip = this.listEl.createEl('button', {
        cls: 'dsh-agent-conversation' + (conversation.id === activeId ? ' is-active' : '') + (expanded ? ' is-expanded' : ''),
        attr: { type: 'button' },
      });
      chip.setAttr('title', conversation.title);
      if (expanded) {
        if (conversation.status === 'preparing' || conversation.status === 'streaming') {
          const state = chip.createSpan({ cls: 'dsh-agent-conversation-state' });
          const icon = state.createSpan();
          setIcon(icon, 'loader-circle');
          icon.addClass('dsh-spin');
        } else if (conversation.status === 'disconnected') {
          chip.createSpan({ cls: 'dsh-agent-conversation-state', text: '⚠' });
        }
        const label = chip.createSpan({ cls: 'dsh-agent-conversation-label' });
        label.setText(conversation.title);
      } else {
        if (conversation.status === 'preparing' || conversation.status === 'streaming') {
          const state = chip.createSpan({ cls: 'dsh-agent-conversation-state' });
          const icon = state.createSpan();
          setIcon(icon, 'loader-circle');
          icon.addClass('dsh-spin');
        }
        if (conversation.pinned === true) {
          const pinIcon = chip.createSpan({ cls: 'dsh-agent-conversation-pin' });
          setIcon(pinIcon, 'pin');
        }
        const number = chip.createSpan({ cls: 'dsh-agent-conversation-number' });
        number.setText(String(i + 1));
      }
      // Pointer-down fires before a high-frequency stream render can replace
      // this node between mouse-down and mouse-up. Keep click for keyboard use.
      chip.onpointerdown = (event) => {
        if (event.button === 0) this.host.activateConversation(conversation.id);
      };
      chip.onclick = (event) => {
        if (event.detail === 0) this.host.activateConversation(conversation.id);
      };
      chip.ondblclick = () => {
        if (this.expandedIds.has(conversation.id)) this.expandedIds.delete(conversation.id);
        else this.expandedIds.add(conversation.id);
        this.renderSidebar();
      };
      chip.oncontextmenu = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (conversation.messages.length === 0) {
          this.host.removeConversation(conversation.id);
        } else {
          this.host.setConversationClosed(conversation.id, true);
        }
      };
    }
    const newChip = this.listEl.createEl('button', { cls: 'dsh-agent-btn dsh-agent-conversation-new' });
    const newIcon = newChip.createSpan();
    setIcon(newIcon, 'plus');
    newChip.createSpan({ text: '新会话' });
    newChip.setAttr('aria-label', '新建会话');
    newChip.onclick = () => {
      const conversation = this.host.createConversation();
      this.host.activateConversation(conversation.id);
    };
    this.listEl.oncontextmenu = (event) => {
      if ((event.target as HTMLElement).closest('.dsh-agent-conversation') !== null) return;
      event.preventDefault();
      this.stripHidden = true;
      this.renderSidebar();
    };
  }

  private toggleHistoryPanel(): void {
    if (this.historyOpen) {
      this.closeHistoryPanel();
      return;
    }
    this.historyOpen = true;
    this.renderHistoryPanel();
  }

  /** Build the history panel body (re-renderable after deletions). */
  private renderHistoryPanel(): void {
    this.panelEl.empty();
    this.panelEl.addClass('is-open');
    const panel = this.panelEl.createDiv({ cls: 'dsh-agent-history-panel' });
    const header = panel.createDiv({ cls: 'dsh-agent-history-header' });
    header.createSpan({ text: '历史对话' });
    const closeButton = header.createEl('button', { cls: 'dsh-agent-quote-close' });
    setIcon(closeButton, 'x');
    closeButton.setAttr('aria-label', '关闭');
    closeButton.onclick = () => this.closeHistoryPanel();

    const search = panel.createEl('input', {
      cls: 'dsh-agent-settings-search',
      attr: { type: 'search', placeholder: '搜索标题或会话内容…' },
    });
    const list = panel.createDiv({ cls: 'dsh-agent-history-list' });
    const activeId = this.host.getActiveConversation()?.id;

    const renderList = (): void => {
      const q = search.value.trim().toLowerCase();
      const matches = (conversation: Conversation): boolean => {
        if (q === '') return true;
        if (conversation.title.toLowerCase().includes(q)) return true;
        return conversation.messages.some((msg) => msg.text.toLowerCase().includes(q));
      };
      const conversations = this.host.getConversations()
        .filter((c) => c.messages.length > 0)
        .filter(matches)
        .sort(compareConversationsByRecent);
      list.empty();
      if (conversations.length === 0) {
        list.createDiv({ cls: 'dsh-agent-inline-empty', text: q === '' ? '还没有历史对话' : '无匹配会话' });
        return;
      }
      for (let i = 0; i < conversations.length; i++) {
        const conversation = conversations[i];
        const row = list.createDiv({
          cls: 'dsh-agent-history-item'
            + (conversation.id === activeId ? ' is-active' : '')
            + (conversation.closed === true ? ' is-closed' : ''),
        });
        row.createSpan({ cls: 'dsh-agent-history-index', text: String(i + 1) });
        if (conversation.status === 'preparing' || conversation.status === 'streaming') {
          const state = row.createSpan({ cls: 'dsh-agent-history-state' });
          const icon = state.createSpan();
          setIcon(icon, 'loader-circle');
          icon.addClass('dsh-spin');
        }
        row.createSpan({ cls: 'dsh-agent-history-title', text: conversation.title });
        if (conversation.closed === true) {
          row.createSpan({ cls: 'dsh-agent-history-closed', text: '已关闭' });
        }
        const pin = row.createSpan({ cls: 'dsh-agent-history-pin' + (conversation.pinned === true ? ' is-pinned' : '') });
        setIcon(pin, conversation.pinned === true ? 'pin' : 'pin-off');
        pin.setAttr('aria-label', conversation.pinned === true ? '取消置顶' : '置顶');
        pin.onclick = (event) => {
          event.stopPropagation();
          this.host.setConversationPinned(conversation.id, conversation.pinned !== true);
          renderList();
        };
        const del = row.createSpan({ cls: 'dsh-agent-history-remove', text: '✕' });
        del.setAttr('aria-label', '删除会话');
        row.onclick = () => {
          this.host.setConversationClosed(conversation.id, false);
          this.host.activateConversation(conversation.id);
          this.stripHidden = false;
          this.renderSidebar();
          this.closeHistoryPanel();
        };
        del.onclick = (event) => {
          event.stopPropagation();
          void this.host.confirmRestart('将会话移入插件回收区，并把原始会话日志移入内部回收区。聊天内容可以从历史面板底部恢复。是否继续？').then((confirmed) => {
            if (!confirmed) return;
            this.host.removeConversation(conversation.id);
            renderList();
          });
        };
      }
    };
    search.addEventListener('input', () => renderList());
    renderList();

    const footer = panel.createDiv({ cls: 'dsh-agent-history-footer' });
    const newButton = footer.createEl('button', { cls: 'dsh-agent-btn', text: '+ 新建会话' });
    newButton.onclick = () => {
      const conversation = this.host.createConversation();
      this.host.activateConversation(conversation.id);
      this.stripHidden = false;
      this.renderSidebar();
      this.closeHistoryPanel();
    };
    if (this.host.getDeletedConversationCount() > 0) {
      const restore = footer.createEl('button', { cls: 'dsh-agent-btn', text: '恢复最近删除（' + this.host.getDeletedConversationCount() + '）' });
      restore.onclick = () => {
        const conversation = this.host.restoreLastDeletedConversation();
        if (conversation === undefined) return;
        this.stripHidden = false;
        this.renderSidebar();
        this.closeHistoryPanel();
        new Notice('已恢复会话「' + conversation.title + '」');
      };
    }
  }

  private closeHistoryPanel(): void {
    this.historyOpen = false;
    this.panelEl.empty();
    this.panelEl.removeClass('is-open');
  }

  private renderAttachments(): void {
    this.attachmentEl.empty();
    const conversation = this.host.getActiveConversation();
    const attachments = conversation?.attachments ?? [];
    const contextSelections: { attachment: SelectionAttachment; kind: 'note' | 'web-context' | 'web-selection' }[] = [];
    if (conversation?.selection !== undefined) contextSelections.push({ attachment: conversation.selection, kind: 'note' });
    if (conversation?.webContext !== undefined) contextSelections.push({ attachment: conversation.webContext, kind: 'web-context' });
    if (conversation?.webSelection !== undefined) contextSelections.push({ attachment: conversation.webSelection, kind: 'web-selection' });
    const quotes = conversation?.quotes ?? [];
    if (attachments.length === 0 && contextSelections.length === 0 && quotes.length === 0) {
      this.attachmentEl.removeClass('has-items');
      return;
    }
    this.attachmentEl.addClass('has-items');
    for (const { attachment: selection, kind } of contextSelections) {
      const chip = this.attachmentEl.createDiv({ cls: 'dsh-agent-attachment-chip is-selection' });
      const icon = chip.createSpan();
      setIcon(icon, selection.sourceKind === 'web' ? 'globe-2' : 'text-cursor-input');
      chip.createSpan({ cls: 'dsh-agent-attachment-name', text: selectionLabel(selection) });
      if (selection.sourceKind === 'web') {
        chip.setAttr('title', [
          selection.sourceUrl ?? '',
          selection.webMode === 'selection' ? '已附加网页选区；网页正文作为独立上下文同时保留' : '已附加网页正文上下文',
          selection.truncated === true || selection.contextTruncated === true ? '部分内容因长度限制已截断' : '',
        ].filter((entry) => entry !== '').join('\n'));
      }
      const remove = chip.createSpan({ cls: 'dsh-agent-attachment-remove', text: '✕' });
      remove.onclick = () => {
        if (conversation !== null) this.host.clearSelection(kind);
      };
    }
    for (let i = 0; i < quotes.length; i++) {
      const quote = quotes[i];
      const chip = this.attachmentEl.createDiv({ cls: 'dsh-agent-attachment-chip is-quote' });
      const icon = chip.createSpan();
      setIcon(icon, 'quote');
      const text = quote.text.trim();
      const short = text.length > 40 ? text.slice(0, 40) + '…' : text;
      chip.createSpan({ cls: 'dsh-agent-attachment-name', text: short });
      chip.setAttr('title', (quote.note.trim() !== '' ? text + '\n\n注释: ' + quote.note : text) + '\n\n双击编辑注释');
      chip.ondblclick = () => {
        if (conversation !== null) this.editQuoteBubble(conversation, i, chip);
      };
      const remove = chip.createSpan({ cls: 'dsh-agent-attachment-remove', text: '✕' });
      remove.onclick = () => {
        if (conversation !== null) this.host.removeQuote(conversation, i);
      };
      remove.ondblclick = (event) => {
        event.stopPropagation();
      };
    }
    for (const attachment of attachments) {
      const kind = attachment.kind ?? 'note';
      const chip = this.attachmentEl.createDiv({ cls: 'dsh-agent-attachment-chip is-' + kind });
      const icon = chip.createSpan();
      setIcon(icon, kind === 'pdf' ? 'file-type-2' : kind === 'image' ? 'image' : kind === 'file' ? 'file' : 'file-text');
      chip.createSpan({ cls: 'dsh-agent-attachment-name', text: attachment.name });
      const range = attachment.range;
      if (range !== undefined) {
        const unit = range.kind === 'pages' ? '页' : '段';
        chip.createSpan({ cls: 'dsh-agent-attachment-range', text: range.start + '–' + range.end + unit });
      }
      const extraction = attachment.extraction;
      if (extraction !== undefined) {
        chip.createSpan({
          cls: 'dsh-agent-attachment-state',
          text: extraction === 'text-extracted' ? '已提取'
            : extraction === 'text-truncated' ? '部分提取'
              : extraction === 'mineru-fallback' ? 'MinerU 回退'
                : extraction === 'vision-fallback' ? '视觉回退' : '路径',
        });
      }
      chip.setAttr('title', attachment.uri
        + ((kind === 'pdf' || kind === 'text' || kind === 'note') ? '\n双击设置页码/段落范围' : ''));
      if (kind === 'pdf' || kind === 'text' || kind === 'note') {
        chip.ondblclick = () => {
          if (conversation !== null) this.editAttachmentRange(conversation, attachment, chip);
        };
      }
      const remove = chip.createSpan({ cls: 'dsh-agent-attachment-remove', text: '✕' });
      remove.onclick = () => {
        if (conversation !== null) this.host.removeAttachment(conversation, attachment.uri);
      };
      remove.ondblclick = (event) => event.stopPropagation();
    }
  }

  private editAttachmentRange(conversation: Conversation, attachment: NoteAttachment, anchor: HTMLElement): void {
    this.panelEl.empty();
    this.panelEl.addClass('is-open');
    this.positionInlinePanel();
    const editor = this.panelEl.createDiv({ cls: 'dsh-agent-range-editor' });
    const kind = attachment.kind === 'pdf' ? 'pages' : 'paragraphs';
    editor.createDiv({ cls: 'dsh-agent-range-title', text: kind === 'pages' ? 'PDF 页码范围' : '文本段落范围' });
    editor.createDiv({ cls: 'dsh-agent-range-path', text: attachment.uri });
    const inputs = editor.createDiv({ cls: 'dsh-agent-range-inputs' });
    const start = inputs.createEl('input', { attr: { type: 'number', min: '1', placeholder: '开始' } });
    const end = inputs.createEl('input', { attr: { type: 'number', min: '1', placeholder: '结束' } });
    if (attachment.range?.kind === kind) {
      start.value = String(attachment.range.start);
      end.value = String(attachment.range.end);
    }
    const actions = editor.createDiv({ cls: 'dsh-agent-range-actions' });
    const clear = actions.createEl('button', { cls: 'dsh-agent-btn', text: '全部内容' });
    clear.onclick = () => {
      this.host.updateAttachmentRange(conversation, attachment.uri, undefined);
      this.panelEl.empty();
      this.panelEl.removeClass('is-open');
    };
    const save = actions.createEl('button', { cls: 'dsh-agent-btn mod-cta', text: '保存范围' });
    save.onclick = () => {
      const from = Math.max(1, Math.floor(Number(start.value)) || 1);
      const to = Math.max(from, Math.floor(Number(end.value)) || from);
      this.host.updateAttachmentRange(conversation, attachment.uri, { kind, start: from, end: to });
      this.panelEl.empty();
      this.panelEl.removeClass('is-open');
    };
    const rect = anchor.getBoundingClientRect();
    editor.setAttr('data-anchor-left', String(Math.round(rect.left)));
    start.focus();
  }

  private renderComposerState(): void {
    const conversation = this.host.getActiveConversation();
    const streaming = conversation !== null && conversation.status === 'streaming';
    // The composer stays writable while streaming: sending either interrupts
    // or queues (per the queuePolicy setting).
    this.stopButtonEl.style.display = streaming ? '' : 'none';
  }

  private async renderMessages(): Promise<void> {
    if (this.closed) return;
    const activeConversation = this.host.getActiveConversation();
    const activeId = activeConversation?.id ?? null;
    if (activeId !== this.renderedConversationId) {
      this.stashRenderedConversation();
      this.messageRenderGeneration += 1;
      this.clearTypewriter();
      this.renderedMessages = [];
      this.renderedConversationId = activeId;
      if (activeId === null) {
        this.messageEl.empty();
        this.renderWelcome();
      } else if (activeConversation !== null && !this.restoreRenderedConversation(activeConversation)) {
        this.messageEl.empty();
        this.renderConversationSwitchPlaceholder(activeConversation.title);
      }
    }
    const generation = this.messageRenderGeneration;
    if (this.rendering) {
      this.pendingRerender = true;
      return;
    }
    this.rendering = true;
    try {
      await this.renderMessagesInner(generation);
    } finally {
      this.rendering = false;
      if (!this.closed && this.pendingRerender) {
        this.pendingRerender = false;
        void this.renderMessages();
      }
    }
  }

  private async renderMessagesInner(generation: number): Promise<void> {
    if (this.closed || generation !== this.messageRenderGeneration) return;
    const conversation = this.host.getActiveConversation();
    if (conversation === null) {
      this.messageEl.empty();
      this.renderedMessages = [];
      this.renderedConversationId = null;
      this.renderWelcome();
      return;
    }
    if (this.renderedConversationId !== conversation.id) {
      this.clearTypewriter();
      this.renderedMessages = [];
      this.renderedConversationId = conversation.id;
    }
    const messages = conversation.messages;
    if (messages.length > 0
      && this.renderedMessages.length === messages.length
      && this.renderedMessages[messages.length - 1].id === messages[messages.length - 1].id) {
      const indexes = new Set<number>([messages.length - 1]);
      const assistantIndex = latestAssistantMessageIndex(conversation);
      if (assistantIndex !== -1) indexes.add(assistantIndex);
      for (const index of indexes) {
        await this.updateMessage(conversation, messages[index], index, generation);
        if (!this.isCurrentMessageRender(generation, conversation.id)) return;
      }
      return;
    }
    // Ordinary sends only extend the transcript. Preserve every existing DOM
    // node and append the new user/assistant messages instead of replaying all
    // historical Markdown from the top.
    if (this.renderedMessages.length > 0
      && this.renderedMessages.length < messages.length
      && isMessageIdPrefix(this.renderedMessages, messages)) {
      const renderedCount = this.renderedMessages.length;
      const branchBanner = this.messageEl.querySelector<HTMLElement>('.dsh-agent-branch-banner');
      branchBanner?.remove();
      const assistantIndex = latestAssistantMessageIndex(conversation);
      if (assistantIndex >= 0 && assistantIndex < renderedCount) {
        await this.updateMessage(conversation, messages[assistantIndex], assistantIndex, generation);
        if (!this.isCurrentMessageRender(generation, conversation.id)) return;
      }
      for (let index = renderedCount; index < messages.length; index++) {
        if (!this.isCurrentMessageRender(generation, conversation.id)) return;
        await this.appendMessageEl(conversation, messages[index], generation);
      }
      if (!this.isCurrentMessageRender(generation, conversation.id)) return;
      this.renderBranchBanner(this.messageEl, conversation);
      if (this.stickToBottom) this.scrollToBottom();
      return;
    }
    // Rewind/truncation: drop only the surplus DOM nodes — rebuilding the
    // whole list would replay entrance animations and flicker.
    if (messages.length > 0
      && this.renderedMessages.length > messages.length
      && this.renderedMessages[messages.length - 1].id === messages[messages.length - 1].id) {
      const elements = this.messageEl.querySelectorAll<HTMLElement>('.dsh-agent-message');
      for (let i = messages.length; i < elements.length; i++) {
        elements[i].remove();
      }
      this.renderedMessages = this.renderedMessages.slice(0, messages.length);
      if (this.stickToBottom) this.scrollToBottom();
      return;
    }
    if (messages.length === 0) {
      this.messageEl.empty();
      this.renderedMessages = [];
      this.renderWelcome();
      return;
    }
    // Conversation switches and non-prefix mutations render off-screen. A
    // single atomic swap prevents the history from flashing top-to-bottom.
    const staging = document.createElement('div');
    for (const message of messages) {
      if (!this.isCurrentMessageRender(generation, conversation.id)) return;
      await this.appendMessageEl(conversation, message, generation, staging, false);
    }
    if (!this.isCurrentMessageRender(generation, conversation.id)) return;
    this.renderBranchBanner(staging, conversation);
    this.messageEl.replaceChildren(...Array.from(staging.childNodes));
    this.renderedMessages = [...messages];
    this.scrollToBottom();
  }

  private renderBranchBanner(parent: HTMLElement, conversation: Conversation): void {
    if (conversation.branchedFrom === undefined) return;
    const banner = parent.createDiv({ cls: 'dsh-agent-branch-banner' });
    const icon = banner.createSpan();
    setIcon(icon, 'git-branch');
    const from = this.host.getConversations().find((entry) => entry.id === conversation.branchedFrom);
    banner.createSpan({ text: ' 分支自「' + (from?.title ?? '已删除的会话') + '」' });
  }

  private isCurrentMessageRender(generation: number, conversationId: string): boolean {
    return !this.closed
      && generation === this.messageRenderGeneration
      && this.host.getActiveConversation()?.id === conversationId;
  }

  private renderWelcome(): void {
    const welcome = this.messageEl.createDiv({ cls: 'dsh-agent-welcome' });
    welcome.createEl('div', { cls: 'dsh-agent-welcome-title', text: 'DeepSeek Harness Agent' });
    welcome.createEl('div', { cls: 'dsh-agent-welcome-sub', text: '你的笔记库就是智能体的工作区：读写笔记、搜索、执行命令、多步任务。' });
    const hints = welcome.createEl('ul', { cls: 'dsh-agent-welcome-hints' });
    hints.createEl('li', { text: 'Enter 发送，Shift+Enter 换行' });
    hints.createEl('li', { text: '📎 附加当前笔记作为上下文' });
    hints.createEl('li', { text: '/ 打开命令与技能菜单；也可直接输入 /技能名 调用（如 /agent-reach）' });
    hints.createEl('li', { text: '进行中可点停止按钮或按 Esc 结束' });
  }

  private renderConversationSwitchPlaceholder(title: string): void {
    const placeholder = this.messageEl.createDiv({ cls: 'dsh-agent-conversation-switching' });
    const heading = placeholder.createDiv({ cls: 'dsh-agent-conversation-switching-heading' });
    const icon = heading.createSpan();
    setIcon(icon, 'loader-circle');
    icon.addClass('dsh-spin');
    heading.createSpan({ text: '正在打开「' + title + '」' });
    for (let index = 0; index < 3; index++) {
      const skeleton = placeholder.createDiv({ cls: 'dsh-agent-conversation-switching-row' });
      skeleton.style.setProperty('--dsh-switch-row-width', (88 - index * 13) + '%');
    }
  }

  private stashRenderedConversation(): void {
    const id = this.renderedConversationId;
    if (id === null || this.renderedMessages.length === 0 || this.messageEl.childNodes.length === 0) return;
    // An incremental append creates its wrapper before async Markdown settles.
    // Never cache that half-rendered DOM; the next visit will rebuild atomically.
    if (this.messageEl.querySelectorAll('.dsh-agent-message').length !== this.renderedMessages.length) return;
    const conversation = this.host.getConversations().find(
      (entry) => entry.id === id && entry.closed !== true,
    );
    if (conversation === undefined) return;
    const holder = document.createElement('div');
    holder.replaceChildren(...Array.from(this.messageEl.childNodes));
    this.conversationDomCache.delete(id);
    this.conversationDomCache.set(id, {
      holder,
      renderedMessages: [...this.renderedMessages],
      scrollTop: this.messageEl.scrollTop,
      stickToBottom: this.stickToBottom,
    });
    while (this.conversationDomCache.size > CONVERSATION_DOM_CACHE_LIMIT) {
      const oldestId = this.conversationDomCache.keys().next().value as string | undefined;
      if (oldestId === undefined) break;
      this.conversationDomCache.get(oldestId)?.holder.replaceChildren();
      this.conversationDomCache.delete(oldestId);
    }
  }

  private restoreRenderedConversation(conversation: Conversation): boolean {
    const cached = this.conversationDomCache.get(conversation.id);
    if (cached === undefined) return false;
    this.conversationDomCache.delete(conversation.id);
    if (!canReuseRenderedMessageDom(cached.renderedMessages, conversation.messages)) {
      cached.holder.replaceChildren();
      return false;
    }
    this.messageEl.replaceChildren(...Array.from(cached.holder.childNodes));
    this.renderedMessages = [...cached.renderedMessages];
    this.stickToBottom = cached.stickToBottom;
    if (cached.stickToBottom) this.scrollToBottom();
    else this.messageEl.scrollTop = cached.scrollTop;
    return true;
  }

  private clearConversationDomCache(): void {
    for (const cached of this.conversationDomCache.values()) cached.holder.replaceChildren();
    this.conversationDomCache.clear();
  }

  /** Most recent assistant message owns the live turn, even after users queue input. */
  private isStreamingAssistant(conversation: Conversation, message: ChatMessage): boolean {
    if (conversation.status !== 'streaming') return false;
    const index = latestAssistantMessageIndex(conversation);
    return index !== -1 && conversation.messages[index] === message;
  }

  private async updateMessage(
    conversation: Conversation,
    message: ChatMessage,
    messageIndex: number,
    generation: number,
  ): Promise<void> {
    const elements = this.messageEl.querySelectorAll<HTMLElement>('.dsh-agent-message');
    const last = elements[messageIndex];
    if (last === undefined) {
      this.renderedMessages = [];
      this.pendingRerender = true;
      return;
    }
    const streamingForMessage = this.isStreamingAssistant(conversation, message);
    const deferredTypewriterText = !streamingForMessage
      && this.typewriter.messageId === message.id
      && this.typewriter.targetText !== ''
      ? this.typewriter.targetText
      : undefined;
    // Timeline blocks: rebuild whenever the block stream changed (new events or
    // in-place status updates).
    const blocksEl = last.querySelector<HTMLElement>('.dsh-agent-blocks');
    if (blocksEl !== null) {
      const signature = this.blocksSignature(message);
      if (last.dataset.blocksSignature !== signature) {
        // Build the new block list off-dom and swap it in atomically. Emptying
        // the live container first collapses the message height, which clamps
        // the scroller upwards (the "jumps to top" bug) during async renders.
        const prevCount = Number(last.dataset.renderedBlockCount ?? '0');
        const fresh = document.createElement('div');
        fresh.addClass('dsh-agent-blocks');
        await this.renderBlocksInto(fresh, message, prevCount, deferredTypewriterText);
        if (!this.isCurrentMessageRender(generation, conversation.id)) return;
        if (deferredTypewriterText !== undefined) {
          const stream = fresh.createDiv({ cls: 'dsh-agent-streaming-text' });
          const shown = deferredTypewriterText.slice(0, this.typewriter.visibleChars);
          stream.dataset.text = shown;
          stream.setText(shown);
        }
        blocksEl.replaceWith(fresh);
        last.dataset.blocksSignature = signature;
        last.dataset.renderedBlockCount = String((message.blocks ?? []).length);
        if (this.stickToBottom) this.scrollToBottom();
      }
    }
    // Animated "thinking" line: visible for the whole streaming turn, removed
    // once the turn settles.
    const holder = last.querySelector<HTMLElement>('.dsh-agent-thinking-holder');
    const wantsLine = streamingForMessage && message.error === undefined;
    if (holder !== null) {
      const lineEl = holder.querySelector<HTMLElement>('.dsh-agent-thinking-line');
      if (lineEl === null && wantsLine) {
        this.renderThinkingLineInto(holder, message);
      } else if (lineEl !== null && wantsLine) {
        this.syncThinkingLine(holder, message);
      } else if (lineEl !== null && !wantsLine && !holder.hasClass('is-leaving')) {
        // Collapse the holder height + fade the line (smooth settle).
        holder.addClass('is-leaving');
        lineEl.addClass('is-leaving');
        setTimeout(() => {
          if (lineEl.parentElement !== null) holder.empty();
        }, 230);
      }
    } else if (wantsLine) {
      const newHolder = last.createDiv({ cls: 'dsh-agent-thinking-holder' });
      this.renderThinkingLineInto(newHolder, message);
    }
    // Badge (stop reason) syncs independently of the block stream.
    const badgeHolder = last.querySelector<HTMLElement>('.dsh-agent-message-badge-holder');
    if (badgeHolder !== null) {
      const existingBadge = badgeHolder.querySelector<HTMLElement>('.dsh-agent-message-badge');
      const hasBadge = existingBadge !== null;
      const wantsBadge = message.superseded === true
        || message.goalLoopGuardTriggered === true
        || (message.stopReason !== undefined && message.stopReason !== 'end_turn');
      const desiredBadgeText = message.goalLoopGuardTriggered === true
        ? '已自动暂停空转目标'
        : message.superseded === true
        ? '已由新尝试替代'
        : stopReasonLabel(message.stopReason ?? '');
      if (hasBadge !== wantsBadge || (wantsBadge && existingBadge?.textContent !== desiredBadgeText)) {
        badgeHolder.empty();
        if (wantsBadge) {
          const badge = badgeHolder.createDiv({
            cls: 'dsh-agent-message-badge',
            text: desiredBadgeText,
          });
          badge.dataset.reason = message.goalLoopGuardTriggered === true
            ? 'goal-idle-guard'
            : message.superseded === true ? 'superseded' : message.stopReason;
        }
      }
    }
    // Copy/branch footer: a hidden placeholder keeps the layout height
    // stable while streaming; it fades in once the reply settles.
    const footer = last.querySelector<HTMLElement>('.dsh-agent-message-footer');
    const streamingTail = streamingForMessage;
    const hasText = mergeMirroredStreamText(message.text, message.streamedText).trim() !== '';
    const hasFooterContent = hasText || message.error !== undefined;
    if (streamingTail) {
      if (footer === null && hasText) {
        this.buildMessageFooter(last, conversation, message).addClass('is-hidden');
      }
    } else if (footer !== null) {
      if (hasFooterContent) {
        footer.removeClass('is-hidden');
        footer.addClass('is-reveal');
        const retry = footer.querySelector<HTMLButtonElement>('[data-dsh-action="retry"]');
        const resume = footer.querySelector<HTMLButtonElement>('[data-dsh-action="continue"]');
        if (retry !== null) retry.style.display = message.error !== undefined && message.superseded !== true ? '' : 'none';
        if (resume !== null) {
          resume.style.display = message.superseded !== true
            && message.goalLoopGuardTriggered !== true
            && message.continued !== true && (message.error !== undefined
            || message.stopReason === 'max_tokens'
            || message.stopReason === 'cancelled') ? '' : 'none';
        }
        const regenerate = footer.querySelector<HTMLButtonElement>('[data-dsh-action="regenerate"]');
        if (regenerate !== null) regenerate.style.display = message.superseded === true ? 'none' : '';
      } else {
        footer.remove();
      }
    } else if (hasFooterContent) {
      this.buildMessageFooter(last, conversation, message);
    }
    // Typewriter: the ACP wire delivers whole committed chunks, so animate
    // the reveal character-by-character locally for a ChatGPT-like stream.
    // The streaming section lives INSIDE the blocks container (after the last
    // committed block) so tools land right after the text that preceded them.
    const blocksBox = last.querySelector<HTMLElement>('.dsh-agent-blocks');
    let streamHolder = blocksBox?.querySelector<HTMLElement>(':scope > .dsh-agent-streaming-text') ?? null;
    const streamingNow = streamingForMessage && message.error === undefined;
    if (streamingNow) {
      const tail = uncommittedStreamText(message);
      const trimmed = tail.trim();
      if (trimmed !== '') {
        if (streamHolder === null && blocksBox !== null) {
          streamHolder = blocksBox.createDiv({ cls: 'dsh-agent-streaming-text' });
        }
        if (streamHolder !== null) {
          if (this.featureFlags['ui.typewriter'] === false) {
            // Typewriter disabled: render the whole chunk directly.
            this.clearTypewriter();
            this.typewriterProgress.forgetMessage(message.id);
            streamHolder.dataset.text = trimmed;
            void this.renderMarkdownInto(streamHolder, trimmed, true);
          } else {
            const segmentKey = String(message.streamedTextCursor);
            if (this.typewriter.messageId !== message.id || this.typewriter.segmentKey !== segmentKey) {
              this.clearTypewriter();
              this.typewriter.messageId = message.id;
              this.typewriter.segmentKey = segmentKey;
              this.typewriter.visibleChars = this.typewriterProgress.restore(message.id, segmentKey, trimmed);
            }
            this.typewriter.targetText = trimmed;
            if (this.typewriter.timer === null) {
              // Render one frame at the current progress immediately, then tick.
              const shown = trimmed.slice(0, this.typewriter.visibleChars);
              streamHolder.dataset.text = shown;
              streamHolder.setText(shown);
              this.typewriter.timer = window.setTimeout(() => {
                this.typewriter.timer = null;
                this.tickTypewriter(message);
              }, TYPEWRITER_FRAME_INTERVAL_MS);
            }
          }
        }
      } else {
        if (this.typewriter.messageId === message.id) this.clearTypewriter();
        this.typewriterProgress.forgetMessage(message.id);
        if (streamHolder !== null) streamHolder.remove();
      }
    } else if (this.typewriter.messageId === message.id && this.typewriter.targetText !== '') {
      if (streamHolder === null && blocksBox !== null) {
        streamHolder = blocksBox.createDiv({ cls: 'dsh-agent-streaming-text' });
        const shown = this.typewriter.targetText.slice(0, this.typewriter.visibleChars);
        streamHolder.dataset.text = shown;
        streamHolder.setText(shown);
      }
      if (streamHolder !== null) {
        if (this.typewriter.visibleChars >= this.typewriter.targetText.length) {
          this.finishTypewriter(message, streamHolder);
        } else if (this.typewriter.timer === null) {
          this.typewriter.timer = window.setTimeout(() => {
            this.typewriter.timer = null;
            this.tickTypewriter(message);
          }, TYPEWRITER_FRAME_INTERVAL_MS);
        }
      }
    } else if (streamHolder !== null) {
      streamHolder.remove();
    }
    this.renderedMessages[messageIndex] = message;
    if (this.stickToBottom) this.scrollToBottom();
  }

  private syncToolCard(card: HTMLElement, activity: ToolActivity): void {
    card.toggleClass('is-running', activity.status === 'running');
    card.toggleClass('is-error', activity.status === 'error');
    card.toggleClass('is-done', activity.status === 'done');
    const statusEl = card.querySelector<HTMLElement>('.dsh-tool-status');
    if (statusEl !== null) {
      statusEl.setText(activity.status === 'running' ? '运行中' : activity.status === 'error' ? '失败' : '完成');
    }
  }

  private async renderMarkdownInto(container: HTMLElement, text: string, math = true): Promise<void> {
    container.empty();
    // Theme styles (inline code, tables, quotes, font weights) hang off the
    // .markdown-rendered scope — without this class the rendered content
    // falls back to plugin/global defaults and looks off vs. the vault.
    container.addClass('markdown-rendered');
    try {
      await MarkdownRenderer.render(this.host.getApp(), text, container, '', this);
    } catch {
      container.createDiv({ cls: 'dsh-agent-message-raw', text });
    }
    if (math) this.typesetMath(container);
    addCopyButtons(container);
  }

  /**
   * MarkdownRenderer leaves $...$ / $...$ as raw elements; typeset each
   * one with the active theme's MathJax so formulas look identical to the
   * rest of the vault.
   */
  private typesetMath(container: HTMLElement): void {
    const strip = (source: string): string => source.replace(/^\s*\$+|\$+\s*$/g, '');
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('.math-block'))) {
      const source = strip(el.textContent ?? '');
      if (source === '') continue;
      try {
        const rendered = renderMath(source, true);
        el.replaceWith(rendered);
      } catch {
        // keep the raw block
      }
    }
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('span.math'))) {
      const source = strip(el.textContent ?? '');
      if (source === '') continue;
      try {
        const rendered = renderMath(source, false);
        el.replaceWith(rendered);
      } catch {
        // keep the raw span
      }
    }
  }

  private async confirmRecoveryWithChanges(message: ChatMessage): Promise<boolean> {
    const outstanding = message.changeSet?.files.some((file) => file.reversible && !file.reverted) ?? false;
    if (!outstanding) return true;
    return this.host.confirmRestart('这次回答已经改动文件。重新生成会移除当前回答及其后续消息，改动不会自动撤销，改动卡片也会随回答移除；如需还原，请先使用“撤销本轮文件改动”。是否继续？');
  }

  private buildMessageFooter(wrapper: HTMLElement, conversation: Conversation, message: ChatMessage): HTMLElement {
    const footer = wrapper.createDiv({ cls: 'dsh-agent-message-footer' });
    const copyButton = footer.createEl('button', { cls: 'dsh-agent-action-btn' });
    setIcon(copyButton, 'copy');
    copyButton.setAttr('aria-label', message.role === 'user' ? '复制消息' : '复制回答');
    copyButton.onclick = () => {
      void navigator.clipboard.writeText(message.text).then(() => {
        setIcon(copyButton, 'check');
        setTimeout(() => setIcon(copyButton, 'copy'), 1200);
      }).catch(() => {
        new Notice('复制失败');
      });
    };
    if (message.role === 'assistant') {
      const recoveryButtons: HTMLButtonElement[] = [];
      const setRecoveryLocked = (locked: boolean): void => {
        for (const button of recoveryButtons) button.disabled = locked;
      };
      const runRecovery = async (
        action: () => Promise<boolean>,
        failureMessage: string,
        confirmChanges: boolean,
      ): Promise<void> => {
        if (recoveryButtons.some((button) => button.disabled)) return;
        setRecoveryLocked(true);
        try {
          if (confirmChanges && !(await this.confirmRecoveryWithChanges(message))) {
            setRecoveryLocked(false);
            return;
          }
          const ok = await action();
          if (!ok) {
            setRecoveryLocked(false);
            new Notice(failureMessage);
          }
        } catch {
          setRecoveryLocked(false);
          new Notice(failureMessage);
        }
      };
      const regenerateButton = footer.createEl('button', { cls: 'dsh-agent-action-btn' });
      recoveryButtons.push(regenerateButton);
      regenerateButton.dataset.dshAction = 'regenerate';
      setIcon(regenerateButton, 'refresh-cw');
      regenerateButton.setAttr('aria-label', '重新生成回答');
      regenerateButton.style.display = message.superseded === true ? 'none' : '';
      regenerateButton.onclick = () => {
        void runRecovery(
          () => this.host.regenerateAssistant(conversation, message.id),
          '当前回复尚未结束，暂时不能重新生成',
          true,
        );
      };
      const retryButton = footer.createEl('button', { cls: 'dsh-agent-action-btn' });
      recoveryButtons.push(retryButton);
      retryButton.dataset.dshAction = 'retry';
      setIcon(retryButton, 'rotate-ccw');
      retryButton.setAttr('aria-label', '重试失败请求');
      retryButton.style.display = message.error !== undefined && message.superseded !== true ? '' : 'none';
      retryButton.onclick = () => {
        void runRecovery(
          () => this.host.retryAssistant(conversation, message.id),
          '当前请求暂时不能重试',
          true,
        );
      };
      const continueButton = footer.createEl('button', { cls: 'dsh-agent-action-btn' });
      recoveryButtons.push(continueButton);
      continueButton.dataset.dshAction = 'continue';
      setIcon(continueButton, 'step-forward');
      continueButton.setAttr('aria-label', '从中断处继续');
      continueButton.style.display = message.superseded !== true && message.continued !== true && (message.error !== undefined
        || message.stopReason === 'max_tokens'
        || message.stopReason === 'cancelled') ? '' : 'none';
      continueButton.onclick = () => {
        void runRecovery(
          () => this.host.continueAssistant(conversation, message.id),
          '当前回复尚未结束，暂时不能继续',
          false,
        );
      };
      if (this.featureFlags['ui.branch'] !== false) {
        const branchButton = footer.createEl('button', { cls: 'dsh-agent-action-btn' });
        setIcon(branchButton, 'git-branch');
        branchButton.setAttr('aria-label', '从此处分支新会话');
        branchButton.onclick = () => {
          this.host.branchConversation(conversation, message.id);
        };
      }
    } else {
      if (this.featureFlags['ui.rewind'] !== false) {
        const rewindButton = footer.createEl('button', { cls: 'dsh-agent-action-btn' });
        setIcon(rewindButton, 'undo-2');
        rewindButton.setAttr('aria-label', '回退:移除这条输入及其后的所有内容');
        rewindButton.onclick = () => {
          const removedText = this.host.rewindConversation(conversation, message.id);
          if (removedText !== undefined && removedText.trim() !== '') {
            this.composerEl.value = removedText;
            this.composerEl.focus();
          }
          new Notice('已回退:该输入及其后的内容已移除,重开后将从新的会话上下文继续');
        };
      }
    }
    return footer;
  }

  private async appendMessageEl(
    conversation: Conversation,
    message: ChatMessage,
    generation: number,
    parent: HTMLElement = this.messageEl,
    track = true,
  ): Promise<void> {
    const wrapper = parent.createDiv({
      cls: 'dsh-agent-message' + (message.role === 'user' ? ' is-user' : ' is-assistant'),
    });
    wrapper.dataset.messageId = message.id;
    wrapper.dataset.renderedTools = '0';

    if (message.role === 'assistant') {
      const blocksEl = wrapper.createDiv({ cls: 'dsh-agent-blocks' });
      // A terminal error augments the partial reasoning/tool timeline instead
      // of replacing it, so useful work remains visible after stream failure.
      await this.renderBlocksInto(blocksEl, message, Number.MAX_SAFE_INTEGER);
      if (!this.isCurrentMessageRender(generation, conversation.id)) {
        wrapper.remove();
        return;
      }
      wrapper.dataset.blocksSignature = this.blocksSignature(message);
      wrapper.dataset.renderedBlockCount = String((message.blocks ?? []).length);
      const thinkingHolder = wrapper.createDiv({ cls: 'dsh-agent-thinking-holder' });
      const streamingTailAtAppend = this.isStreamingAssistant(conversation, message);
      if (streamingTailAtAppend && message.error === undefined) {
        this.renderThinkingLineInto(thinkingHolder, message);
      }
      const badgeEl = wrapper.createDiv({ cls: 'dsh-agent-message-badge-holder' });
      if (message.goalLoopGuardTriggered === true) {
        const badge = badgeEl.createDiv({ cls: 'dsh-agent-message-badge', text: '已自动暂停空转目标' });
        badge.dataset.reason = 'goal-idle-guard';
      } else if (message.stopReason !== undefined && message.stopReason !== 'end_turn') {
        const badge = badgeEl.createDiv({ cls: 'dsh-agent-message-badge', text: stopReasonLabel(message.stopReason) });
        badge.dataset.reason = message.stopReason;
      } else if (message.superseded === true) {
        const badge = badgeEl.createDiv({ cls: 'dsh-agent-message-badge', text: '已由新尝试替代' });
        badge.dataset.reason = 'superseded';
      }
      // Copy/branch actions: a hidden placeholder during streaming keeps
      // the layout stable, then fades in on settle.
      const isStreamingTail = this.isStreamingAssistant(conversation, message);
      if (message.text.trim() !== '' || message.error !== undefined) {
        const footer = this.buildMessageFooter(wrapper, conversation, message);
        if (isStreamingTail) footer.addClass('is-hidden');
      }
    } else {
      const bubble = wrapper.createDiv({ cls: 'dsh-agent-user-bubble' });
      bubble.setText(message.text);
      const meta = message.contextMeta;
      if (this.featureFlags['ui.context-badge'] !== false
        && meta !== undefined && (meta.quotes > 0 || meta.attachments > 0 || meta.selection)) {
        const parts: string[] = [];
        if (meta.quotes > 0) parts.push(meta.quotes + ' 条引用' + (meta.noted > 0 ? '（' + meta.noted + ' 条注释）' : ''));
        if (meta.attachments > 0) parts.push(meta.attachments + ' 个附件');
        if (meta.selection) parts.push('选区');
        const badge = wrapper.createDiv({ cls: 'dsh-agent-user-context-badge' });
        badge.setText('附 ' + parts.join(' · '));
      }
      if (message.text.trim() !== '') {
        this.buildMessageFooter(wrapper, conversation, message);
      }
      const queueIndex = (conversation.pendingInput ?? []).findIndex((prompt) => prompt.messageId === message.id);
      if (queueIndex >= 0) {
        const queue = wrapper.createDiv({ cls: 'dsh-agent-queue-controls' });
        queue.createSpan({ cls: 'dsh-agent-queue-badge', text: '排队 ' + (queueIndex + 1) + '/' + (conversation.pendingInput?.length ?? 0) });
        const up = queue.createEl('button', { cls: 'dsh-agent-action-btn' });
        setIcon(up, 'arrow-up');
        up.disabled = queueIndex === 0;
        up.setAttr('aria-label', '队列中上移');
        up.onclick = () => this.host.moveQueuedPrompt(conversation, message.id, -1);
        const down = queue.createEl('button', { cls: 'dsh-agent-action-btn' });
        setIcon(down, 'arrow-down');
        down.disabled = queueIndex === (conversation.pendingInput?.length ?? 0) - 1;
        down.setAttr('aria-label', '队列中下移');
        down.onclick = () => this.host.moveQueuedPrompt(conversation, message.id, 1);
        const cancel = queue.createEl('button', { cls: 'dsh-agent-action-btn' });
        setIcon(cancel, 'x');
        cancel.setAttr('aria-label', '取消排队消息');
        cancel.onclick = () => this.host.cancelQueuedPrompt(conversation, message.id);
      }
    }
    if (this.isCurrentMessageRender(generation, conversation.id) && track) {
      this.renderedMessages.push(message);
    } else if (!this.isCurrentMessageRender(generation, conversation.id)) {
      wrapper.remove();
    }
  }

  private async renderBlocksInto(
    container: HTMLElement,
    message: ChatMessage,
    animateFrom = 0,
    deferredText?: string,
  ): Promise<void> {
    container.empty();
    const blocks = message.blocks ?? [];
    let deferredIndex = -1;
    if (deferredText !== undefined) {
      for (let index = blocks.length - 1; index >= 0; index--) {
        const block = blocks[index];
        if (block.kind === 'text' && block.text.trim() === deferredText.trim()) {
          deferredIndex = index;
          break;
        }
      }
    }
    for (let index = 0; index < blocks.length; index++) {
      if (index === deferredIndex) continue;
      const block = blocks[index];
      switch (block.kind) {
        case 'thinking':
          renderThinkingBlock(container, block.text);
          break;
        case 'text': {
          const section = container.createDiv({ cls: 'dsh-agent-text-block' });
          await this.renderMarkdownInto(section, block.text);
          break;
        }
        case 'tool':
          renderToolCard(this.host, container, block.activity);
          break;
        case 'goal':
          renderGoalCard(container, block.card);
          break;
        case 'workflow':
          renderWorkflowCard(this.host, container, block.run);
          break;
        case 'todo':
          renderTodoList(container, block.todos);
          break;
        default:
          break;
      }
    }
    if (message.error !== undefined) {
      container.createDiv({ cls: 'dsh-agent-message-error', text: message.error });
    }
    if (message.changeSet !== undefined && (message.changeSet.files.length > 0 || message.changeSet.truncated)) {
      this.renderChangeSet(container, message);
    }
    // Pop-in animation for newly arrived cards; text blocks fade gently
    // (they land right below the typewriter section when tools arrive).
    for (let i = 0; i < container.children.length; i++) {
      if (i >= animateFrom) {
        const child = container.children[i] as HTMLElement;
        child.addClass('is-new');
        if (child.hasClass('dsh-agent-text-block')) child.addClass('is-fade');
      }
    }
  }

  private renderChangeSet(container: HTMLElement, message: ChatMessage): void {
    const changeSet = message.changeSet;
    if (changeSet === undefined) return;
    const card = container.createDiv({ cls: 'dsh-agent-change-card' });
    const header = card.createDiv({ cls: 'dsh-agent-change-header' });
    const icon = header.createSpan();
    setIcon(icon, 'files');
    header.createSpan({ text: ' 本轮改动 ' + changeSet.files.length + ' 个文件' });
    const totalAdditions = changeSet.files.reduce((sum, file) => sum + file.additions, 0);
    const totalDeletions = changeSet.files.reduce((sum, file) => sum + file.deletions, 0);
    header.createSpan({ cls: 'dsh-agent-change-counts', text: ' +' + totalAdditions + ' / -' + totalDeletions });
    if (changeSet.truncated) card.createDiv({ cls: 'dsh-agent-change-warning', text: '部分大文件或超出数量上限的改动只能记录摘要，无法完整撤销。' });
    const list = card.createDiv({ cls: 'dsh-agent-change-list' });
    for (const file of changeSet.files) {
      const details = list.createEl('details', { cls: 'dsh-agent-change-file' });
      const summary = details.createEl('summary');
      summary.createSpan({ cls: 'dsh-agent-change-kind', text: file.kind === 'created' ? '新增' : file.kind === 'deleted' ? '删除' : '修改' });
      summary.createSpan({ cls: 'dsh-agent-change-path', text: file.path });
      summary.createSpan({ cls: 'dsh-agent-change-counts', text: ' +' + file.additions + ' / -' + file.deletions });
      if (!file.reversible) summary.createSpan({ cls: 'dsh-agent-change-warning', text: ' 不可撤销' });
      if (file.reverted) summary.createSpan({ cls: 'dsh-agent-change-reverted', text: ' 已撤销' });
      const diff = details.createEl('pre', { cls: 'dsh-agent-change-diff' });
      diff.setText(this.host.previewFileChange(message, file.path));
      summary.onclick = (event) => {
        if ((event.target as HTMLElement).closest('.dsh-agent-change-open') !== null) event.preventDefault();
      };
    }
    if (changeSet.files.some((file) => file.reversible && !file.reverted)) {
      const undo = card.createEl('button', { cls: 'dsh-agent-btn dsh-agent-change-undo', text: '撤销本轮文件改动' });
      undo.onclick = () => {
        void this.host.confirmRestart('将只撤销仍与本轮结果一致的文件；之后被你或其他工具修改过的文件会保留并报告冲突。是否继续？').then((confirmed) => {
          if (!confirmed) return;
          const conversation = this.host.getActiveConversation();
          if (conversation === null) return;
          void this.host.undoMessageChanges(conversation, message.id).then((result) => {
          const parts = ['已撤销 ' + result.reverted.length + ' 个文件'];
          if (result.conflicts.length > 0) parts.push(result.conflicts.length + ' 个冲突已跳过');
          if (result.unavailable.length > 0) parts.push(result.unavailable.length + ' 个不可撤销');
          new Notice(parts.join('；'));
          });
        });
      };
    }
  }

  private blocksSignature(message: ChatMessage): string {
    const parts: string[] = [];
    for (const block of message.blocks ?? []) {
      switch (block.kind) {
        case 'thinking':
          parts.push('t' + textFingerprint(block.text));
          break;
        case 'text':
          parts.push('x' + textFingerprint(block.text));
          break;
        case 'tool':
          parts.push('c' + block.activity.status + ':' + textFingerprint(block.activity.resultText));
          break;
        case 'goal':
          parts.push('g' + block.card.operation);
          break;
        case 'workflow':
          parts.push('w' + block.run.agents.length + ':' + (block.run.stopReason ?? 'run'));
          break;
        case 'todo':
          parts.push('d' + block.todos.length + block.todos.map((x) => x.status[0]).join(''));
          break;
        default:
          break;
      }
    }
    if (message.error !== undefined) parts.push('e' + textFingerprint(message.error));
    if (message.superseded === true) parts.push('s1');
    if (message.changeSet !== undefined) {
      parts.push('f' + message.changeSet.files.map((file) => file.path + ':' + file.kind + ':' + String(file.reverted === true)).join(','));
    }
    return parts.join('|');
  }

  private scrollToBottom(): void {
    this.messageEl.scrollTop = this.messageEl.scrollHeight;
  }
}

function stopReasonLabel(reason: string): string {
  switch (reason) {
    case 'cancelled':
      return '已停止';
    case 'max_tokens':
      return '达到输出上限';
    case 'refusal':
      return '已拒绝';
    default:
      return reason;
  }
}

/** Small stable fingerprint for incremental DOM invalidation. */
function textFingerprint(text: string): string {
  let hash = 2166136261;
  // Length catches streaming appends. Evenly spaced samples catch same-length
  // replacements without rescanning multi-megabyte historical tool outputs on
  // every UI event.
  const step = Math.max(1, Math.floor(text.length / 256));
  for (let i = 0; i < text.length; i += step) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  if (text.length > 0) {
    hash ^= text.charCodeAt(text.length - 1);
    hash = Math.imul(hash, 16777619);
  }
  return text.length + ':' + (hash >>> 0).toString(36);
}
