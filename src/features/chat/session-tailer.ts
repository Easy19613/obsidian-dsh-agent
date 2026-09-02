// Tails the DSH session JSONL (persistenceCompression: 'none') to observe
// tool calls, results, todo snapshots, and titles that never travel on the
// ACP wire. Path encoding mirrors dsh-session-persistence-jsonl:
//   projectKey(cwd): separators (:/\\) collapse to '-', other non-safe chars
//                    become ~XXXX, wrapped as --key--, capped at 251
//   encodeSegment(id): safe [A-Za-z0-9._-] kept, '~' and others become ~XXXX
import { watchFile, unwatchFile } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { TodoItem } from './session';

export interface TailerCallbacks {
  /** Any durable session event, including provider retry and reasoning batches. */
  onActivity?(): void;
  onToolCall(callId: string, name: string, argumentsJson: string): void;
  onToolResult(callId: string, resultText: string, errorName: string | undefined, errorCode: string | undefined, meta: unknown): void;
  onTodoWrite(todos: TodoItem[]): void;
  onTitle(title: string): void;
  onReasoningDelta(text: string, turn?: number, step?: number): void;
  onTextDelta?(text: string, turn?: number, step?: number): void;
  onUsage?(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }): void;
  onStepMessage(turn: number, step: number, reasoning: string | undefined, text: string | undefined): void;
  onGoalChange(change: unknown): void;
  onWorkflowRunStart(run: { runId: string; name: string; startedAt?: number }): void;
  onWorkflowAgentStart(agent: { runId: string; seq: number; label: string; phase?: string; childId?: string; startedAt?: number }): void;
  onWorkflowAgentEnd(agent: { runId: string; seq: number; outcome?: string; endedAt?: number }): void;
  onWorkflowRunEnd(run: { runId: string; stopReason?: string; endedAt?: number }): void;
  onSubagentMessage?(message: { childId: string; kind: 'report' | 'settled'; text: string; stopReason?: string }): void;
  onTurnEnd?(reason: string | undefined, time: number | undefined): void;
}

const POLL_INTERVAL_MS = 500;

export function projectKey(cwd: string): string {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return '--' + (readable.replace(/^-+/, '') || 'root').slice(0, 251) + '--';
}

export function encodeSegment(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Resolve the session JSONL path from the backend's persistence root. */
export function sessionLogPath(persistenceRoot: string, cwd: string, sessionId: string): string {
  const root = persistenceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  return [root, projectKey(cwd), encodeSegment(sessionId), 'session.jsonl'].join('/');
}

/**
 * Polling tailer: reads only the appended bytes, parses complete ndjson lines,
 * and dispatches the events the UI renders. fs.watchFile (stat-based) is used
 * for change notifications; polling keeps a hard upper bound on latency and
 * works when the watcher misses events.
 */
export class SessionTailer {
  private offset = 0;
  private buffer = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private watching = false;
  private readonly watchHandler = (): void => {
    void this.poll(false);
  };

  constructor(
    private readonly filePath: string,
    private readonly callbacks: TailerCallbacks,
  ) {}

  start(): void {
    if (this.disposed || this.timer !== null) return;
    this.watch();
    void this.poll(false);
    this.timer = setInterval(() => {
      void this.poll(false);
    }, POLL_INTERVAL_MS);
  }

  /** One final synchronous drain (used when a turn settles). */
  async flush(): Promise<void> {
    await this.poll(false);
  }

  pause(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watching) {
      try {
        unwatchFile(this.filePath, this.watchHandler);
      } catch {
        // never watched or already gone
      }
      this.watching = false;
    }
  }

  stop(): void {
    this.disposed = true;
    this.pause();
  }

  private polling = false;
  private pendingPoll = false;

  /** Read appended bytes and dispatch complete lines (serialized). */
  async poll(initial: boolean): Promise<void> {
    if (this.disposed) return;
    if (this.polling) {
      this.pendingPoll = true;
      return;
    }
    this.polling = true;
    try {
      await this.pollOnce(initial);
    } finally {
      this.polling = false;
      if (this.pendingPoll) {
        this.pendingPoll = false;
        void this.poll(false);
      }
    }
  }

  private async pollOnce(_initial: boolean): Promise<void> {
    try {
      const info = await stat(this.filePath).catch(() => null);
      if (info === null) return;
      if (info.size < this.offset) {
        // File replaced or truncated — restart from the beginning.
        this.offset = 0;
        this.buffer = '';
      }
      if (info.size === this.offset) return;
      const length = Math.min(info.size - this.offset, 512 * 1024);
      const handle = await open(this.filePath, 'r');
      try {
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, this.offset);
        if (bytesRead === 0) return;
        this.offset += bytesRead;
        this.buffer += chunk.subarray(0, bytesRead).toString('utf8');
        this.drain();
      } finally {
        await handle.close();
      }
    } catch {
      // File mid-write or briefly unavailable — next poll retries.
    }
  }

  private watch(): void {
    if (this.watching) return;
    try {
      watchFile(this.filePath, { interval: 500 }, this.watchHandler);
      this.watching = true;
    } catch {
      // watcher registration failure is non-fatal; polling continues
    }
  }

  private drain(): void {
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line === '') continue;
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let event: { type?: string; time?: number; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line) as { type?: string; time?: number; data?: Record<string, unknown> };
    } catch {
      return;
    }
    this.callbacks.onActivity?.();
    const data = event.data;
    if (data === undefined) return;
    switch (event.type) {
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'tool';
        const argumentsJson = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {});
        const callId = typeof data.callId === 'string' ? data.callId : '';
        this.callbacks.onToolCall(callId, name, argumentsJson);
        break;
      }
      case 'tool/result': {
        const callId = extractCallId(data);
        const resultText = extractResultText(data);
        const errorName = (data.error as { name?: string } | undefined)?.name;
        const errorCode = (data.error as { code?: string } | undefined)?.code;
        this.callbacks.onToolResult(callId, resultText, errorName, errorCode, data.meta);
        break;
      }
      case 'todo/write': {
        const todos = data.todos;
        if (Array.isArray(todos)) {
          this.callbacks.onTodoWrite(todos as TodoItem[]);
        }
        break;
      }
      case 'session/title': {
        const title = (data as { title?: string }).title;
        if (typeof title === 'string' && title.trim() !== '') {
          this.callbacks.onTitle(title);
        }
        break;
      }
      case 'assistant/chunk': {
        const chunk = data.chunk as { type?: string; text?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } };
        const turn = typeof data.turn === 'number' ? data.turn : undefined;
        const step = typeof data.step === 'number' ? data.step : undefined;
        if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          this.callbacks.onReasoningDelta(chunk.text, turn, step);
        }
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
          this.callbacks.onTextDelta?.(chunk.text, turn, step);
        }
        if (chunk?.type === 'usage' && chunk.usage !== undefined) {
          this.callbacks.onUsage?.(chunk.usage);
        }
        break;
      }
      case 'reasoning-chunks':
      case 'text-chunks': {
        const texts = Array.isArray(data.texts)
          ? data.texts.filter((value): value is string => typeof value === 'string')
          : [];
        const text = texts.join('');
        if (text === '') break;
        const turn = typeof data.turn === 'number' ? data.turn : undefined;
        const step = typeof data.step === 'number' ? data.step : undefined;
        if (event.type === 'reasoning-chunks') this.callbacks.onReasoningDelta(text, turn, step);
        else this.callbacks.onTextDelta?.(text, turn, step);
        break;
      }
      case 'assistant/message': {
        const turn = typeof data.turn === 'number' ? data.turn : 0;
        const step = typeof data.step === 'number' ? data.step : 0;
        let reasoning: string | undefined;
        let text: string | undefined;
        const blocks = (data.message as { content?: unknown[] } | undefined)?.content;
        if (Array.isArray(blocks)) {
          const reasoningParts: string[] = [];
          for (const block of blocks) {
            const b = block as { type?: string; text?: string };
            if (typeof b.text !== 'string' || b.text === '') continue;
            if (b.type === 'reasoning') reasoningParts.push(b.text);
            else if (b.type === 'text') text = (text ?? '') === '' ? b.text : text + '\n' + b.text;
          }
          if (reasoningParts.length > 0) reasoning = reasoningParts.join('\n');
        }
        this.callbacks.onStepMessage(turn, step, reasoning, text);
        break;
      }
      case 'user/message': {
        const message = data.message as {
          source?: { kind?: string; senderSessionId?: string };
          content?: unknown[];
        } | undefined;
        const source = message?.source;
        if ((source?.kind === 'subagent-report' || source?.kind === 'subagent-settled')
          && typeof source.senderSessionId === 'string') {
          const parts: string[] = [];
          for (const block of message?.content ?? []) {
            const item = block as { type?: string; text?: string };
            if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
          }
          const text = parts.join('\n');
          this.callbacks.onSubagentMessage?.({
            childId: source.senderSessionId,
            kind: source.kind === 'subagent-report' ? 'report' : 'settled',
            text,
            ...(source.kind === 'subagent-settled' ? { stopReason: settlementReason(text) } : {}),
          });
        }
        break;
      }
      case 'goal/change': {
        this.callbacks.onGoalChange(data);
        break;
      }
      case 'tool-workflow/run-start': {
        const runId = typeof data.runId === 'string' ? data.runId : '';
        const name = typeof data.name === 'string' ? data.name : 'workflow';
        this.callbacks.onWorkflowRunStart({ runId, name, startedAt: event.time });
        break;
      }
      case 'tool-workflow/agent-start': {
        this.callbacks.onWorkflowAgentStart({
          runId: typeof data.runId === 'string' ? data.runId : '',
          seq: typeof data.seq === 'number' ? data.seq : 0,
          label: typeof data.label === 'string' ? data.label : '',
          phase: typeof data.phase === 'string' ? data.phase : undefined,
          childId: typeof data.childId === 'string' ? data.childId : undefined,
          startedAt: event.time,
        });
        break;
      }
      case 'tool-workflow/agent-end': {
        this.callbacks.onWorkflowAgentEnd({
          runId: typeof data.runId === 'string' ? data.runId : '',
          seq: typeof data.seq === 'number' ? data.seq : 0,
          outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
          endedAt: event.time,
        });
        break;
      }
      case 'tool-workflow/run-end': {
        this.callbacks.onWorkflowRunEnd({
          runId: typeof data.runId === 'string' ? data.runId : '',
          stopReason: typeof data.stopReason === 'string' ? data.stopReason : undefined,
          endedAt: event.time,
        });
        break;
      }
      case 'turn/end': {
        const kind = (data.reason as { kind?: string } | undefined)?.kind;
        this.callbacks.onTurnEnd?.(typeof kind === 'string' ? kind : undefined, event.time);
        break;
      }
      default:
        break;
    }
  }
}

function settlementReason(text: string): string | undefined {
  if (text.includes(' finished and will do no further work')) return 'completed';
  if (text.includes(' was stopped before it finished')) return 'aborted';
  if (text.includes(' ran out of room')) return 'max-tokens';
  if (text.includes(' declined the task')) return 'refusal';
  if (text.includes(' failed before it finished')) return 'error';
  const abnormal = /ended abnormally \(([^)]+)\)/.exec(text);
  return abnormal?.[1];
}

function extractCallId(data: Record<string, unknown>): string {
  const message = data.message as { source?: { callId?: string }; content?: unknown[] } | undefined;
  if (typeof message?.source?.callId === 'string') return message.source.callId;
  const content = message?.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as { toolCallId?: string };
    if (typeof first.toolCallId === 'string') return first.toolCallId;
  }
  return '';
}

function extractResultText(data: Record<string, unknown>): string {
  const message = data.message as { content?: unknown[] } | undefined;
  const content = message?.content;
  if (!Array.isArray(content) || content.length === 0) return '';
  const first = content[0] as { content?: unknown[] };
  if (!Array.isArray(first.content)) return '';
  const parts: string[] = [];
  for (const block of first.content) {
    const b = block as { type?: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}
