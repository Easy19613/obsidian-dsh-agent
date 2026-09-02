// Permission prompt for ACP session/request_permission server requests.
// The dsh-acp bridge asks only for one-shot sandbox escalation retries, so the
// wire carries a toolCallId and fixed allow-once/reject-once options.
import { App, Modal } from 'obsidian';
import type { AcpRequestPermissionParams } from '../../acp/types';

export type PermissionDecision = 'allow' | 'reject' | 'cancelled';

const ALLOW_OPTION_IDS = ['allow-once', 'allow_once'];
const REJECT_OPTION_IDS = ['reject-once', 'reject_once'];

export class PermissionModal extends Modal {
  private resolver: ((decision: PermissionDecision) => void) | null = null;
  private answered = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    app: App,
    private readonly params: AcpRequestPermissionParams,
    private readonly timeoutMs: number = 120_000,
    private readonly toolName?: string,
    private readonly argumentsJson = '',
    private readonly risk = '中风险',
    private readonly queueDepth = 1,
  ) {
    super(app);
    this.timer = setTimeout(() => {
      this.resolve('cancelled');
    }, timeoutMs);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('dsh-agent-permission');
    contentEl.createEl('h3', { text: 'DSH 请求权限' });
    contentEl.createEl('p', { text: 'DeepSeek Harness 正在请求提升沙箱权限，以重试一次被当前策略拒绝的操作。' });
    if (this.toolName !== undefined && this.toolName !== '') {
      contentEl.createEl('p', { text: '工具: ' + this.toolName, cls: 'dsh-agent-mono' });
    }
    contentEl.createEl('p', { text: '风险级别: ' + this.risk });
    if (this.argumentsJson.trim() !== '') {
      const details = contentEl.createEl('details');
      details.createEl('summary', { text: '查看工具参数' });
      details.createEl('pre', { text: this.argumentsJson.slice(0, 12000), cls: 'dsh-agent-mono' });
    }
    if (this.queueDepth > 1) contentEl.createEl('p', { text: '另有 ' + (this.queueDepth - 1) + ' 个权限请求正在排队。' });
    contentEl.createEl('p', { text: '会话: ' + this.params.sessionId, cls: 'dsh-agent-mono' });
    contentEl.createEl('p', { text: '工具调用: ' + this.params.toolCall.toolCallId, cls: 'dsh-agent-mono' });
    const row = contentEl.createDiv({ cls: 'dsh-agent-permission-actions' });
    const allow = row.createEl('button', { text: '允许一次', cls: 'mod-cta' });
    allow.onclick = () => this.resolve('allow');
    const reject = row.createEl('button', { text: '拒绝' });
    reject.onclick = () => this.resolve('reject');
  }

  onClose(): void {
    clearTimeout(this.timer);
    this.resolve('cancelled');
  }

  /** Resolve with the user's decision (modal closes itself). */
  decide(): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      this.resolver = resolve;
    });
  }

  pickOptionId(decision: PermissionDecision): string {
    switch (decision) {
      case 'allow': {
        const option = this.params.options.find((o) => ALLOW_OPTION_IDS.includes(o.optionId))
          ?? this.params.options.find((o) => o.kind === 'allow_once');
        return option?.optionId ?? 'allow-once';
      }
      case 'reject': {
        const option = this.params.options.find((o) => REJECT_OPTION_IDS.includes(o.optionId))
          ?? this.params.options.find((o) => o.kind === 'reject_once');
        return option?.optionId ?? 'reject-once';
      }
      default:
        return 'reject-once';
    }
  }

  private resolve(decision: PermissionDecision): void {
    if (this.answered) return;
    this.answered = true;
    clearTimeout(this.timer);
    this.close();
    this.resolver?.(decision);
  }
}
