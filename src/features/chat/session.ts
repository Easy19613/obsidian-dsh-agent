// Conversation model: plugin-side transcripts (the DSH ACP protocol itself
// only supports brand-new sessions, so history lives here).
import type { AcpStopReason } from '../../acp/types';

export type ChatRole = 'user' | 'assistant';
export type ConversationStatus = 'idle' | 'preparing' | 'streaming' | 'error' | 'disconnected';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  time: number;
  stopReason?: AcpStopReason;
  error?: string;
  /** Snapshot of the one-shot context sent with this user message (for its badge). */
  contextMeta?: { quotes: number; noted: number; attachments: number; selection: boolean };
  /** Tool invocations observed in the session log during this assistant turn. */
  toolActivities?: ToolActivity[];
  /** Latest todo snapshot observed at this message (rendered as a task list). */
  todos?: TodoItem[];
  /** Accumulated thinking text (reasoning deltas from the session log). */
  reasoning?: string;
  /** Ephemeral current-step reasoning shown by the expandable live indicator. */
  liveReasoning?: string;
  /** Turn/step identity for liveReasoning, used to reset between model steps. */
  liveReasoningKey?: string;
  /** Ephemeral text mirror streamed from the session log before ACP settles. */
  streamedText?: string;
  /** Number of cumulative stream characters already committed to timeline text blocks. */
  streamedTextCursor?: number;
  /** Goal mutations observed during this turn. */
  goalCards?: GoalCard[];
  /** Workflow runs observed during this turn. */
  workflowRuns?: WorkflowRun[];
  /** Ordered timeline blocks (thinking/tools/goals/workflows/todos) in event order. */
  blocks?: MessageBlock[];
  /** Exact send-time prompt snapshot used by retry/regenerate. */
  promptSnapshot?: PendingPrompt;
  /** Files changed by this assistant turn, including reversible before/after snapshots. */
  changeSet?: FileChangeSet;
  /** True when the turn was started by retry/regenerate/continue. */
  recoveryKind?: 'retry' | 'regenerate' | 'continue';
  /** Preserved audit record for a failed answer replaced by retry. */
  superseded?: boolean;
  /** This interrupted answer has already spawned its one allowed continuation. */
  continued?: boolean;
  /** The plugin cancelled an active Goal that was repeatedly waiting for future user input. */
  goalLoopGuardTriggered?: boolean;
}

export interface FileChange {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  before?: string;
  after?: string;
  additions: number;
  deletions: number;
  reversible: boolean;
  reverted?: boolean;
}

export interface FileChangeSet {
  startedAt: number;
  completedAt: number;
  files: FileChange[];
  truncated: boolean;
  revertedAt?: number;
}

export type MessageBlock =
  | { kind: 'thinking'; text: string; turn?: number; step?: number }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; activity: ToolActivity }
  | { kind: 'goal'; card: GoalCard }
  | { kind: 'workflow'; run: WorkflowRun }
  | { kind: 'todo'; todos: TodoItem[] };

export interface GoalCard {
  operation: string;
  objective?: string;
  phase?: string;
  maxGoalRounds?: number;
  roundsStarted?: number;
  blockedReason?: string;
  time: number;
}

export interface WorkflowAgent {
  seq: number;
  label: string;
  phase?: string;
  outcome?: string;
  /** Durable child session id when the runtime exposes one. */
  childId?: string;
  /** Parent session/agent id; used to render nested delegation trees. */
  parentId?: string;
  depth?: number;
  callId?: string;
  prompt?: string;
  jobId?: string;
  startedAt?: number;
  endedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  report?: string;
  lastOutput?: string;
}

export interface WorkflowRun {
  runId: string;
  name: string;
  kind?: 'workflow' | 'subagent';
  rootSessionId?: string;
  toolCallId?: string;
  stopReason?: string;
  startedAt?: number;
  endedAt?: number;
  report?: string;
  agents: WorkflowAgent[];
}

/** Reopen a synthetic subagent console when a later child starts in the same turn. */
export function markSubagentRunActive(run: WorkflowRun): void {
  if (run.kind !== 'subagent') return;
  run.stopReason = undefined;
  run.endedAt = undefined;
}

/** Stop the synthetic console clock once every child row has reached a terminal state. */
export function settleSubagentRun(run: WorkflowRun, now = Date.now()): boolean {
  if (run.kind !== 'subagent' || run.agents.length === 0
    || run.agents.some((agent) => agent.outcome === undefined)) {
    return false;
  }
  const latestAgentEnd = run.agents.reduce(
    (latest, agent) => Math.max(latest, agent.endedAt ?? 0),
    0,
  );
  run.endedAt = latestAgentEnd > 0 ? latestAgentEnd : now;
  const failure = run.agents.find(
    (agent) => agent.outcome !== 'completed' && agent.outcome !== 'idle',
  );
  run.stopReason = failure?.outcome
    ?? (run.agents.every((agent) => agent.outcome === 'idle') ? 'idle' : 'completed');
  return true;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolActivity {
  callId: string;
  name: string;
  argumentsJson: string;
  status: 'running' | 'done' | 'error';
  resultText: string;
  errorCode?: string;
  errorName?: string;
  meta?: unknown;
  startTime: number;
  endTime?: number;
}

export interface NoteAttachment {
  name: string;
  uri: string;
  kind?: 'note' | 'text' | 'pdf' | 'image' | 'file';
  mimeType?: string;
  size?: number;
  /** Locally extracted UTF-8 text; bounded before persistence/prompting. */
  extractedText?: string;
  extraction?: 'resource-link' | 'text-extracted' | 'text-truncated' | 'mineru-fallback' | 'vision-fallback';
  range?: { kind: 'pages' | 'paragraphs'; start: number; end: number };
}

export interface SelectionAttachment {
  text: string;
  basename: string;
  /** Full vault-relative path, retained so same-basename notes stay unambiguous. */
  path?: string;
  lineStart: number;
  lineEnd: number;
  /** Omitted on legacy data; note is the historical default. */
  sourceKind?: 'note' | 'web';
  /** Source URL when the selection/context came from Obsidian's Web Viewer. */
  sourceUrl?: string;
  /** Whether text is a user selection or the current page's rendered article body. */
  webMode?: 'selection' | 'page';
  /** Surrounding rendered article text supplied with a web selection. */
  contextText?: string;
  truncated?: boolean;
  contextTruncated?: boolean;
}

/** A highlighted excerpt from an AI reply, quoted into the next prompt. */
export interface QuoteAttachment {
  text: string;
  note: string;
}

/** A user turn captured at send time, including its one-shot context. */
export interface PendingPrompt {
  text: string;
  /** Already-rendered user message that this prompt belongs to. */
  messageId?: string;
  attachments: NoteAttachment[];
  /** Note/editor selection, retained separately from browser context. */
  selection?: SelectionAttachment;
  /** Full rendered body of the active Web Viewer page. */
  webContext?: SelectionAttachment;
  /** Explicit text selection inside the active Web Viewer page. */
  webSelection?: SelectionAttachment;
  quotes: QuoteAttachment[];
}

export interface TokenUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  time: number;
}

export interface Conversation {
  id: string;
  title: string;
  workspace: string;
  acpSessionId?: string;
  status: ConversationStatus;
  messages: ChatMessage[];
  createdAt: number;
  /** One-shot note attachments for the next prompt (cleared after send). */
  attachments?: NoteAttachment[];
  /** Live editor selection draft (upserted by the selection tracker). */
  selection?: SelectionAttachment;
  /** Full rendered body of the active Web Viewer page. */
  webContext?: SelectionAttachment;
  /** Explicit text selection inside the active Web Viewer page. */
  webSelection?: SelectionAttachment;
  /** Quoted excerpts from AI replies, added to the next prompt (one-shot). */
  quotes?: QuoteAttachment[];
  /** Closed (archived) conversations hide from the strip but stay in history. */
  closed?: boolean;
  /** True when the session log delivered a server-side title. */
  titleFromServer?: boolean;
  /** A user-edited title is authoritative and must not be replaced by DSH. */
  titleManuallySet?: boolean;
  /** Conversation id this conversation was branched from (Codex-style). */
  branchedFrom?: string;
  /** User turns queued while a reply is streaming (queuePolicy=queue). */
  pendingInput?: PendingPrompt[];
  /** One-shot transcript injected into the next prompt after a rewind. */
  rewindContext?: string;
  /** Latest token usage observed in the session log (context display). */
  lastUsage?: TokenUsageSnapshot;
  /** Pinned conversations sort first in the strip and history panel. */
  pinned?: boolean;
  /** Number of oldest messages evicted by the bounded local transcript. */
  droppedMessageCount?: number;
  /** Raw session log paths owned by this conversation. */
  sessionLogPaths?: string[];
  /** Last fresh-session transcript transfer, exposed instead of silently truncating. */
  contextTransfer?: ContextTransferInfo;
  /** Context maintenance state shown in the status popover. */
  contextMaintenance?: {
    kind: 'warning' | 'auto-compaction' | 'manual-compaction';
    percent: number;
    time: number;
    preview?: string;
  };
  /** Usage event time for which automatic compaction was last injected. */
  lastAutoCompactUsageTime?: number;
  /** Timestamp when moved into the plugin conversation recycle bin. */
  deletedAt?: number;
}

export interface ContextTransferInfo {
  transcript: string;
  includedMessages: number;
  omittedMessages: number;
  truncatedMessages: number;
  preview: string;
}

const MAX_MESSAGES_PER_CONVERSATION = 400;

export function createConversation(workspace: string): Conversation {
  return {
    id: randomId(),
    title: '新会话',
    workspace,
    status: 'idle',
    messages: [],
    createdAt: Date.now(),
  };
}

/** Keep the active id inside the visible (non-archived) conversation set. */
export function resolveActiveConversationId(
  conversations: Conversation[],
  requestedId: string | undefined,
): string | undefined {
  const requested = requestedId === undefined
    ? undefined
    : conversations.find((conversation) => conversation.id === requestedId && conversation.closed !== true);
  return requested?.id ?? conversations.find((conversation) => conversation.closed !== true)?.id;
}

/** Detect a Goal response whose only next action is waiting for a future human turn. */
export function isGoalWaitingForUserText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized === '') return false;
  return /(?:没有|无)(?:新的?)?用户(?:提问|问题|输入|请求)/.test(normalized)
    || /(?:等待|等)(?:你|用户).{0,24}(?:提问|问题|输入|回复|指示)/.test(normalized)
    || /(?:目标|协议).{0,24}(?:保持|继续).{0,12}待命/.test(normalized)
    || /(?:no new|without (?:a )?new) (?:user )?(?:question|input|request)/i.test(normalized)
    || /(?:waiting|wait|awaiting|await) for (?:the )?user/i.test(normalized);
}

export function appendMessage(conversation: Conversation, message: ChatMessage): void {
  conversation.messages.push(message);
  if (conversation.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
    conversation.droppedMessageCount = (conversation.droppedMessageCount ?? 0)
      + conversation.messages.length - MAX_MESSAGES_PER_CONVERSATION;
    conversation.messages = conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  }
  pruneChangeSetSnapshots(conversation);
}

/** Keep detailed undo payloads for recent turns without allowing data.json to grow unbounded. */
export function pruneChangeSetSnapshots(conversation: Conversation, keepRecent = 30): void {
  const withChanges = conversation.messages.filter((message) => message.changeSet !== undefined);
  for (const message of withChanges.slice(0, Math.max(0, withChanges.length - keepRecent))) {
    const changeSet = message.changeSet;
    if (changeSet === undefined) continue;
    for (const file of changeSet.files) {
      file.before = undefined;
      file.after = undefined;
      file.reversible = false;
    }
    changeSet.truncated = true;
  }
}

/** Insert an assistant reply directly after its queued user message. */
export function appendAssistantAfterPrompt(
  conversation: Conversation,
  assistant: ChatMessage,
  promptMessageId: string | undefined,
): void {
  appendMessage(conversation, assistant);
  if (promptMessageId === undefined) return;
  const userIndex = conversation.messages.findIndex((message) => message.id === promptMessageId);
  const appendedIndex = conversation.messages.indexOf(assistant);
  if (userIndex === -1 || appendedIndex <= userIndex + 1) return;
  conversation.messages.splice(appendedIndex, 1);
  conversation.messages.splice(userIndex + 1, 0, assistant);
}

function compactStreamText(value: string): string {
  return value.replace(/\s+/g, '');
}

/** Map a whitespace-insensitive prefix length back to an index in the original text. */
function suffixAfterCompactPrefix(value: string, compactPrefix: string): string {
  if (compactPrefix === '') return value;
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (/\s/.test(value[index])) continue;
    count += 1;
    if (count === compactPrefix.length) return value.slice(index + 1);
  }
  return '';
}

/** Commit only the unconsumed tail of a cumulative ACP/JSONL text stream. */
export function appendCumulativeStreamText(message: ChatMessage, cumulative: string): boolean {
  message.text = cumulative;
  const previous = Math.min(message.streamedTextCursor ?? 0, cumulative.length);
  if ((message.streamedTextCursor ?? 0) > cumulative.length) return false;
  message.streamedTextCursor = cumulative.length;
  const tail = cumulative.slice(previous).trim();
  if (tail === '') return false;
  message.blocks ??= [];
  message.blocks.push({ kind: 'text', text: tail });
  return true;
}

/**
 * Repair timelines that persisted cumulative rc.2 snapshots as independent
 * blocks. Non-text block order is preserved; snapshots become novel suffixes.
 */
export function dedupeCumulativeTextBlocks(message: ChatMessage): boolean {
  const blocks = message.blocks ?? [];
  if (blocks.length === 0) return false;
  const cleaned: MessageBlock[] = [];
  let covered = '';
  let changed = false;
  for (const block of blocks) {
    if (block.kind !== 'text') {
      cleaned.push(block);
      continue;
    }
    const raw = block.text.trim();
    const compact = compactStreamText(raw);
    if (compact === '') {
      changed = true;
      continue;
    }
    if (covered === '') {
      cleaned.push(raw === block.text ? block : { ...block, text: raw });
      covered = compact;
      if (raw !== block.text) changed = true;
      continue;
    }
    if (compact === covered || covered.startsWith(compact)) {
      changed = true;
      continue;
    }
    if (compact.startsWith(covered)) {
      const suffix = suffixAfterCompactPrefix(raw, covered).trim();
      const suffixCompact = compactStreamText(suffix);
      if (suffixCompact === '') {
        changed = true;
        continue;
      }
      cleaned.push({ ...block, text: suffix });
      covered += suffixCompact;
      changed = true;
      continue;
    }
    cleaned.push(raw === block.text ? block : { ...block, text: raw });
    covered += compact;
    if (raw !== block.text) changed = true;
  }
  if (changed) message.blocks = cleaned;
  return changed;
}

/**
 * The session log is polled with a settle grace period, and a trailing
 * assistant/message (e.g. the final summary after a multi-step task) can
 * occasionally land after the tailer's last poll. The ACP wire, however,
 * always delivered every committed text. Reconcile the two: if the wire text
 * contains content beyond what the timeline text blocks already show, append
 * the remainder as a final text block so the closing summary is never lost.
 * Returns true when a block was appended.
 */
export function reconcileWireText(message: ChatMessage): boolean {
  const cleaned = dedupeCumulativeTextBlocks(message);
  const wire = message.text.trim();
  if (wire === '') return cleaned;
  const blocks = message.blocks ?? [];
  const textBlocks = blocks.filter(
    (b): b is { kind: 'text'; text: string } => b.kind === 'text',
  );
  const joined = textBlocks.map((b) => b.text).join('').trim();
  if (joined === wire) return cleaned;
  const wireWs = compactStreamText(wire);
  const joinedWs = compactStreamText(joined);
  let tail = '';
  if (joinedWs === '') {
    // No text block landed at all: show the whole wire text.
    tail = wire;
  } else if (wireWs === joinedWs) {
    // Fully covered modulo whitespace differences.
    return cleaned;
  } else if (wireWs.startsWith(joinedWs)) {
    // Blocks are a (whitespace-tolerated) prefix of the wire: the remainder
    // is the missing final text.
    tail = suffixAfterCompactPrefix(wire, joinedWs);
  } else if (joinedWs.startsWith(wireWs)) {
    return cleaned;
  } else if (wireWs !== joinedWs) {
    // Blocks and wire disagree (rare, e.g. out-of-order events). Prefer
    // completeness over perfect dedup: show the wire text.
    tail = wire;
  }
  const trimmed = tail.trim();
  if (trimmed === '') return cleaned;
  message.blocks = blocks;
  message.blocks.push({ kind: 'text', text: trimmed });
  return true;
}

export function deriveTitle(conversation: Conversation): string {
  const firstUser = conversation.messages.find((m) => m.role === 'user');
  if (firstUser === undefined) return '新会话';
  const singleLine = firstUser.text.replace(/\s+/g, ' ').trim();
  return singleLine.length > 24 ? singleLine.slice(0, 24) + '…' : singleLine;
}

const SYNTHETIC_CONTEXT_TITLE_PREFIXES = [
  '以下是我们此前对话的历史',
  '以下是我们先前对话的历史',
];

export function normalizeConversationTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** DSH can derive a title from the injected fresh-session transcript preface. */
export function isSyntheticContextTitle(title: string): boolean {
  const normalized = normalizeConversationTitle(title);
  return SYNTHETIC_CONTEXT_TITLE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** Repair old persisted titles without touching names explicitly set by users. */
export function repairSyntheticContextTitle(conversation: Conversation): boolean {
  if (conversation.titleManuallySet === true || !isSyntheticContextTitle(conversation.title)) return false;
  const repaired = deriveTitle(conversation);
  if (repaired === '新会话' || repaired === conversation.title) return false;
  conversation.title = repaired;
  conversation.titleFromServer = false;
  return true;
}

/** Last user-visible activity time, used for recent-first history ordering. */
export function conversationLastActivity(conversation: Conversation): number {
  let latest = conversation.createdAt;
  for (const message of conversation.messages) latest = Math.max(latest, message.time);
  return latest;
}

/** Latest assistant turn, even when queued user messages follow it. */
export function latestAssistantMessageIndex(conversation: Conversation): number {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    if (conversation.messages[i].role === 'assistant') return i;
  }
  return -1;
}

/** True when every already-rendered message still occupies the same prefix. */
export function isMessageIdPrefix(
  rendered: readonly Pick<ChatMessage, 'id'>[],
  current: readonly Pick<ChatMessage, 'id'>[],
): boolean {
  return rendered.length <= current.length
    && rendered.every((message, index) => message.id === current[index]?.id);
}

/** Whether a detached conversation DOM can be restored before incremental sync. */
export function canReuseRenderedMessageDom(
  rendered: readonly Pick<ChatMessage, 'id'>[],
  current: readonly Pick<ChatMessage, 'id'>[],
): boolean {
  if (rendered.length === 0 || current.length === 0) return false;
  if (isMessageIdPrefix(rendered, current)) return true;
  return rendered.length > current.length
    && rendered[current.length - 1]?.id === current[current.length - 1]?.id;
}

/** Pinned conversations stay first; each group is ordered newest first. */
export function compareConversationsByRecent(a: Conversation, b: Conversation): number {
  const pinOrder = Number(b.pinned === true) - Number(a.pinned === true);
  if (pinOrder !== 0) return pinOrder;
  return conversationLastActivity(b) - conversationLastActivity(a);
}

/** Merge partial usage events without resetting fields omitted by later chunks. */
export function mergeUsageSnapshot(
  previous: TokenUsageSnapshot | undefined,
  update: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number },
  time = Date.now(),
): TokenUsageSnapshot {
  return {
    inputTokens: update.inputTokens ?? previous?.inputTokens ?? 0,
    outputTokens: update.outputTokens ?? previous?.outputTokens ?? 0,
    cacheReadTokens: update.cacheReadTokens ?? previous?.cacheReadTokens ?? 0,
    time,
  };
}

/** Select the most complete copy of text mirrored by ACP and the session log. */
export function mergeMirroredStreamText(canonical: string, mirror: string | undefined): string {
  if (mirror === undefined || mirror === '') return canonical;
  if (canonical === '' || mirror.startsWith(canonical)) return mirror;
  if (canonical.startsWith(mirror)) return canonical;
  // The two transports can flush at different boundaries. Prefer the longer
  // cumulative copy without concatenating and duplicating the answer.
  return mirror.length > canonical.length ? mirror : canonical;
}

/**
 * Return only the live suffix that has not yet landed in timeline blocks.
 * An undefined cursor means the stream is closed, never "start from zero".
 */
export function uncommittedStreamText(message: ChatMessage): string {
  if (message.streamedTextCursor === undefined) return '';
  const wire = mergeMirroredStreamText(message.text, message.streamedText);
  const cursor = Math.min(message.streamedTextCursor, wire.length);
  return wire.slice(cursor);
}

/** Transcript injected when ACP must continue in a fresh server-side session. */
export function transcriptOfMessages(messages: ChatMessage[]): string {
  return contextTransferOfMessages(messages).transcript;
}

/** Build a transparent fresh-session transfer report instead of truncating silently. */
export function contextTransferOfMessages(messages: ChatMessage[]): ContextTransferInfo {
  const lines: string[] = [];
  let truncatedMessages = 0;
  const selected = messages.slice(-30);
  for (const message of selected) {
    const role = message.role === 'user' ? '用户' : 'DSH';
    const wasTruncated = message.text.length > 2000;
    if (wasTruncated) truncatedMessages += 1;
    const text = wasTruncated ? message.text.slice(0, 2000) + '…' : message.text;
    if (text.trim() === '') continue;
    lines.push(role + '：' + text.trim());
  }
  const transcript = lines.length === 0 ? ''
    : '以下是我们此前对话的历史（回退/切换工作区后作为上下文保留，请基于它继续，不要重复已完成的操作）：\n\n'
      + lines.join('\n\n')
      + '\n\n请继续。';
  return {
    transcript,
    includedMessages: lines.length,
    omittedMessages: Math.max(0, messages.length - lines.length),
    truncatedMessages,
    preview: lines.join('\n\n').slice(0, 1200),
  };
}

/** Queue position is based on the immutable message id, not duplicate text. */
export function pendingPromptIndex(conversation: Conversation, messageId: string): number {
  return (conversation.pendingInput ?? []).findIndex((prompt) => prompt.messageId === messageId);
}

export function cancelPendingPrompt(conversation: Conversation, messageId: string): boolean {
  const index = pendingPromptIndex(conversation, messageId);
  if (index < 0) return false;
  conversation.pendingInput?.splice(index, 1);
  const messageIndex = conversation.messages.findIndex((message) => message.id === messageId);
  if (messageIndex >= 0) conversation.messages.splice(messageIndex, 1);
  return true;
}

export function movePendingPrompt(conversation: Conversation, messageId: string, delta: -1 | 1): boolean {
  const queue = conversation.pendingInput ?? [];
  const index = pendingPromptIndex(conversation, messageId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= queue.length) return false;
  [queue[index], queue[target]] = [queue[target], queue[index]];
  const firstMessageIndex = Math.min(
    ...queue.map((prompt) => conversation.messages.findIndex((message) => message.id === prompt.messageId))
      .filter((value) => value >= 0),
  );
  if (Number.isFinite(firstMessageIndex)) {
    const queuedIds = new Set(queue.map((prompt) => prompt.messageId));
    const queuedMessages = new Map(conversation.messages
      .filter((message) => queuedIds.has(message.id))
      .map((message) => [message.id, message]));
    conversation.messages = conversation.messages.filter((message) => !queuedIds.has(message.id));
    conversation.messages.splice(firstMessageIndex, 0, ...queue.map((prompt) => queuedMessages.get(prompt.messageId ?? '') ?? ({
      id: prompt.messageId ?? randomId(), role: 'user' as const, text: prompt.text, time: Date.now(),
      promptSnapshot: JSON.parse(JSON.stringify(prompt)) as PendingPrompt,
    })));
  }
  return true;
}

/**
 * Restore the transcript to the state immediately after the user prompt that
 * produced an answer. The selected answer and every later message are removed,
 * matching the semantics of pressing “regenerate” on that prompt.
 */
export function rewindForAssistantRegeneration(
  conversation: Conversation,
  assistantMessageId: string,
): { userMessage: ChatMessage; contextMessages: ChatMessage[]; userIndex: number } | undefined {
  const assistantIndex = conversation.messages.findIndex(
    (message) => message.id === assistantMessageId && message.role === 'assistant',
  );
  if (assistantIndex < 0 || conversation.messages[assistantIndex].superseded === true) return undefined;
  let userIndex = assistantIndex - 1;
  while (userIndex >= 0 && conversation.messages[userIndex].role !== 'user') userIndex -= 1;
  if (userIndex < 0) return undefined;
  const userMessage = conversation.messages[userIndex];
  const contextMessages = conversation.messages.slice(0, userIndex);
  conversation.messages = conversation.messages.slice(0, assistantIndex);
  conversation.pendingInput = [];
  return { userMessage, contextMessages, userIndex };
}

/** Whether a usage snapshot should trigger one automatic compaction request. */
export function shouldAutoCompact(
  conversation: Conversation,
  contextWindow: number,
  thresholdPercent: number,
  now = Date.now(),
): boolean {
  const usage = conversation.lastUsage;
  if (usage === undefined || contextWindow <= 0 || thresholdPercent <= 0) return false;
  const percent = ((usage.inputTokens + usage.cacheReadTokens) / contextWindow) * 100;
  const recentMaintenance = conversation.contextMaintenance;
  if (recentMaintenance !== undefined
    && recentMaintenance.kind !== 'warning'
    && now - recentMaintenance.time < 10 * 60 * 1000) return false;
  return percent >= thresholdPercent && conversation.lastAutoCompactUsageTime !== usage.time;
}

/**
 * Messages that precede queued-but-not-yet-dispatched user turns. Queued
 * prompts are already visible in the transcript, so reconnect history must
 * not inject them a second time.
 */
export function messagesBeforePending(conversation: Conversation): ChatMessage[] {
  const pending = conversation.pendingInput ?? [];
  let end = conversation.messages.length;
  for (let i = pending.length - 1; i >= 0 && end > 0; i--) {
    const message = conversation.messages[end - 1];
    if (message.role !== 'user'
      || (pending[i].messageId !== undefined
        ? message.id !== pending[i].messageId
        : message.text !== pending[i].text)) break;
    end -= 1;
  }
  return conversation.messages.slice(0, end);
}

/** Create a real branch: clone through one message and inject that history. */
export function createConversationBranch(source: Conversation, throughMessageId: string): Conversation {
  const index = source.messages.findIndex((message) => message.id === throughMessageId);
  const end = index === -1 ? source.messages.length : index + 1;
  const branch = createConversation(source.workspace);
  branch.title = source.title;
  branch.branchedFrom = source.id;
  branch.messages = source.messages.slice(0, end).map((message) => {
    const cloned = JSON.parse(JSON.stringify(message)) as ChatMessage;
    // A branch copies conversational context, not ownership of file mutations.
    // Duplicating a change set would allow the branch to undo the source turn.
    cloned.changeSet = undefined;
    cloned.id = randomId();
    return cloned;
  });
  const transcript = transcriptOfMessages(branch.messages);
  branch.rewindContext = transcript !== '' ? transcript : undefined;
  return branch;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
