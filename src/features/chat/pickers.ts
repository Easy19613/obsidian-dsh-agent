// Inline trigger pickers: @ note mention, / slash commands, workspace folder.
import { App, FuzzyMatch, FuzzySuggestModal } from 'obsidian';

export interface NoteChoice {
  path: string;
  basename: string;
}

export class NoteSuggestModal extends FuzzySuggestModal<NoteChoice> {
  constructor(
    app: App,
    private readonly notes: NoteChoice[],
    private readonly onChoose: (choice: NoteChoice) => void,
  ) {
    super(app);
    this.setPlaceholder('搜索笔记…');
    this.emptyStateText = '没有匹配的笔记';
  }

  getItems(): NoteChoice[] {
    return this.notes;
  }

  getItemText(item: NoteChoice): string {
    return item.basename + ' ' + item.path;
  }

  onChooseItem(item: NoteChoice): void {
    this.onChoose(item);
  }

  renderSuggestion(match: FuzzyMatch<NoteChoice>, el: HTMLElement): void {
    const item = match.item;
    el.createSpan({ text: item.basename, cls: 'dsh-picker-title' });
    el.createSpan({ text: item.path, cls: 'dsh-picker-path' });
  }
}

export interface SlashCommand {
  id: string;
  label: string;
  description: string;
}

export class SlashCommandModal extends FuzzySuggestModal<SlashCommand> {
  constructor(
    app: App,
    private readonly commands: SlashCommand[],
    private readonly onChoose: (command: SlashCommand) => void,
  ) {
    super(app);
    this.setPlaceholder('选择命令…');
    this.emptyStateText = '没有匹配的命令';
  }

  getItems(): SlashCommand[] {
    return this.commands;
  }

  getItemText(item: SlashCommand): string {
    return item.label + ' ' + item.id;
  }

  onChooseItem(item: SlashCommand): void {
    this.onChoose(item);
  }

  renderSuggestion(match: FuzzyMatch<SlashCommand>, el: HTMLElement): void {
    const item = match.item;
    el.createSpan({ text: item.label, cls: 'dsh-picker-title' });
    el.createSpan({ text: item.description, cls: 'dsh-picker-path' });
  }
}

export interface WorkspaceChoice {
  path: string;
  label: string;
}

export class WorkspaceModal extends FuzzySuggestModal<WorkspaceChoice> {
  constructor(
    app: App,
    private readonly options: WorkspaceChoice[],
    private readonly onChoose: (choice: WorkspaceChoice) => void,
  ) {
    super(app);
    this.setPlaceholder('选择工作区文件夹…');
    this.emptyStateText = '没有可用的文件夹';
  }

  getItems(): WorkspaceChoice[] {
    return this.options;
  }

  getItemText(item: WorkspaceChoice): string {
    return item.label;
  }

  onChooseItem(item: WorkspaceChoice): void {
    this.onChoose(item);
  }

  renderSuggestion(match: FuzzyMatch<WorkspaceChoice>, el: HTMLElement): void {
    el.createSpan({ text: match.item.label, cls: 'dsh-picker-title' });
  }
}
