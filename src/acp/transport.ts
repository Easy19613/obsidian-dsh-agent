// NDJSON framing over the child's stdin/stdout.
// Adapted in spirit from Claudian's ACP transport (MIT, github.com/YishenTu/claudian).
import { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from './types';

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ServerRequestHandler = (request: JsonRpcRequest) => void;
export type ServerNotificationHandler = (notification: JsonRpcNotification) => void;

/**
 * One JSON-RPC object per line. Incremental UTF-8 decoding via StringDecoder
 * so multi-byte characters (中文) never get split across chunk boundaries.
 */
export class NdjsonTransport {
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private pending = new Map<number | string, PendingEntry>();
  private nextId = 1;
  private serverRequestHandler: ServerRequestHandler | null = null;
  private serverNotificationHandlers = new Set<ServerNotificationHandler>();
  private closed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onFatal?: (error: Error) => void,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleData(chunk));
  }

  /** Send a request and await its response. */
  request(method: string, params: unknown, timeoutMs = 0): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('transport is closed'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingEntry = {
        resolve,
        reject,
        timer: null as unknown as ReturnType<typeof setTimeout>,
      };
      entry.timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`request timeout: ${method}`));
          }, timeoutMs)
        : null as unknown as ReturnType<typeof setTimeout>;
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Answer a server-side request. */
  respond(id: number | string, result: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    if (this.closed) return;
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  onServerNotification(handler: ServerNotificationHandler): () => void {
    this.serverNotificationHandlers.add(handler);
    return () => this.serverNotificationHandlers.delete(handler);
  }

  /** Reject every in-flight request (backend exit / protocol error). */
  failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer ?? undefined);
      entry.reject(error);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.closed = true;
    this.failAll(new Error('transport disposed'));
    this.serverRequestHandler = null;
    this.serverNotificationHandlers.clear();
  }

  private write(obj: Record<string, unknown>): void {
    try {
      this.child.stdin.write(JSON.stringify(obj) + '\n');
    } catch (error) {
      this.onFatal?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleData(chunk: string): void {
    this.buffer += this.decoder.write(chunk);
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line === '') continue;
      let message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
      try {
        message = JSON.parse(line) as JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
      } catch {
        // Non-protocol bytes on stdout: a fatal protocol violation per the
        // ACP contract (stdout carries only JSON-RPC).
        this.onFatal?.(new Error(`bad protocol line on stdout: ${line.slice(0, 160)}`));
        return;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    if ('id' in message && message.id !== undefined) {
      if ('method' in message) {
        // server -> client request (e.g. session/request_permission)
        this.serverRequestHandler?.(message as JsonRpcRequest);
      } else {
        // response to one of our requests
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer ?? undefined);
        const response = message as JsonRpcResponse;
        if (response.error !== undefined) {
          entry.reject(new Error(`${response.error.message} (${JSON.stringify(response.error.data ?? '')})`));
        } else {
          entry.resolve(response.result);
        }
      }
    } else {
      // server -> client notification (e.g. session/update)
      const notification = message as JsonRpcNotification;
      for (const handler of [...this.serverNotificationHandlers]) {
        try {
          handler(notification);
        } catch (error) {
          console.error('dsh-agent: notification handler error', error);
        }
      }
    }
  }
}
