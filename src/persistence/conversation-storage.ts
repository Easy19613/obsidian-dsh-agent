import type {
  ChatMessage,
  Conversation,
  GoalCard,
  MessageBlock,
  TodoItem,
  ToolActivity,
  WorkflowAgent,
  WorkflowRun,
} from '../features/chat/session';

/**
 * data.json is UI state, not the authoritative execution log. Keep enough
 * tool output to render useful cards while the complete event stream remains
 * available in the per-session JSONL files.
 */
export const STORED_TOOL_RESULT_LIMIT = 12_000;
export const STORED_TOOL_ARGUMENT_LIMIT = 16_000;
export const STORED_THINKING_LIMIT = 40_000;
const STORED_META_BUDGET = 12_000;
const STORED_WORKFLOW_TEXT_LIMIT = 20_000;

const TOOL_TRUNCATION_MARK = '\n\n…（持久化预览已截断；完整内容保留在原始会话日志中）…\n\n';
const THINKING_TRUNCATION_MARK = '\n\n…（较早的思考过程已从界面缓存中截断；完整内容保留在原始会话日志中）…\n\n';

/** Produce a detached, bounded snapshot suitable for Obsidian saveData(). */
export function compactConversationForStorage(conversation: Conversation): Conversation {
  const { messages: _messages, ...durableConversation } = conversation;
  return {
    ...cloneStorageValue(durableConversation),
    messages: conversation.messages.map(compactMessageForStorage),
  };
}

/**
 * Rebuild the legacy convenience collections from the canonical timeline.
 * Old builds persisted both forms, which doubled every tool result in JSON.
 */
export function rehydrateConversationForRuntime(conversation: Conversation): void {
  for (const message of conversation.messages) {
    if (message.role !== 'assistant') continue;
    const blocks = canonicalBlocks(message).map(compactBlockForStorage);
    message.blocks = blocks;
    message.toolActivities = blocks
      .filter((block): block is Extract<MessageBlock, { kind: 'tool' }> => block.kind === 'tool')
      .map((block) => block.activity);
    message.goalCards = blocks
      .filter((block): block is Extract<MessageBlock, { kind: 'goal' }> => block.kind === 'goal')
      .map((block) => block.card);
    message.workflowRuns = blocks
      .filter((block): block is Extract<MessageBlock, { kind: 'workflow' }> => block.kind === 'workflow')
      .map((block) => block.run);
    const latestTodo = [...blocks].reverse().find(
      (block): block is Extract<MessageBlock, { kind: 'todo' }> => block.kind === 'todo',
    );
    message.todos = latestTodo?.todos;
    message.reasoning = undefined;
  }
}

/** Generic detached clone for the small non-conversation parts of data.json. */
export function cloneStorageValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneStorageValue(entry)) as T;
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) output[key] = cloneStorageValue(child);
    }
    return output as T;
  }
  return value;
}

function compactMessageForStorage(message: ChatMessage): ChatMessage {
  const {
    blocks: _blocks,
    toolActivities: _toolActivities,
    todos: _todos,
    reasoning: _reasoning,
    liveReasoning: _liveReasoning,
    liveReasoningKey: _liveReasoningKey,
    streamedText: _streamedText,
    streamedTextCursor: _streamedTextCursor,
    goalCards: _goalCards,
    workflowRuns: _workflowRuns,
    ...durableMessage
  } = message;
  const snapshot = cloneStorageValue(durableMessage) as ChatMessage;
  if (message.role === 'assistant') snapshot.blocks = canonicalBlocks(message).map(compactBlockForStorage);
  return snapshot;
}

function canonicalBlocks(message: ChatMessage): MessageBlock[] {
  const blocks: MessageBlock[] = Array.isArray(message.blocks) ? [...message.blocks] : [];

  if (typeof message.reasoning === 'string' && message.reasoning.trim() !== ''
    && !blocks.some((block) => block.kind === 'thinking')) {
    blocks.unshift({ kind: 'thinking', text: message.reasoning });
  }

  const toolIds = new Set(blocks
    .filter((block): block is Extract<MessageBlock, { kind: 'tool' }> => block.kind === 'tool')
    .map((block) => block.activity.callId));
  for (const activity of message.toolActivities ?? []) {
    if (toolIds.has(activity.callId)) continue;
    toolIds.add(activity.callId);
    blocks.push({ kind: 'tool', activity });
  }

  const goalKeys = new Set(blocks
    .filter((block): block is Extract<MessageBlock, { kind: 'goal' }> => block.kind === 'goal')
    .map((block) => goalKey(block.card)));
  for (const card of message.goalCards ?? []) {
    const key = goalKey(card);
    if (goalKeys.has(key)) continue;
    goalKeys.add(key);
    blocks.push({ kind: 'goal', card });
  }

  const workflowIds = new Set(blocks
    .filter((block): block is Extract<MessageBlock, { kind: 'workflow' }> => block.kind === 'workflow')
    .map((block) => block.run.runId));
  for (const run of message.workflowRuns ?? []) {
    if (workflowIds.has(run.runId)) continue;
    workflowIds.add(run.runId);
    blocks.push({ kind: 'workflow', run });
  }

  if (message.todos !== undefined && !blocks.some((block) => block.kind === 'todo')) {
    blocks.push({ kind: 'todo', todos: message.todos });
  }

  if (message.role === 'assistant' && message.text.trim() !== ''
    && !blocks.some((block) => block.kind === 'text')) {
    blocks.push({ kind: 'text', text: message.text.trim() });
  }
  return blocks;
}

function compactBlockForStorage(block: MessageBlock): MessageBlock {
  switch (block.kind) {
    case 'thinking':
      return {
        ...block,
        text: boundedText(block.text, STORED_THINKING_LIMIT, THINKING_TRUNCATION_MARK),
      };
    case 'text':
      return { kind: 'text', text: block.text };
    case 'tool':
      return { kind: 'tool', activity: compactToolActivity(block.activity) };
    case 'goal':
      return { kind: 'goal', card: compactGoalCard(block.card) };
    case 'workflow':
      return { kind: 'workflow', run: compactWorkflowRun(block.run) };
    case 'todo':
      return { kind: 'todo', todos: compactTodos(block.todos) };
  }
}

function compactToolActivity(activity: ToolActivity): ToolActivity {
  return {
    ...activity,
    argumentsJson: compactArgumentsJson(activity.argumentsJson),
    resultText: boundedText(activity.resultText, STORED_TOOL_RESULT_LIMIT, TOOL_TRUNCATION_MARK),
    ...(activity.meta === undefined ? {} : { meta: compactMeta(activity.meta) }),
  };
}

function compactArgumentsJson(value: string): string {
  if (value.length <= STORED_TOOL_ARGUMENT_LIMIT) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    const budget = { remaining: STORED_TOOL_ARGUMENT_LIMIT - 256 };
    const compact = compactUnknown(parsed, budget, 0);
    if (compact !== null && typeof compact === 'object' && !Array.isArray(compact)) {
      (compact as Record<string, unknown>).__dshTruncated = '完整参数保留在原始会话日志中';
    }
    const encoded = JSON.stringify(compact);
    if (encoded.length <= STORED_TOOL_ARGUMENT_LIMIT) return encoded;
  } catch {
    // Preserve a readable prefix/tail when a tool supplied non-JSON arguments.
  }
  return boundedText(value, STORED_TOOL_ARGUMENT_LIMIT, TOOL_TRUNCATION_MARK);
}

function compactMeta(meta: unknown): unknown {
  const budget = { remaining: STORED_META_BUDGET };
  return compactUnknown(meta, budget, 0);
}

function compactUnknown(value: unknown, budget: { remaining: number }, depth: number, key = ''): unknown {
  if (budget.remaining <= 0) return '…（已截断）';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    budget.remaining -= 16;
    return value;
  }
  if (typeof value === 'string') {
    const limit = Math.max(0, Math.min(value.length, budget.remaining, 4_000));
    budget.remaining -= limit;
    return value.length > limit ? value.slice(0, limit) + '…（已截断）' : value;
  }
  if (depth >= 6) return '…（层级过深已截断）';
  if (Array.isArray(value)) {
    if (key === 'lines') {
      budget.remaining -= 16;
      return value.length;
    }
    const limit = key === 'paths' ? 50 : 30;
    const output = value.slice(0, limit).map((entry) => compactUnknown(entry, budget, depth + 1));
    if (value.length > limit) output.push('…（其余 ' + (value.length - limit) + ' 项已截断）');
    return output;
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [childKey, child] of entries.slice(0, 40)) {
      budget.remaining -= childKey.length;
      output[childKey] = compactUnknown(child, budget, depth + 1, childKey);
      if (budget.remaining <= 0) break;
    }
    if (entries.length > 40 || budget.remaining <= 0) output.truncated = true;
    return output;
  }
  return String(value);
}

function compactGoalCard(card: GoalCard): GoalCard {
  return {
    ...card,
    ...(card.objective === undefined
      ? {}
      : { objective: boundedText(card.objective, STORED_WORKFLOW_TEXT_LIMIT, TOOL_TRUNCATION_MARK) }),
    ...(card.blockedReason === undefined
      ? {}
      : { blockedReason: boundedText(card.blockedReason, STORED_WORKFLOW_TEXT_LIMIT, TOOL_TRUNCATION_MARK) }),
  };
}

function compactWorkflowRun(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    ...(run.report === undefined
      ? {}
      : { report: boundedText(run.report, STORED_WORKFLOW_TEXT_LIMIT, TOOL_TRUNCATION_MARK) }),
    agents: run.agents.slice(0, 200).map(compactWorkflowAgent),
  };
}

function compactWorkflowAgent(agent: WorkflowAgent): WorkflowAgent {
  return {
    ...agent,
    ...(agent.prompt === undefined
      ? {}
      : { prompt: boundedText(agent.prompt, STORED_WORKFLOW_TEXT_LIMIT, TOOL_TRUNCATION_MARK) }),
    ...(agent.report === undefined
      ? {}
      : { report: boundedText(agent.report, STORED_WORKFLOW_TEXT_LIMIT, TOOL_TRUNCATION_MARK) }),
    ...(agent.lastOutput === undefined
      ? {}
      : { lastOutput: boundedText(agent.lastOutput, STORED_WORKFLOW_TEXT_LIMIT, TOOL_TRUNCATION_MARK) }),
  };
}

function compactTodos(todos: TodoItem[]): TodoItem[] {
  return todos.slice(0, 200).map((todo) => ({
    ...todo,
    content: boundedText(todo.content, 4_000, TOOL_TRUNCATION_MARK),
  }));
}

function boundedText(value: string, limit: number, marker: string): string {
  if (value.length <= limit) return value;
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return value.slice(0, head) + marker + (tail > 0 ? value.slice(-tail) : '');
}

function goalKey(card: GoalCard): string {
  return card.operation + ':' + card.time;
}
