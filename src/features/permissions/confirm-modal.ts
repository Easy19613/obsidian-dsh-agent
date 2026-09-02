// Simple confirmation modal (restart-y config changes).
import { App, Modal, setIcon } from 'obsidian';

export class ConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    private readonly message: string,
    private readonly onResult: (ok: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('dsh-agent-confirm');
    const row = contentEl.createDiv({ cls: 'dsh-agent-confirm-body' });
    const icon = row.createSpan({ cls: 'dsh-agent-confirm-icon' });
    setIcon(icon, 'alert-triangle');
    row.createSpan({ text: this.message });
    const actions = contentEl.createDiv({ cls: 'dsh-agent-confirm-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.onclick = () => this.finish(false);
    const ok = actions.createEl('button', { text: '继续', cls: 'mod-cta' });
    ok.onclick = () => this.finish(true);
  }

  onClose(): void {
    // ESC closes without confirming.
    if (!this.answered) {
      this.answered = true;
      this.onResult(false);
    }
  }

  private finish(ok: boolean): void {
    if (this.answered) return;
    this.answered = true;
    this.close();
    this.onResult(ok);
  }
}
