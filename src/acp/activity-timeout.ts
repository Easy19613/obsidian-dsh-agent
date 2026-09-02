/**
 * Progress-aware timeout for long ACP turns. A paper review may legitimately
 * run for longer than the configured window; only a complete lack of backend
 * activity for that entire window is treated as a lost request.
 */
export class ActivityTimeoutGuard {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reject: ((error: Error) => void) | null = null;
  private settled = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
    private readonly operation = 'session/prompt',
  ) {}

  wait<T>(task: Promise<T>): Promise<T> {
    if (this.timeoutMs <= 0) return task;
    return new Promise<T>((resolve, reject) => {
      this.reject = reject;
      this.arm();
      void task.then(
        (value) => {
          if (!this.finish()) return;
          resolve(value);
        },
        (error: unknown) => {
          if (!this.finish()) return;
          reject(error);
        },
      );
    });
  }

  /** Reset the inactivity window when ACP or the session log reports progress. */
  touch(): void {
    if (this.settled || this.timeoutMs <= 0 || this.reject === null) return;
    this.arm();
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.reject = null;
  }

  private arm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.expire(), this.timeoutMs);
  }

  private expire(): void {
    if (this.settled) return;
    this.settled = true;
    this.timer = null;
    try {
      this.onTimeout();
    } catch {
      // The timeout itself must still settle even if cancellation transport died.
    }
    this.reject?.(new Error(`request inactivity timeout: ${this.operation}`));
    this.reject = null;
  }

  private finish(): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.dispose();
    return true;
  }
}
