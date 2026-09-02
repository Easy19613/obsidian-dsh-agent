// ACP client connection: initialize/newSession/prompt/cancel + notification
// and permission-request routing. Modeled on Claudian's AcpClientConnection
// (MIT, github.com/YishenTu/claudian) but scoped to the dsh-acp surface.
import type {
  AcpAgentCapabilities,
  AcpCancelNotificationParams,
  AcpInitializeResult,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpPromptBlock,
  AcpPromptResult,
  AcpRequestPermissionParams,
  AcpRequestPermissionResult,
  AcpSessionUpdateNotification,
  JsonRpcRequest,
} from './types';
import { NdjsonTransport } from './transport';

export type MessageChunkListener = (sessionId: string, text: string) => void;
export type PermissionRequestHandler = (
  request: JsonRpcRequest,
  params: AcpRequestPermissionParams,
) => Promise<AcpRequestPermissionResult>;

export interface AcpClientConnectionOptions {
  clientInfo: { name: string; version: string };
  transport: NdjsonTransport;
}

export class AcpClientConnection {
  private agentCapabilities: AcpAgentCapabilities | null = null;
  private agentInfo: { name: string; version: string } | null = null;
  private chunkListeners = new Set<MessageChunkListener>();
  private permissionHandler: PermissionRequestHandler | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: AcpClientConnectionOptions) {
    this.unsubscribe = options.transport.onServerNotification((notification) => {
      this.handleNotification(notification);
    });
    options.transport.onServerRequest((request) => {
      void this.handleServerRequest(request);
    });
  }

  get negotiatedAgentCapabilities(): AcpAgentCapabilities | null {
    return this.agentCapabilities;
  }

  get negotiatedAgentInfo(): { name: string; version: string } | null {
    return this.agentInfo;
  }

  async initialize(): Promise<AcpInitializeResult> {
    const result = await this.options.transport.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: this.options.clientInfo,
    }, 90_000) as AcpInitializeResult;
    this.agentCapabilities = result.agentCapabilities;
    this.agentInfo = result.agentInfo;
    if (result.authMethods !== undefined && result.authMethods.length > 0) {
      await this.options.transport.request('authenticate', {
        methodId: result.authMethods[0].id,
      }, 30_000);
    }
    return result;
  }

  async newSession(cwd: string): Promise<AcpNewSessionResult> {
    const params: AcpNewSessionParams = { cwd, mcpServers: [] };
    return this.options.transport.request('session/new', params, 60_000) as Promise<AcpNewSessionResult>;
  }

  /**
   * Send a prompt and resolve when the turn settles.
   * One prompt per session may be in flight (server-enforced).
   */
  prompt(
    sessionId: string,
    prompt: AcpPromptBlock[],
    timeoutMs = 0,
  ): Promise<AcpPromptResult> {
    return this.options.transport.request('session/prompt', {
      sessionId,
      prompt,
    }, timeoutMs) as Promise<AcpPromptResult>;
  }

  /** session/cancel is a NOTIFICATION in ACP v1 — no response. */
  cancel(sessionId: string): void {
    const params: AcpCancelNotificationParams = { sessionId };
    this.options.transport.notify('session/cancel', params);
  }

  onMessageChunk(listener: MessageChunkListener): () => void {
    this.chunkListeners.add(listener);
    return () => this.chunkListeners.delete(listener);
  }

  onPermissionRequest(handler: PermissionRequestHandler): void {
    this.permissionHandler = handler;
  }

  dispose(): void {
    this.unsubscribe();
    this.chunkListeners.clear();
    this.permissionHandler = null;
  }

  private handleNotification(notification: { method: string; params?: unknown }): void {
    if (notification.method === 'session/update') {
      const params = notification.params as AcpSessionUpdateNotification;
      const update = params?.update;
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const content = update.content as { type?: string; text?: string };
        if (content?.type === 'text' && typeof content.text === 'string') {
          for (const listener of [...this.chunkListeners]) {
            try {
              listener(params.sessionId, content.text);
            } catch (error) {
              console.error('dsh-agent: chunk listener error', error);
            }
          }
        }
      }
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    if (request.method === 'session/request_permission') {
      const params = request.params as AcpRequestPermissionParams;
      if (this.permissionHandler === null) {
        this.options.transport.respond(request.id, {
          outcome: { outcome: 'cancelled' },
        } satisfies AcpRequestPermissionResult);
        return;
      }
      try {
        const result = await this.permissionHandler(request, params);
        this.options.transport.respond(request.id, result);
      } catch {
        this.options.transport.respond(request.id, {
          outcome: { outcome: 'cancelled' },
        } satisfies AcpRequestPermissionResult);
      }
      return;
    }
    // Every other server request is out of scope for this deployment.
    this.options.transport.respondError(request.id, -32601, `unsupported server request: ${request.method}`);
  }
}
