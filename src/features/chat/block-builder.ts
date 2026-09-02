// Pure timeline assembler: turns tailer events into ordered render blocks.
import type { ChatMessage, GoalCard, MessageBlock, TodoItem, ToolActivity, WorkflowRun } from './session';

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
      const incoming = normalizeReasoningText(reasoning);
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
        target.text = mergeReasoningText(target.text, incoming);
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
          this.blocks.push({ kind: 'thinking', text: novel, ...position });
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
  for (const chunk of chunks) {
    const current = output.join('\n');
    if (current === '') {
      output.push(chunk);
    } else if (current === chunk || output.includes(chunk)) {
      continue;
    } else if (chunk.startsWith(current)) {
      output.length = 0;
      output.push(chunk);
    } else {
      output.push(chunk);
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

  const maxOverlap = Math.min(before.length, next.length);
  for (let size = maxOverlap; size >= 12; size--) {
    if (before.slice(-size) === next.slice(0, size)) {
      return normalizeReasoningText(before + next.slice(size));
    }
  }
  return normalizeReasoningText(before + '\n' + next);
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
