// Native Obsidian port of the dsh-synapse conversation-map interaction model.
// Upstream: https://github.com/liangmianya/dsh-synapse (MIT; see THIRD_PARTY_NOTICES.md).
import { ItemView, Notice, setIcon, WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_DSH_SYNAPSE } from '../../constants';
import type { ChatMessage, Conversation } from '../chat/session';
import {
  groupSynapseConversations,
  layoutSynapseNodes,
  normalizeSynapsePosition,
  conversationUpdatedAt,
  synapseContentSignature,
  SYNAPSE_CARD_HEIGHT,
  SYNAPSE_CARD_WIDTH,
  SynapseNode,
  SynapsePosition,
} from './layout';
import { ownerWindowOf } from './window-scope';

export interface SynapseViewHost {
  getConversations(): Conversation[];
  getActiveConversation(): Conversation | null;
  activateConversation(id: string): void;
  createConversation(): Conversation;
  setConversationClosed(id: string, closed: boolean): void;
  closeWorkspaceConversations(workspace: string): number;
  renameConversation(id: string, title: string): boolean;
  branchConversation(conversation: Conversation, throughMessageId: string): Conversation;
  getSynapsePositions(): Record<string, SynapsePosition>;
  setSynapsePosition(id: string, position: SynapsePosition): void;
  clearSynapsePositions(ids: string[]): void;
  openChatView(): Promise<void>;
  onChange(listener: () => void): () => void;
}

interface CameraState {
  x: number;
  y: number;
  zoom: number;
  initialized: boolean;
}

interface EdgePath {
  parentId: string;
  childId: string;
  path: SVGPathElement;
}

interface WindowTask {
  owner: Window;
  id: number;
}

const MIN_ZOOM = 0.42;
const MAX_ZOOM = 1.8;
const LIVE_RENDER_INTERVAL_MS = 180;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function statusLabel(status: Conversation['status']): string {
  switch (status) {
    case 'preparing': return '准备中';
    case 'streaming': return '回复中';
    case 'error': return '异常';
    case 'disconnected': return '待续接';
    default: return '空闲';
  }
}

function latestBranchMessage(conversation: Conversation): ChatMessage | undefined {
  return [...conversation.messages].reverse().find((message) => message.role === 'assistant' && message.superseded !== true)
    ?? conversation.messages[conversation.messages.length - 1];
}

function formatTime(time: number): string {
  return new Date(time).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export class DshSynapseView extends ItemView {
  private rootEl!: HTMLElement;
  private viewportEl!: HTMLElement;
  private stageEl!: HTMLElement;
  private zoomLabelEl!: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private selectedWorkspace: string | undefined;
  private selectedConversationId: string | undefined;
  private lastActiveConversationId: string | undefined;
  private searchQuery = '';
  /** Preserve the workspace rail position across full Synapse DOM rebuilds. */
  private workspaceScrollTop = 0;
  private readonly cameras = new Map<string, CameraState>();
  private readonly nodePositions = new Map<string, SynapsePosition>();
  private edgePaths: EdgePath[] = [];
  private renderFrame: WindowTask | null = null;
  private renderTimer: WindowTask | null = null;
  private lastRenderAt = 0;
  private dragCleanup: (() => void) | null = null;
  private renderAfterDrag = false;
  private restoreSearchFocus = false;
  private closed = true;
  private readonly auxiliaryFrames = new Set<WindowTask>();
  private focusTimer: WindowTask | null = null;
  private cameraFrame: WindowTask | null = null;
  private contentSignature = '';

  constructor(leaf: WorkspaceLeaf, private readonly host: SynapseViewHost) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_DSH_SYNAPSE;
  }

  getDisplayText(): string {
    return 'DSH 会话地图';
  }

  getIcon(): string {
    return 'network';
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.rootEl = this.containerEl.children[1] as HTMLElement;
    this.rootEl.empty();
    this.rootEl.addClass('dsh-synapse-view');
    this.unsubscribe = this.host.onChange(() => this.scheduleRender());
    this.render();
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.renderFrame !== null) this.renderFrame.owner.cancelAnimationFrame(this.renderFrame.id);
    this.renderFrame = null;
    if (this.renderTimer !== null) this.renderTimer.owner.clearTimeout(this.renderTimer.id);
    this.renderTimer = null;
    this.renderAfterDrag = false;
    this.dragCleanup?.();
    this.dragCleanup = null;
    for (const frame of this.auxiliaryFrames) frame.owner.cancelAnimationFrame(frame.id);
    this.auxiliaryFrames.clear();
    if (this.focusTimer !== null) this.focusTimer.owner.clearTimeout(this.focusTimer.id);
    this.focusTimer = null;
    if (this.cameraFrame !== null) this.cameraFrame.owner.cancelAnimationFrame(this.cameraFrame.id);
    this.cameraFrame = null;
  }

  private viewWindow(): Window {
    return ownerWindowOf(this.containerEl, window);
  }

  private scheduleRender(): void {
    if (this.closed) return;
    if (this.dragCleanup !== null) {
      this.renderAfterDrag = true;
      return;
    }
    if (this.renderFrame !== null || this.renderTimer !== null) return;
    const remaining = LIVE_RENDER_INTERVAL_MS - (Date.now() - this.lastRenderAt);
    const viewWindow = this.viewWindow();
    const queueFrame = (): void => {
      this.renderTimer = null;
      const task: WindowTask = { owner: viewWindow, id: 0 };
      task.id = viewWindow.requestAnimationFrame(() => {
        if (this.renderFrame !== task) return;
        this.renderFrame = null;
        if (this.closed) return;
        this.render();
      });
      this.renderFrame = task;
    };
    if (remaining > 0) {
      const task: WindowTask = { owner: viewWindow, id: 0 };
      task.id = viewWindow.setTimeout(() => {
        if (this.renderTimer !== task) return;
        queueFrame();
      }, remaining);
      this.renderTimer = task;
    } else queueFrame();
  }

  private camera(): CameraState {
    const key = this.selectedWorkspace ?? '';
    let camera = this.cameras.get(key);
    if (camera === undefined) {
      camera = { x: 42, y: 42, zoom: 1, initialized: false };
      this.cameras.set(key, camera);
    }
    return camera;
  }

  private render(): void {
    if (this.closed) return;
    this.lastRenderAt = Date.now();
    const groups = groupSynapseConversations(this.host.getConversations());
    const active = this.host.getActiveConversation();
    if (active !== null && active.id !== this.lastActiveConversationId) {
      this.lastActiveConversationId = active.id;
      this.selectedConversationId = active.id;
      this.selectedWorkspace = active.workspace;
    }
    if (this.selectedWorkspace === undefined || !groups.some((group) => group.key === this.selectedWorkspace)) {
      this.selectedWorkspace = active?.workspace ?? groups[0]?.key;
    }
    const group = groups.find((entry) => entry.key === this.selectedWorkspace);
    const conversations = group?.conversations ?? [];
    if (this.selectedConversationId === undefined
      || !conversations.some((conversation) => conversation.id === this.selectedConversationId)) {
      this.selectedConversationId = active?.workspace === this.selectedWorkspace
        ? active.id
        : conversations[0]?.id;
    }
    const nextSignature = synapseContentSignature(
      this.host.getConversations(),
      this.host.getSynapsePositions(),
      {
        selectedWorkspace: this.selectedWorkspace,
        searchQuery: this.searchQuery,
      },
    );
    if (nextSignature === this.contentSignature) {
      this.syncSelectionState(active?.id);
      return;
    }
    this.contentSignature = nextSignature;
    const previousWorkspaceList = this.rootEl.querySelector<HTMLElement>('.dsh-synapse-workspaces');
    if (previousWorkspaceList !== null) this.workspaceScrollTop = previousWorkspaceList.scrollTop;
    this.rootEl.empty();
    const shell = this.rootEl.createDiv({ cls: 'dsh-synapse-shell' });
    this.renderHeader(shell, group?.key, group?.label ?? '会话地图', conversations.length);
    const body = shell.createDiv({ cls: 'dsh-synapse-body' });
    this.renderSidebar(body, groups, conversations);
    this.renderCanvas(body, conversations, active?.id);
  }

  private renderHeader(
    parent: HTMLElement,
    workspaceKey: string | undefined,
    workspaceName: string,
    count: number,
  ): void {
    const header = parent.createDiv({ cls: 'dsh-synapse-header' });
    const brand = header.createDiv({ cls: 'dsh-synapse-brand' });
    const icon = brand.createSpan({ cls: 'dsh-synapse-brand-icon' });
    setIcon(icon, 'network');
    const title = brand.createDiv();
    title.createDiv({ cls: 'dsh-synapse-title', text: '会话地图' });
    title.createDiv({ cls: 'dsh-synapse-subtitle', text: workspaceName + ' · ' + count + ' 个会话' });
    const actions = header.createDiv({ cls: 'dsh-synapse-header-actions' });
    const current = actions.createEl('button', { cls: 'dsh-synapse-button is-quiet', text: '定位当前' });
    const locateIcon = current.createSpan({ cls: 'dsh-synapse-button-icon' });
    setIcon(locateIcon, 'locate-fixed');
    current.onclick = () => this.focusConversation(this.host.getActiveConversation()?.id);
    const arrange = actions.createEl('button', { cls: 'dsh-synapse-button is-quiet', text: '自动整理' });
    const arrangeIcon = arrange.createSpan({ cls: 'dsh-synapse-button-icon' });
    setIcon(arrangeIcon, 'wand-sparkles');
    arrange.onclick = () => {
      const ids = groupSynapseConversations(this.host.getConversations())
        .find((group) => group.key === this.selectedWorkspace)?.conversations.map((conversation) => conversation.id) ?? [];
      this.host.clearSynapsePositions(ids);
      this.camera().initialized = false;
      this.scheduleRender();
    };
    const closeAll = actions.createEl('button', {
      cls: 'dsh-synapse-button is-quiet is-danger',
      text: '关闭全部',
      attr: { 'aria-label': '关闭当前工作区的全部会话', title: '关闭工作区全部会话' },
    });
    const closeAllIcon = closeAll.createSpan({ cls: 'dsh-synapse-button-icon' });
    setIcon(closeAllIcon, 'archive');
    closeAll.disabled = workspaceKey === undefined || count === 0;
    closeAll.onclick = () => {
      if (workspaceKey === undefined || count === 0) return;
      const confirmed = this.viewWindow().confirm(
        '关闭工作区“' + workspaceName + '”中的 ' + count
          + ' 个会话？\n\n会话将进入历史记录，可以随时恢复，不会删除聊天内容。',
      );
      if (!confirmed) return;
      const closedCount = this.host.closeWorkspaceConversations(workspaceKey);
      if (closedCount > 0) new Notice('已关闭工作区“' + workspaceName + '”的 ' + closedCount + ' 个会话');
    };
    const newButton = actions.createEl('button', { cls: 'dsh-synapse-button is-primary', text: '新会话' });
    const plus = newButton.createSpan({ cls: 'dsh-synapse-button-icon' });
    setIcon(plus, 'plus');
    newButton.onclick = () => {
      const conversation = this.host.createConversation();
      this.selectedWorkspace = conversation.workspace;
      this.selectedConversationId = conversation.id;
      this.lastActiveConversationId = conversation.id;
      void this.host.openChatView();
    };
  }

  private renderSidebar(
    parent: HTMLElement,
    groups: ReturnType<typeof groupSynapseConversations>,
    conversations: Conversation[],
  ): void {
    const sidebar = parent.createDiv({ cls: 'dsh-synapse-sidebar' });
    sidebar.createDiv({ cls: 'dsh-synapse-section-label', text: '工作区' });
    const workspaceList = sidebar.createDiv({ cls: 'dsh-synapse-workspaces' });
    for (const group of groups) {
      const button = workspaceList.createEl('button', {
        cls: 'dsh-synapse-workspace' + (group.key === this.selectedWorkspace ? ' is-active' : ''),
      });
      const icon = button.createSpan();
      setIcon(icon, 'folder');
      button.createSpan({ cls: 'dsh-synapse-workspace-name', text: group.label });
      button.createSpan({ cls: 'dsh-synapse-count', text: String(group.conversations.length) });
      button.setAttr('title', group.key);
      button.onclick = () => {
        if (this.selectedWorkspace === group.key) return;
        this.selectedWorkspace = group.key;
        this.selectedConversationId = group.conversations[0]?.id;
        this.scheduleRender();
      };
    }
    workspaceList.scrollTop = this.workspaceScrollTop;
    workspaceList.onscroll = () => {
      this.workspaceScrollTop = workspaceList.scrollTop;
    };

    const conversationHeader = sidebar.createDiv({ cls: 'dsh-synapse-sidebar-heading' });
    conversationHeader.createSpan({ text: '会话' });
    conversationHeader.createSpan({ text: String(conversations.length) });
    const search = sidebar.createEl('input', {
      cls: 'dsh-synapse-search',
      attr: { type: 'search', placeholder: '搜索会话标题', 'aria-label': '搜索会话标题' },
    });
    search.value = this.searchQuery;
    search.oninput = () => {
      this.searchQuery = search.value;
      this.restoreSearchFocus = true;
      this.scheduleRender();
    };
    if (this.restoreSearchFocus) {
      this.restoreSearchFocus = false;
      this.queueAuxiliaryFrame(() => {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      });
    }
    const query = this.searchQuery.trim().toLocaleLowerCase();
    const list = sidebar.createDiv({ cls: 'dsh-synapse-conversation-list' });
    const filtered = conversations.filter((conversation) => query === ''
      || conversation.title.toLocaleLowerCase().includes(query));
    for (const conversation of filtered) {
      const messageCount = conversation.messages.filter((message) => message.superseded !== true).length;
      const item = list.createEl('button', {
        cls: 'dsh-synapse-conversation-item'
          + (conversation.id === this.selectedConversationId ? ' is-selected' : '')
          + (conversation.id === this.host.getActiveConversation()?.id ? ' is-current' : ''),
      });
      item.dataset.conversationId = conversation.id;
      const top = item.createDiv({ cls: 'dsh-synapse-conversation-top' });
      top.createSpan({ cls: 'dsh-synapse-conversation-title', text: conversation.title });
      top.createSpan({ cls: 'dsh-synapse-mini-status is-' + conversation.status, text: statusLabel(conversation.status) });
      item.createDiv({
        cls: 'dsh-synapse-conversation-meta',
        text: messageCount + ' 条消息 · ' + formatTime(conversationUpdatedAt(conversation)),
      });
      item.onclick = () => this.selectConversation(conversation);
      item.ondblclick = () => this.openConversation(conversation);
    }
    if (filtered.length === 0) list.createDiv({ cls: 'dsh-synapse-empty-small', text: '没有匹配的会话' });
  }

  private renderCanvas(parent: HTMLElement, conversations: Conversation[], activeId: string | undefined): void {
    const canvas = parent.createDiv({ cls: 'dsh-synapse-canvas-column' });
    this.viewportEl = canvas.createDiv({ cls: 'dsh-synapse-viewport' });
    this.stageEl = this.viewportEl.createDiv({ cls: 'dsh-synapse-stage' });
    const nodes = layoutSynapseNodes(conversations, this.host.getSynapsePositions());
    this.nodePositions.clear();
    for (const node of nodes) this.nodePositions.set(node.conversation.id, { x: node.x, y: node.y });
    const width = Math.max(1_600, ...nodes.map((node) => node.x + SYNAPSE_CARD_WIDTH + 180));
    const height = Math.max(1_000, ...nodes.map((node) => node.y + SYNAPSE_CARD_HEIGHT + 180));
    this.stageEl.style.width = width + 'px';
    this.stageEl.style.height = height + 'px';

    const document = this.stageEl.ownerDocument;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('dsh-synapse-edges');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    this.stageEl.appendChild(svg);
    this.edgePaths = [];
    const nodeIds = new Set(nodes.map((node) => node.conversation.id));
    for (const node of nodes) {
      if (node.parentId === undefined || !nodeIds.has(node.parentId)) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.classList.add('dsh-synapse-edge');
      svg.appendChild(path);
      this.edgePaths.push({ parentId: node.parentId, childId: node.conversation.id, path });
    }
    this.updateEdges();
    for (const node of nodes) this.renderNode(this.stageEl, node, activeId);

    if (nodes.length === 0) {
      const empty = this.viewportEl.createDiv({ cls: 'dsh-synapse-canvas-empty' });
      const icon = empty.createSpan();
      setIcon(icon, 'network');
      empty.createDiv({ text: '当前工作区还没有会话' });
      empty.createDiv({ cls: 'dsh-synapse-muted', text: '点击“新会话”建立第一张卡片' });
    }
    this.renderCanvasControls(canvas);
    this.bindCanvasNavigation();
    this.applyCamera();
    if (!this.camera().initialized && nodes.length > 0) {
      this.queueAuxiliaryFrame(() => this.fitMap());
    }
  }

  private renderNode(parent: HTMLElement, node: SynapseNode, activeId: string | undefined): void {
    const { conversation } = node;
    const messageCount = conversation.messages.filter((message) => message.superseded !== true).length;
    const card = parent.createDiv({
      cls: 'dsh-synapse-card'
        + (conversation.id === this.selectedConversationId ? ' is-selected' : '')
        + (conversation.id === activeId ? ' is-current' : '')
        + (conversation.status === 'streaming' || conversation.status === 'preparing' ? ' is-running' : ''),
    });
    card.dataset.conversationId = conversation.id;
    card.style.left = node.x + 'px';
    card.style.top = node.y + 'px';
    card.onclick = () => this.selectConversation(conversation);
    card.onpointerdown = (event) => {
      if (event.button !== 0 || (event.target as Element).closest('button, input') !== null) return;
      this.beginCardDrag(event, card, conversation.id);
    };

    const header = card.createDiv({ cls: 'dsh-synapse-card-header' });
    const status = header.createSpan({ cls: 'dsh-synapse-card-status is-' + conversation.status });
    status.setAttr('aria-label', statusLabel(conversation.status));
    header.createDiv({ cls: 'dsh-synapse-card-title', text: conversation.title });
    if (conversation.branchedFrom !== undefined) {
      const branch = header.createSpan({ cls: 'dsh-synapse-card-branch' });
      setIcon(branch, 'git-branch');
    }
    card.createDiv({
      cls: 'dsh-synapse-card-meta',
      text: statusLabel(conversation.status) + ' · ' + messageCount + ' 条消息 · ' + formatTime(conversationUpdatedAt(conversation)),
    });
    const footer = card.createDiv({ cls: 'dsh-synapse-card-footer' });
    footer.createSpan({ text: conversation.branchedFrom === undefined ? '主会话' : '分支会话' });
    const actions = footer.createDiv({ cls: 'dsh-synapse-card-actions' });
    const rename = actions.createEl('button', {
      cls: 'dsh-synapse-card-action',
      attr: { 'aria-label': '重命名会话', title: '重命名' },
    });
    setIcon(rename, 'pencil');
    rename.onclick = (event) => {
      event.stopPropagation();
      this.beginRename(conversation, card);
    };
    const branchMessage = latestBranchMessage(conversation);
    const branch = actions.createEl('button', {
      cls: 'dsh-synapse-card-action',
      attr: { 'aria-label': '创建分支会话', title: '创建分支' },
    });
    setIcon(branch, 'git-branch');
    branch.disabled = branchMessage === undefined || conversation.status === 'streaming' || conversation.status === 'preparing';
    branch.onclick = (event) => {
      event.stopPropagation();
      if (branchMessage !== undefined) this.createBranch(conversation, branchMessage.id);
    };
    const close = actions.createEl('button', {
      cls: 'dsh-synapse-card-action is-danger',
      attr: { 'aria-label': '关闭会话', title: '关闭' },
    });
    setIcon(close, 'x');
    close.onclick = (event) => {
      event.stopPropagation();
      this.host.setConversationClosed(conversation.id, true);
    };
  }

  private beginRename(conversation: Conversation, card: HTMLElement): void {
    const title = card.querySelector<HTMLElement>('.dsh-synapse-card-title');
    if (title === null || card.querySelector('.dsh-synapse-card-title-input') !== null) return;
    const document = card.ownerDocument;
    const input = document.createElement('input');
    input.className = 'dsh-synapse-card-title-input';
    input.value = conversation.title;
    input.setAttribute('aria-label', '重命名会话');
    title.replaceWith(input);
    let settled = false;
    const finish = (save: boolean): void => {
      if (settled) return;
      settled = true;
      const next = input.value.replace(/\s+/g, ' ').trim();
      const label = document.createElement('div');
      label.className = 'dsh-synapse-card-title';
      label.textContent = save && next !== '' ? next : conversation.title;
      input.replaceWith(label);
      if (!save) return;
      if (next === '' || !this.host.renameConversation(conversation.id, next)) {
        new Notice('会话名称不能为空');
      }
    };
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
    this.queueAuxiliaryFrame(() => {
      input.focus();
      input.select();
    });
  }

  private renderCanvasControls(parent: HTMLElement): void {
    const controls = parent.createDiv({ cls: 'dsh-synapse-canvas-controls' });
    const zoomOut = controls.createEl('button');
    setIcon(zoomOut, 'minus');
    zoomOut.setAttr('aria-label', '缩小');
    zoomOut.onclick = () => this.zoomBy(-0.12);
    this.zoomLabelEl = controls.createDiv({ cls: 'dsh-synapse-zoom-label', text: Math.round(this.camera().zoom * 100) + '%' });
    const zoomIn = controls.createEl('button');
    setIcon(zoomIn, 'plus');
    zoomIn.setAttr('aria-label', '放大');
    zoomIn.onclick = () => this.zoomBy(0.12);
    const fit = controls.createEl('button');
    setIcon(fit, 'maximize');
    fit.setAttr('aria-label', '适应画布');
    fit.onclick = () => this.fitMap();
  }

  private selectConversation(conversation: Conversation): void {
    this.selectedWorkspace = conversation.workspace;
    this.selectedConversationId = conversation.id;
    this.lastActiveConversationId = conversation.id;
    this.syncSelectionState(conversation.id);
    this.host.activateConversation(conversation.id);
    this.scheduleRender();
  }

  private openConversation(conversation: Conversation): void {
    this.selectConversation(conversation);
    void this.host.openChatView();
  }

  private createBranch(conversation: Conversation, messageId: string): void {
    const source = this.nodePositions.get(conversation.id);
    const siblingCount = this.host.getConversations().filter((entry) => entry.branchedFrom === conversation.id).length;
    const branch = this.host.branchConversation(conversation, messageId);
    if (source !== undefined) {
      this.host.setSynapsePosition(branch.id, {
        x: source.x + SYNAPSE_CARD_WIDTH + 92,
        y: source.y + siblingCount * (SYNAPSE_CARD_HEIGHT + 56),
      });
    }
    this.selectedWorkspace = branch.workspace;
    this.selectedConversationId = branch.id;
    this.lastActiveConversationId = branch.id;
    new Notice('已创建分支，正在聊天视图中打开');
    void this.host.openChatView();
  }

  private beginCardDrag(event: PointerEvent, card: HTMLElement, id: string): void {
    const start = this.nodePositions.get(id);
    if (start === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const camera = this.camera();
    const pointerX = event.clientX;
    const pointerY = event.clientY;
    let latest = { ...start };
    let moved = false;
    let pendingX = pointerX;
    let pendingY = pointerY;
    let frame: number | null = null;
    const viewWindow = ownerWindowOf(card, this.viewWindow());
    card.addClass('is-dragging');
    const applyPending = (): void => {
      frame = null;
      const dx = (pendingX - pointerX) / camera.zoom;
      const dy = (pendingY - pointerY) / camera.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      latest = normalizeSynapsePosition({ x: start.x + dx, y: start.y + dy }) ?? latest;
      card.style.transform = `translate3d(${latest.x - start.x}px, ${latest.y - start.y}px, 0)`;
      this.nodePositions.set(id, latest);
      this.updateEdgesFor(id);
    };
    const move = (moveEvent: PointerEvent): void => {
      pendingX = moveEvent.clientX;
      pendingY = moveEvent.clientY;
      if (frame === null) frame = viewWindow.requestAnimationFrame(applyPending);
    };
    const up = (upEvent: PointerEvent): void => {
      pendingX = upEvent.clientX;
      pendingY = upEvent.clientY;
      if (frame !== null) viewWindow.cancelAnimationFrame(frame);
      applyPending();
      cleanup();
      card.removeClass('is-dragging');
      card.style.left = latest.x + 'px';
      card.style.top = latest.y + 'px';
      card.style.transform = '';
      if (moved) this.host.setSynapsePosition(id, latest);
    };
    const cleanup = (): void => {
      if (frame !== null) viewWindow.cancelAnimationFrame(frame);
      frame = null;
      viewWindow.removeEventListener('pointermove', move);
      viewWindow.removeEventListener('pointerup', up);
      viewWindow.removeEventListener('pointercancel', up);
      if (this.dragCleanup === cleanup) {
        this.dragCleanup = null;
        if (this.renderAfterDrag) {
          this.renderAfterDrag = false;
          this.scheduleRender();
        }
      }
    };
    this.dragCleanup?.();
    this.dragCleanup = cleanup;
    viewWindow.addEventListener('pointermove', move);
    viewWindow.addEventListener('pointerup', up);
    viewWindow.addEventListener('pointercancel', up);
  }

  private bindCanvasNavigation(): void {
    this.viewportEl.onpointerdown = (event) => {
      if (event.button !== 0 || (event.target as Element).closest('.dsh-synapse-card') !== null) return;
      const camera = this.camera();
      const startX = event.clientX;
      const startY = event.clientY;
      const originX = camera.x;
      const originY = camera.y;
      let pendingX = startX;
      let pendingY = startY;
      let frame: number | null = null;
      const viewWindow = ownerWindowOf(this.viewportEl, this.viewWindow());
      this.viewportEl.addClass('is-panning');
      const applyPending = (): void => {
        frame = null;
        camera.x = originX + pendingX - startX;
        camera.y = originY + pendingY - startY;
        this.applyCamera();
      };
      const move = (moveEvent: PointerEvent): void => {
        pendingX = moveEvent.clientX;
        pendingY = moveEvent.clientY;
        if (frame === null) frame = viewWindow.requestAnimationFrame(applyPending);
      };
      const up = (upEvent: PointerEvent): void => {
        pendingX = upEvent.clientX;
        pendingY = upEvent.clientY;
        if (frame !== null) viewWindow.cancelAnimationFrame(frame);
        applyPending();
        cleanup();
        this.viewportEl.removeClass('is-panning');
      };
      const cleanup = (): void => {
        if (frame !== null) viewWindow.cancelAnimationFrame(frame);
        frame = null;
        viewWindow.removeEventListener('pointermove', move);
        viewWindow.removeEventListener('pointerup', up);
        viewWindow.removeEventListener('pointercancel', up);
        if (this.dragCleanup === cleanup) {
          this.dragCleanup = null;
          if (this.renderAfterDrag) {
            this.renderAfterDrag = false;
            this.scheduleRender();
          }
        }
      };
      this.dragCleanup?.();
      this.dragCleanup = cleanup;
      viewWindow.addEventListener('pointermove', move);
      viewWindow.addEventListener('pointerup', up);
      viewWindow.addEventListener('pointercancel', up);
    };
    this.viewportEl.addEventListener('wheel', (event) => {
      event.preventDefault();
      const camera = this.camera();
      const rect = this.viewportEl.getBoundingClientRect();
      const oldZoom = camera.zoom;
      const nextZoom = clamp(oldZoom * (event.deltaY > 0 ? 0.9 : 1.1), MIN_ZOOM, MAX_ZOOM);
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const worldX = (pointerX - camera.x) / oldZoom;
      const worldY = (pointerY - camera.y) / oldZoom;
      camera.zoom = nextZoom;
      camera.x = pointerX - worldX * nextZoom;
      camera.y = pointerY - worldY * nextZoom;
      camera.initialized = true;
      this.scheduleCameraApply();
    }, { passive: false });
  }

  private updateEdges(): void {
    for (const edge of this.edgePaths) {
      this.updateEdge(edge);
    }
  }

  private syncSelectionState(activeId: string | undefined): void {
    for (const item of Array.from(this.rootEl.querySelectorAll<HTMLElement>('.dsh-synapse-conversation-item'))) {
      const id = item.dataset.conversationId;
      item.toggleClass('is-selected', id === this.selectedConversationId);
      item.toggleClass('is-current', id === activeId);
    }
    for (const card of Array.from(this.rootEl.querySelectorAll<HTMLElement>('.dsh-synapse-card'))) {
      const id = card.dataset.conversationId;
      card.toggleClass('is-selected', id === this.selectedConversationId);
      card.toggleClass('is-current', id === activeId);
    }
  }

  private updateEdgesFor(conversationId: string): void {
    for (const edge of this.edgePaths) {
      if (edge.parentId === conversationId || edge.childId === conversationId) this.updateEdge(edge);
    }
  }

  private updateEdge(edge: EdgePath): void {
    const parent = this.nodePositions.get(edge.parentId);
    const child = this.nodePositions.get(edge.childId);
    if (parent === undefined || child === undefined) return;
    const x1 = parent.x + SYNAPSE_CARD_WIDTH;
    const y1 = parent.y + SYNAPSE_CARD_HEIGHT / 2;
    const x2 = child.x;
    const y2 = child.y + SYNAPSE_CARD_HEIGHT / 2;
    const bend = Math.max(54, Math.abs(x2 - x1) * 0.48);
    edge.path.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
  }

  private applyCamera(): void {
    if (this.stageEl === undefined) return;
    const camera = this.camera();
    this.stageEl.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
    if (this.zoomLabelEl !== undefined) this.zoomLabelEl.setText(Math.round(camera.zoom * 100) + '%');
  }

  private scheduleCameraApply(): void {
    if (this.closed || this.cameraFrame !== null) return;
    const viewWindow = this.viewWindow();
    const task: WindowTask = { owner: viewWindow, id: 0 };
    task.id = viewWindow.requestAnimationFrame(() => {
      if (this.cameraFrame !== task) return;
      this.cameraFrame = null;
      if (!this.closed) this.applyCamera();
    });
    this.cameraFrame = task;
  }

  private zoomBy(delta: number): void {
    if (this.viewportEl === undefined) return;
    const camera = this.camera();
    const rect = this.viewportEl.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const worldX = (centerX - camera.x) / camera.zoom;
    const worldY = (centerY - camera.y) / camera.zoom;
    camera.zoom = clamp(camera.zoom + delta, MIN_ZOOM, MAX_ZOOM);
    camera.x = centerX - worldX * camera.zoom;
    camera.y = centerY - worldY * camera.zoom;
    camera.initialized = true;
    this.applyCamera();
  }

  private fitMap(): void {
    if (this.nodePositions.size === 0 || this.viewportEl === undefined) return;
    const rect = this.viewportEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const points = [...this.nodePositions.values()];
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x + SYNAPSE_CARD_WIDTH));
    const maxY = Math.max(...points.map((point) => point.y + SYNAPSE_CARD_HEIGHT));
    const camera = this.camera();
    camera.zoom = clamp(Math.min((rect.width - 72) / Math.max(1, maxX - minX), (rect.height - 72) / Math.max(1, maxY - minY)), MIN_ZOOM, 1.2);
    camera.x = (rect.width - (maxX - minX) * camera.zoom) / 2 - minX * camera.zoom;
    camera.y = (rect.height - (maxY - minY) * camera.zoom) / 2 - minY * camera.zoom;
    camera.initialized = true;
    this.applyCamera();
  }

  private focusConversation(id: string | undefined): void {
    if (this.closed || id === undefined) return;
    const conversation = this.host.getConversations().find((entry) => entry.id === id && entry.closed !== true);
    if (conversation === undefined) return;
    if (conversation.workspace !== this.selectedWorkspace) {
      this.selectedWorkspace = conversation.workspace;
      this.selectedConversationId = id;
      this.scheduleRender();
      if (this.focusTimer !== null) this.focusTimer.owner.clearTimeout(this.focusTimer.id);
      const viewWindow = this.viewWindow();
      const task: WindowTask = { owner: viewWindow, id: 0 };
      task.id = viewWindow.setTimeout(() => {
        if (this.focusTimer !== task) return;
        this.focusTimer = null;
        this.focusConversation(id);
      }, 40);
      this.focusTimer = task;
      return;
    }
    const point = this.nodePositions.get(id);
    if (point === undefined || this.viewportEl === undefined) return;
    const rect = this.viewportEl.getBoundingClientRect();
    const camera = this.camera();
    camera.x = rect.width / 2 - (point.x + SYNAPSE_CARD_WIDTH / 2) * camera.zoom;
    camera.y = rect.height / 2 - (point.y + SYNAPSE_CARD_HEIGHT / 2) * camera.zoom;
    camera.initialized = true;
    this.selectedConversationId = id;
    this.applyCamera();
    this.scheduleRender();
  }

  private queueAuxiliaryFrame(callback: () => void): void {
    if (this.closed) return;
    const viewWindow = this.viewWindow();
    const task: WindowTask = { owner: viewWindow, id: 0 };
    task.id = viewWindow.requestAnimationFrame(() => {
      this.auxiliaryFrames.delete(task);
      if (!this.closed) callback();
    });
    this.auxiliaryFrames.add(task);
  }
}
