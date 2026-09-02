// Pure timeline assembler: turns tailer events into ordered render blocks.
import type { ChatMessage, GoalCard, MessageBlock, TodoItem, ToolActivity, WorkflowRun } from './session';

const TIMELINE_REASONING_LIMIT = 40_000;
const REASONING_TRUNCATION_MARK = '…（较早的思考过程已截断，完整记录仍在会话日志中）…\n';

export class BlockBuilder {
  private blocks: MessageBlock[] = [];

  /** Attach to a message (resume an existing timeline, e.g. from data.json). */
  static from(message: ChatMessage): BlockBuilder {
    const builder = new BlockBuilder();
    builder.blocks = message.blocks ?? [];
    return builder;
  }

  list(): MessageBlock[] {
    return this.blocks;
  }

  applyStepMessage(
    reasoning: string | undefined,
    text: string | undefined,
    position?: { turn: number; step: number },
  ): void {
    if (reasoning !== undefined && reasoning.trim() !== '') {
      const incoming = normalizeReasoningText(limitReasoning(reasoning));
      type ThinkingBlock = Extract<MessageBlock, { kind: 'thinking' }>;
      const sameStep: ThinkingBlock | undefined = position === undefined
        ? undefined
        : this.blocks.find((block): block is ThinkingBlock => block.kind === 'thinking'
          && block.turn === position.turn && block.step === position.step);
      const last = this.blocks[this.blocks.length - 1];
      const target: ThinkingBlock | undefined = sameStep
        ?? (position === undefined && last?.kind === 'thinking' ? last : undefined);
      if (target !== undefined) {
        // assistant/message events are complete snapshots. Replace/extend the
        // previous snapshot instead of concatenating the whole prefix again.
        target.text = limitReasoning(mergeReasoningText(target.text, incoming));
        if (position !== undefined) {
          target.turn = position.turn;
          target.step = position.step;
        }
      } else {
        const prior = this.blocks
          .filter((block): block is Extract<MessageBlock, { kind: 'thinking' }> => block.kind === 'thinking')
          .map((block) => block.text);
        const novel = novelReasoningText(prior, incoming);
        if (novel !== '') {
          this.blocks.push({ kind: 'thinking', text: limitReasoning(novel), ...position });
        }
      }
    }
    if (text !== undefined && text.trim() !== '') {
      const trimmed = text.trim();
      // Dedup: the same committed text may arrive from both the ACP wire and
      // the session log — keep a single block.
      if (!this.blocks.some((block) => block.kind === 'text' && block.text === trimmed)) {
        this.blocks.push({ kind: 'text', text: trimmed });
      }
    }
  }

  applyToolCall(activity: ToolActivity): void {
    this.blocks.push({ kind: 'tool', activity });
  }

  applyTodoWrite(todos: TodoItem[]): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last !== undefined && last.kind === 'todo') {
      last.todos = todos;
      return;
    }
    this.blocks.push({ kind: 'todo', todos });
  }

  applyGoalChange(card: GoalCard): void {
    this.blocks.push({ kind: 'goal', card });
  }

  applyWorkflowRunStart(run: WorkflowRun): void {
    this.blocks.push({ kind: 'workflow', run });
  }

  /** The workflow/tool activity objects are mutated in place — no new blocks. */
}

/** Collapse repeated/cumulative reasoning lines already persisted by old builds. */
export function normalizeReasoningText(text: string): string {
  const chunks = text.split(/\n+/).map((line) => line.trim()).filter((line) => line !== '');
  const output: string[] = [];
  const seen = new Set<string>();
  let current = '';
  for (const chunk of chunks) {
    if (current === '') {
      output.push(chunk);
      seen.add(chunk);
      current = chunk;
    } else if (current === chunk || seen.has(chunk)) {
      continue;
    } else if (chunk.startsWith(current)) {
      output.length = 0;
      output.push(chunk);
      seen.clear();
      seen.add(chunk);
      current = chunk;
    } else {
      output.push(chunk);
      seen.add(chunk);
      current += '\n' + chunk;
    }
  }
  return output.join('\n');
}

/** Merge two complete snapshots while preserving only genuinely new text. */
export function mergeReasoningText(previous: string, incoming: string): string {
  const before = normalizeReasoningText(previous);
  const next = normalizeReasoningText(incoming);
  if (before === '') return next;
  if (next === '' || before === next || before.startsWith(next)) return before;
  if (next.startsWith(before)) return next;

  const overlap = suffixPrefixOverlap(before, next);
  if (overlap >= 12) return normalizeReasoningText(before + next.slice(overlap));
  return normalizeReasoningText(before + '\n' + next);
}

/** Linear-time longest suffix/prefix match (avoids quadratic slice scans). */
function suffixPrefixOverlap(before: string, next: string): number {
  const max = Math.min(before.length, next.length);
  if (max === 0) return 0;
  const pattern = next.slice(0, max);
  const prefix = new Uint32Array(pattern.length);
  for (let i = 1, matched = 0; i < pattern.length; i++) {
    while (matched > 0 && pattern.charCodeAt(i) !== pattern.charCodeAt(matched)) matched = prefix[matched - 1];
    if (pattern.charCodeAt(i) === pattern.charCodeAt(matched)) matched += 1;
    prefix[i] = matched;
  }
  let matched = 0;
  const tail = before.slice(-max);
  for (let i = 0; i < tail.length; i++) {
    const code = tail.charCodeAt(i);
    while (matched > 0 && code !== pattern.charCodeAt(matched)) matched = prefix[matched - 1];
    if (code === pattern.charCodeAt(matched)) matched += 1;
    if (matched === pattern.length && i < tail.length - 1) matched = prefix[matched - 1];
  }
  return matched;
}

function limitReasoning(text: string): string {
  if (text.length <= TIMELINE_REASONING_LIMIT) return text;
  return REASONING_TRUNCATION_MARK + text.slice(-(TIMELINE_REASONING_LIMIT - REASONING_TRUNCATION_MARK.length));
}

/** Remove a cumulative prefix already represented by earlier thinking blocks. */
function novelReasoningText(existing: string[], incoming: string): string {
  if (existing.some((text) => text === incoming || text.startsWith(incoming))) return '';
  const prefixes = [...existing].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (incoming.startsWith(prefix)) {
      return normalizeReasoningText(incoming.slice(prefix.length));
    }
  }
  return incoming;
}
