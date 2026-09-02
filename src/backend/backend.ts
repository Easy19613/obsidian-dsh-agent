// Spawns and supervises the dsh-acp-demo subprocess.
// Teardown ladder mirrors the in-repo template: stdin EOF -> grace -> kill.
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { AcpClientConnection } from '../acp/connection';
import { NdjsonTransport } from '../acp/transport';
import type { DshAgentSettings } from '../settings/settings';
import type { InstallPaths } from './installer';
import { LOCAL_PROVIDER_API_KEY, LOCAL_PROVIDER_API_KEY_ENV } from '../runtime/templates';

export type BackendState = 'stopped' | 'starting' | 'running' | 'error';

export interface BackendSnapshot {
  state: BackendState;
  detail: string;
  stderrTail: string;
}

const STDERR_BUFFER_LIMIT = 16_000;
const MAX_RESTART_ATTEMPTS = 3;

export class DshAcpBackend {
  private child: ChildProcessWithoutNullStreams | null = null;
  private transport: NdjsonTransport | null = null;
  private connection: AcpClientConnection | null = null;
  private stderrBuffer = '';
  private restartAttempts = 0;
  private wantRunning = false;
  private launchPromise: Promise<{ ok: boolean; error?: string }> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private readyAt = 0;
  private readonly listeners = new Set<(snapshot: BackendSnapshot) => void>();
  private readonly connectionListeners = new Set<(connection: AcpClientConnection) => void>();
  private readonly runtimeRevisionWaiters = new Map<string, {
    resolve: (applied: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly paths: InstallPaths,
    private readonly workspaceRoot: string,
    private readonly settings: DshAgentSettings,
  ) {}

  get currentConnection(): AcpClientConnection | null {
    return this.connection;
  }

  snapshot(): BackendSnapshot {
    if (this.connection !== null) {
      return { state: 'running', detail: 'DSH 后端运行中', stderrTail: this.tail() };
    }
    if (this.child !== null) {
      return { state: 'starting', detail: 'DSH 后端启动中', stderrTail: this.tail() };
    }
    if (this.wantRunning) {
      return { state: 'error', detail: 'DSH 后端未就绪', stderrTail: this.tail() };
    }
    return { state: 'stopped', detail: '已停止', stderrTail: this.tail() };
  }

  /** Fires whenever a fresh (successfully initialized) connection is ready. */
  onConnectionReady(listener: (connection: AcpClientConnection) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  onChange(listener: (snapshot: BackendSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Wait until the hot-model Cordis plugin confirms a settings revision. */
  waitForRuntimeRevision(revision: string, timeoutMs = 3_000): Promise<boolean> {
    const marker = '[dsh-agent-model-applied] ' + revision;
    if (this.stderrBuffer.includes(marker)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.runtimeRevisionWaiters.delete(revision);
        resolve(false);
      }, timeoutMs);
      this.runtimeRevisionWaiters.set(revision, { resolve, timer });
    });
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // listeners must not break the backend
      }
    }
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.connection !== null) return { ok: true };
    if (this.launchPromise !== null) return this.launchPromise;
    this.wantRunning = true;
    this.restartAttempts = 0;
    return this.startLaunch();
  }

  /** Single-flight launch used by explicit starts and automatic restarts. */
  private startLaunch(): Promise<{ ok: boolean; error?: string }> {
    if (this.launchPromise !== null) return this.launchPromise;
    const launch = this.launch();
    this.launchPromise = launch;
    void launch.finally(() => {
      if (this.launchPromise === launch) this.launchPromise = null;
    });
    return launch;
  }

  private async launch(): Promise<{ ok: boolean; error?: string }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: this.settings.dshHome,
      DSH_PERMISSION_MODE: this.settings.permissionMode,
      [LOCAL_PROVIDER_API_KEY_ENV]: LOCAL_PROVIDER_API_KEY,
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.settings.nodeCommand, [this.paths.binPath, '--config', this.paths.cordisPath], {
        cwd: this.workspaceRoot,
        env,
        shell: false,
      });
    } catch (error) {
      this.wantRunning = false;
      this.emit();
      return { ok: false, error: String(error) };
    }
    this.child = child;
    const transport = new NdjsonTransport(child, (fatal) => this.onFatal(fatal));
    const connection = new AcpClientConnection({
      clientInfo: { name: 'obsidian-dsh-agent', version: '0.8.3' },
      transport,
    });
    this.transport = transport;
    this.emit();

    child.stderr?.on('data', (data: Buffer) => this.appendStderr(data.toString()));
    child.on('error', (error) => {
      console.error('dsh-agent: backend spawn error', error);
      this.stderrBuffer += '\n' + String(error);
    });
    child.on('close', (code, signal) => {
      const exited = this.child === child;
      if (exited) {
        this.settleRuntimeRevisionWaiters(false);
        transport.dispose();
        connection.dispose();
        this.transport = null;
        this.connection = null;
        this.child = null;
        this.stderrBuffer += `\n[exit] code=${code} signal=${signal}`;
        this.emit();
        // A process that stayed healthy for a while starts a fresh retry
        // budget; rapid crash loops remain capped.
        if (this.readyAt > 0 && Date.now() - this.readyAt >= 30_000) {
          this.restartAttempts = 0;
        }
        this.readyAt = 0;
        if (this.wantRunning && this.restartAttempts < MAX_RESTART_ATTEMPTS) {
          this.restartAttempts += 1;
          const delay = 500 * 2 ** (this.restartAttempts - 1);
          this.stderrBuffer += `\n[restart ${this.restartAttempts}/${MAX_RESTART_ATTEMPTS} in ${delay}ms]`;
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.wantRunning && this.child === null) void this.startLaunch();
          }, delay);
        } else if (this.wantRunning) {
          this.wantRunning = false;
          this.stderrBuffer += '\n[backend gave up after max restarts]';
          this.emit();
        }
      }
    });

    try {
      await connection.initialize();
      if (!this.wantRunning || this.child !== child) {
        connection.dispose();
        transport.dispose();
        return { ok: false, error: 'backend start was cancelled' };
      }
      this.connection = connection;
      this.readyAt = Date.now();
      this.emit();
      for (const listener of [...this.connectionListeners]) {
        try {
          listener(connection);
        } catch (listenerError) {
          console.error('dsh-agent: connection-ready listener error', listenerError);
        }
      }
      return { ok: true };
    } catch (error) {
      this.stderrBuffer += '\n[initialize failed] ' + String(error);
      this.emit();
      try {
        child.kill();
      } catch {
        // ignore
      }
      return { ok: false, error: String(error) };
    }
  }

  private onFatal(error: Error): void {
    console.error('dsh-agent: protocol error', error);
    this.stderrBuffer += '\n[protocol] ' + String(error);
    this.transport?.failAll(error);
    this.emit();
    // A malformed stdout frame makes the connection unusable. Terminate it
    // so the supervised restart ladder can establish a clean protocol stream.
    try {
      this.child?.kill();
    } catch {
      // ignore
    }
  }

  /** stdin EOF first, then a grace period, then tree-kill on Windows. */
  async stop(graceMs = 2_000): Promise<void> {
    this.wantRunning = false;
    this.settleRuntimeRevisionWaiters(false);
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child === null) {
      this.emit();
      return;
    }
    // Disconnect this instance before waiting.  The child's close callback can
    // now never schedule a restart or notify renderer listeners during unload.
    this.child = null;
    this.readyAt = 0;
    this.transport?.dispose();
    this.connection?.dispose();
    this.transport = null;
    this.connection = null;
    try {
      child.stdin.end();
    } catch {
      // already gone
    }
    if (graceMs <= 0) {
      this.forceTerminate(child);
      this.emit();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.forceTerminate(child);
        resolve();
      }, graceMs);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.emit();
  }

  private forceTerminate(child: ChildProcessWithoutNullStreams): void {
    try {
      if (process.platform === 'win32' && child.pid !== undefined) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.unref();
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      // already gone
    }
  }

  private tail(): string {
    return this.stderrBuffer.slice(-2000);
  }

  private appendStderr(text: string): void {
    this.stderrBuffer += text;
    if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
      this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
    }
    for (const [revision, waiter] of [...this.runtimeRevisionWaiters]) {
      if (!this.stderrBuffer.includes('[dsh-agent-model-applied] ' + revision)) continue;
      clearTimeout(waiter.timer);
      this.runtimeRevisionWaiters.delete(revision);
      waiter.resolve(true);
    }
  }

  private settleRuntimeRevisionWaiters(applied: boolean): void {
    for (const waiter of this.runtimeRevisionWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(applied);
    }
    this.runtimeRevisionWaiters.clear();
  }
}
