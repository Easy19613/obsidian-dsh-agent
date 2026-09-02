// Tool-activity / todo / attachment renderers for the chat view.
import { App, Notice, setIcon } from 'obsidian';
import type { GoalCard, TodoItem, ToolActivity, WorkflowRun } from './session';
import { normalizeReasoningText } from './block-builder';

export interface RenderHost {
  getApp(): App;
  openNote(path: string): void;
  requestAgentControl(childId: string, action: 'stop' | 'retry', label: string, prompt?: string): void;
}

const TOOL_ICONS: Record<string, string> = {
  read: 'file-text',
  write: 'file-plus',
  edit: 'file-pen',
  bash: 'terminal',
  glob: 'folder-search',
  grep: 'search',
  todo_write: 'list-checks',
  web: 'globe',
  web_search: 'globe',
  subagent: 'bot',
  subagent_fork: 'bot',
  subagent_codex: 'bot',
  subagent_claude_code: 'bot',
  workflow: 'workflow',
  goal: 'target',
  ralph: 'refresh-cw',
  skill: 'zap',
  ask_user_question: 'help-circle',
};

export function toolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] ?? 'wrench';
}

/** One-line human summary of a tool's arguments (used in the card header). */
export function summarizeArguments(name: string, argumentsJson: string): string {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return argumentsJson.slice(0, 80);
  }
  const oneLine = (value: unknown, max = 60): string => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > max ? compact.slice(0, max) + '…' : compact;
  };
  switch (name) {
    case 'read':
      return '读取 ' + oneLine(args.file_path);
    case 'write':
      return '写入 ' + oneLine(args.file_path);
    case 'edit':
      return '编辑 ' + oneLine(args.file_path);
    case 'bash':
      return oneLine(args.command, 80);
    case 'glob':
      return '搜索 ' + oneLine(args.pattern);
    case 'grep':
      return 'grep ' + oneLine(args.pattern) + (args.path !== undefined ? ' @ ' + oneLine(args.path, 30) : '');
    case 'todo_write':
      return '更新任务清单';
    case 'web':
    case 'web_search':
      return oneLine(args.query ?? args.url, 80);
    case 'subagent':
    case 'subagent_fork':
      return oneLine(args.prompt ?? args.description, 80);
    case 'workflow':
      return oneLine(args.script, 60);
    case 'goal':
    case 'ralph':
      return oneLine(args.objective, 80);
    case 'skill':
      return oneLine(args.name, 40);
    case 'ask_user_question': {
      const questions = args.questions as unknown[] | undefined;
      const first = questions?.[0] as { question?: string } | undefined;
      return oneLine(first?.question ?? '', 80);
    }
    default:
      return oneLine(args, 80);
  }
}

/** Render one tool-activity card; returns the card element. */
export function renderToolCard(
  host: RenderHost,
  parent: HTMLElement,
  activity: ToolActivity,
): HTMLElement {
  const card = parent.createDiv({
    cls: 'dsh-tool-card' + (activity.status === 'running' ? ' is-running' : activity.status === 'error' ? ' is-error' : ' is-done'),
  });
  card.dataset.callId = activity.callId;

  const header = card.createDiv({ cls: 'dsh-tool-header' });
  const iconEl = header.createSpan({ cls: 'dsh-tool-icon' });
  setIcon(iconEl, toolIcon(activity.name));
  const nameEl = header.createSpan({ cls: 'dsh-tool-name' });
  nameEl.setText(activity.name);
  const summaryEl = header.createSpan({ cls: 'dsh-tool-summary' });
  summaryEl.setText(summarizeArguments(activity.name, activity.argumentsJson));
  const statusEl = header.createSpan({ cls: 'dsh-tool-status' });
  statusEl.setText(activity.status === 'running' ? '运行中' : activity.status === 'error' ? '失败' : '完成');
  const chevron = header.createSpan({ cls: 'dsh-tool-chevron' });
  setIcon(chevron, 'chevron-down');

  const body = card.createDiv({ cls: 'dsh-tool-body' });
  body.addClass('dsh-collapsed');

  header.onclick = () => {
    body.toggleClass('dsh-collapsed', !body.hasClass('dsh-collapsed'));
  };

  // arguments (pretty JSON, expandable)
  let args: unknown = null;
  try {
    args = JSON.parse(activity.argumentsJson);
  } catch {
    args = activity.argumentsJson;
  }
  addSection(host, body, '参数', () => {
    const pre = body.createEl('pre', { cls: 'dsh-tool-pre' });
    pre.setText(typeof args === 'string' ? args : JSON.stringify(args, null, 2));
    return pre;
  });

  // meta presentation (paths / read window)
  if (activity.meta !== undefined && typeof activity.meta === 'object' && activity.meta !== null) {
    const meta = activity.meta as Record<string, unknown>;
    if (meta.shape === 'paths' && Array.isArray(meta.paths)) {
      addSection(host, body, '结果文件', () => {
        const list = body.createEl('ul', { cls: 'dsh-tool-paths' });
        for (const p of (meta.paths as unknown[]).slice(0, 50)) {
          if (typeof p !== 'string') continue;
          const item = list.createEl('li');
          const link = item.createEl('a', { text: p, cls: 'dsh-tool-path-link' });
          link.onclick = (event) => {
            event.preventDefault();
            host.openNote(p);
          };
        }
        if (meta.truncated === true) {
          list.createEl('li', { text: '…（结果已截断）', cls: 'dsh-tool-path-note' });
        }
        return list;
      });
    } else if (typeof meta.path === 'string') {
      const lineInfo = typeof meta.offset === 'number'
        ? '第 ' + meta.offset + '–' + (meta.offset + (typeof meta.lines === 'number' ? meta.lines : 1) - 1) + ' 行'
        : '';
      addSection(host, body, '读取窗口', () => {
        const div = body.createDiv({ cls: 'dsh-tool-readwindow' });
        const link = div.createEl('a', { text: String(meta.path), cls: 'dsh-tool-path-link' });
        link.onclick = (event) => {
          event.preventDefault();
          host.openNote(String(meta.path));
        };
        if (lineInfo !== '') div.createEl('span', { cls: 'dsh-tool-readwindow-info', text: lineInfo });
        return div;
      });
    }
  }

  // result text (collapsed when long)
  if (activity.resultText !== '') {
    addSection(host, body, activity.status === 'error' ? '结果' : '输出', () => {
      const pre = body.createEl('pre', { cls: 'dsh-tool-pre dsh-tool-result' });
      const text = activity.resultText;
      pre.setText(text.length > 8000 ? text.slice(0, 8000) + '\n…（输出已截断）' : text);
      return pre;
    });
  }
  if (activity.errorCode !== undefined || activity.errorName !== undefined) {
    const errorLine = body.createDiv({ cls: 'dsh-tool-error-line' });
    errorLine.setText('错误: ' + [activity.errorName, activity.errorCode].filter(Boolean).join(' / '));
  }

  return card;
}

function addSection(
  _host: RenderHost,
  body: HTMLElement,
  label: string,
  build: () => HTMLElement,
): void {
  const section = body.createDiv({ cls: 'dsh-tool-section' });
  const labelEl = section.createDiv({ cls: 'dsh-tool-section-label' });
  labelEl.setText(label);
  section.appendChild(build());
}

/** Render a todo snapshot as a task list. */
export function renderTodoList(parent: HTMLElement, todos: TodoItem[]): HTMLElement {
  const list = parent.createDiv({ cls: 'dsh-todo-list' });
  for (const todo of todos) {
    const row = list.createDiv({ cls: 'dsh-todo-item' });
    row.dataset.status = todo.status;
    const iconEl = row.createSpan({ cls: 'dsh-todo-icon' });
    setIcon(iconEl, todo.status === 'completed' ? 'check-circle' : todo.status === 'in_progress' ? 'loader-circle' : 'circle');
    row.createSpan({ cls: 'dsh-todo-content', text: todo.content });
  }
  return list;
}

/** Render the collapsible thinking block above an assistant answer. */
export function renderThinkingBlock(parent: HTMLElement, reasoning: string): HTMLElement {
  const wrapper = parent.createDiv({ cls: 'dsh-thinking' });
  const header = wrapper.createDiv({ cls: 'dsh-thinking-header' });
  const icon = header.createSpan({ cls: 'dsh-thinking-icon' });
  setIcon(icon, 'brain');
  header.createSpan({ text: '思考过程' });
  const chevron = header.createSpan({ cls: 'dsh-tool-chevron' });
  setIcon(chevron, 'chevron-down');
  const body = wrapper.createDiv({ cls: 'dsh-thinking-body dsh-collapsed' });
  const textEl = body.createDiv({ cls: 'dsh-thinking-text' });
  const normalized = normalizeReasoningText(reasoning);
  textEl.setText(normalized.length > 20000 ? normalized.slice(0, 20000) + '\n…（思考内容过长已截断）' : normalized);
  header.onclick = () => {
    body.toggleClass('dsh-collapsed', !body.hasClass('dsh-collapsed'));
  };
  return wrapper;
}

const GOAL_OPERATION_LABELS: Record<string, string> = {
  create: '创建目标',
  edit: '编辑目标',
  pause: '暂停目标',
  resume: '恢复目标',
  complete: '完成目标',
  block: '目标受阻',
  clear: '清除目标',
};

/** Render one goal mutation card. */
export function renderGoalCard(parent: HTMLElement, card: GoalCard): HTMLElement {
  const wrapper = parent.createDiv({ cls: 'dsh-goal-card' });
  wrapper.dataset.operation = card.operation;
  const header = wrapper.createDiv({ cls: 'dsh-goal-header' });
  const icon = header.createSpan({ cls: 'dsh-goal-icon' });
  setIcon(icon, 'target');
  header.createSpan({ cls: 'dsh-goal-label', text: GOAL_OPERATION_LABELS[card.operation] ?? card.operation });
  const phase = header.createSpan({ cls: 'dsh-goal-phase' });
  phase.setText(phaseLabel(card.phase));
  if (card.phase !== undefined) phase.dataset.phase = card.phase;
  if (card.objective !== undefined && card.objective !== '') {
    const objective = wrapper.createDiv({ cls: 'dsh-goal-objective' });
    objective.setText(card.objective);
  }
  if (card.maxGoalRounds !== undefined) {
    const meta = wrapper.createDiv({ cls: 'dsh-goal-meta' });
    meta.setText('轮次 ' + (card.roundsStarted ?? 0) + '/' + card.maxGoalRounds);
  }
  if (card.blockedReason !== undefined && card.blockedReason !== '') {
    const reason = wrapper.createDiv({ cls: 'dsh-goal-blocked' });
    reason.setText(card.blockedReason);
  }
  return wrapper;
}

function phaseLabel(phase: string | undefined): string {
  switch (phase) {
    case 'active':
      return '进行中';
    case 'paused':
      return '已暂停';
    case 'complete':
      return '已完成';
    case 'blocked':
      return '已受阻';
    default:
      return phase ?? '';
  }
}

/** Render one workflow/subagent control console with a parent-child task tree. */
export function renderWorkflowCard(host: RenderHost, parent: HTMLElement, run: WorkflowRun): HTMLElement {
  const wrapper = parent.createDiv({ cls: 'dsh-workflow-card' });
  wrapper.dataset.runId = run.runId;
  wrapper.dataset.kind = run.kind ?? 'workflow';
  const header = wrapper.createDiv({ cls: 'dsh-workflow-header' });
  const icon = header.createSpan({ cls: 'dsh-workflow-icon' });
  setIcon(icon, run.kind === 'subagent' ? 'network' : 'workflow');
  header.createSpan({ cls: 'dsh-workflow-name', text: run.name });
  const status = header.createSpan({ cls: 'dsh-workflow-status' });
  const anyRunning = run.agents.some((agent) => agent.outcome === undefined);
  const allIdle = run.agents.length > 0 && run.agents.every((agent) => agent.outcome === 'idle');
  const overall = run.stopReason ?? (anyRunning ? 'running' : allIdle ? 'idle' : run.agents.length > 0 ? 'completed' : 'running');
  status.setText(overall === 'running' ? '运行中' : overall === 'completed' ? '完成' : overall === 'idle' ? '待命' : overall);
  status.dataset.reason = overall;
  const body = wrapper.createDiv({ cls: 'dsh-workflow-body' });
  if (run.rootSessionId !== undefined) {
    const root = body.createDiv({ cls: 'dsh-workflow-root' });
    const rootIcon = root.createSpan({ cls: 'dsh-workflow-agent-icon' });
    setIcon(rootIcon, 'bot');
    root.createSpan({ cls: 'dsh-workflow-root-label', text: '主代理' });
    root.createSpan({ cls: 'dsh-workflow-agent-id', text: shortId(run.rootSessionId) });
    if (run.startedAt !== undefined) addElapsed(root, run.startedAt, run.endedAt);
  }
  if (run.agents.length > 0) {
    const list = body.createDiv({ cls: 'dsh-workflow-agents' });
    for (const agent of run.agents) {
      const row = list.createDiv({ cls: 'dsh-workflow-agent' });
      row.style.setProperty('--dsh-agent-depth', String(Math.max(1, agent.depth ?? 1)));
      const agentIcon = row.createSpan({ cls: 'dsh-workflow-agent-icon' });
      setIcon(agentIcon, agent.outcome === 'completed' || agent.outcome === 'idle'
        ? 'check-circle'
        : agent.outcome === undefined ? 'loader-circle' : 'x-circle');
      const content = row.createDiv({ cls: 'dsh-workflow-agent-content' });
      const top = content.createDiv({ cls: 'dsh-workflow-agent-top' });
      top.createSpan({ cls: 'dsh-workflow-agent-label', text: '#' + agent.seq + ' ' + agent.label });
      if (agent.childId !== undefined) top.createSpan({ cls: 'dsh-workflow-agent-id', text: shortId(agent.childId) });
      if (agent.phase !== undefined) {
        top.createSpan({ cls: 'dsh-workflow-agent-phase', text: agent.phase });
      }
      const meta = content.createDiv({ cls: 'dsh-workflow-agent-meta' });
      meta.createSpan({ text: agent.outcome === undefined ? '当前任务 · 运行中'
        : agent.outcome === 'completed' ? '已完成'
          : agent.outcome === 'idle' ? '已完成本轮 · 可继续' : '已结束 · ' + agent.outcome });
      if (agent.startedAt !== undefined) addElapsed(meta, agent.startedAt, agent.endedAt);
      const tokens = (agent.inputTokens ?? 0) + (agent.cacheReadTokens ?? 0) + (agent.outputTokens ?? 0);
      meta.createSpan({ cls: 'dsh-workflow-agent-tokens', text: tokens > 0
        ? formatTokenCount(tokens) + ' tokens'
        : 'token —' });
      if (agent.lastOutput !== undefined && agent.lastOutput.trim() !== '' && agent.report === undefined) {
        const live = content.createEl('details', { cls: 'dsh-workflow-report is-live' });
        live.createEl('summary', { text: '最近输出' });
        live.createEl('pre', { text: truncateReport(agent.lastOutput) });
      }
      if (agent.report !== undefined && agent.report.trim() !== '') {
        const report = content.createEl('details', { cls: 'dsh-workflow-report' });
        report.createEl('summary', { text: '最终报告' });
        report.createEl('pre', { text: truncateReport(agent.report) });
      }
      const controls = row.createDiv({ cls: 'dsh-workflow-agent-controls' });
      const actionable = agent.childId !== undefined && agent.childId !== '';
      if (agent.outcome === undefined) {
        const stop = controls.createEl('button', { cls: 'dsh-agent-action-btn' });
        setIcon(stop, 'square');
        stop.disabled = !actionable;
        stop.setAttr('aria-label', actionable ? '单独停止此子代理' : '等待子代理会话 ID');
        stop.onclick = () => {
          if (agent.childId !== undefined) host.requestAgentControl(agent.childId, 'stop', agent.label, agent.prompt);
        };
      } else {
        const retry = controls.createEl('button', { cls: 'dsh-agent-action-btn' });
        setIcon(retry, 'rotate-ccw');
        retry.setAttr('aria-label', actionable ? '在此子代理中重试任务' : '新建子代理重试此任务');
        retry.onclick = () => {
          host.requestAgentControl(agent.childId ?? '', 'retry', agent.label, agent.prompt);
        };
      }
    }
  }
  if (run.report !== undefined && run.report.trim() !== '') {
    const report = body.createEl('details', { cls: 'dsh-workflow-report is-run' });
    report.createEl('summary', { text: run.kind === 'subagent' ? '控制台汇总' : 'Workflow 最终报告' });
    report.createEl('pre', { text: truncateReport(run.report) });
  }
  const chevron = header.createSpan({ cls: 'dsh-tool-chevron' });
  setIcon(chevron, 'chevron-down');
  header.onclick = () => body.toggleClass('dsh-collapsed', !body.hasClass('dsh-collapsed'));
  return wrapper;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) + '…' : id;
}

function addElapsed(parent: HTMLElement, start: number, end: number | undefined): void {
  const elapsed = parent.createSpan({ cls: 'dsh-agent-elapsed' });
  elapsed.dataset.start = String(start);
  if (end !== undefined) elapsed.dataset.end = String(end);
  const seconds = Math.max(0, Math.floor(((end ?? Date.now()) - start) / 1000));
  elapsed.setText(seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's');
}

function formatTokenCount(value: number): string {
  return value >= 1000 ? (value / 1000).toFixed(value >= 10_000 ? 0 : 1) + 'k' : String(value);
}

function truncateReport(value: string): string {
  const text = value.trim();
  return text.length > 20_000 ? text.slice(0, 20_000) + '\n…（报告过长已截断）' : text;
}

/** Add copy buttons to every code block in the container. */
export function addCopyButtons(container: HTMLElement): void {
  for (const pre of Array.from(container.querySelectorAll<HTMLElement>('pre'))) {
    if (pre.hasClass('dsh-copy-processed')) continue;
    pre.addClass('dsh-copy-processed');
    pre.addClass('dsh-codeblock');
    const button = document.createElement('button');
    button.className = 'dsh-copy-button';
    button.setAttr?.('aria-label', '复制代码');
    setIcon(button, 'copy');
    button.addEventListener('click', async () => {
      const text = pre.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text);
        setIcon(button, 'check');
        setTimeout(() => setIcon(button, 'copy'), 1200);
      } catch {
        new Notice('复制失败');
      }
    });
    pre.appendChild(button);
  }
}
