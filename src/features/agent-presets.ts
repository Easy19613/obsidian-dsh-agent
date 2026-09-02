import type { DshAgentSettings, AgentPresetId } from '../settings/settings';
import { TOOL_CATALOG } from '../runtime/templates';

export interface AgentPreset {
  id: Exclude<AgentPresetId, 'manual'>;
  name: string;
  description: string;
  provider: string;
  model: string;
  reasoningEffort: DshAgentSettings['reasoningEffort'];
  permissionMode: DshAgentSettings['permissionMode'];
  approvalPolicy: DshAgentSettings['approvalPolicy'];
  toolIds: string[];
  orchestration: 'off' | 'subagent' | 'workflow';
  persona: string;
}

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: 'research',
    name: '科研调研',
    description: '深度检索、论文比较、证据核验与研究笔记输出',
    provider: 'opencode-go',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    permissionMode: 'workspace-write',
    approvalPolicy: 'ask',
    toolIds: ['bash', 'fs', 'fs-search', 'todo', 'subagent', 'workflow'],
    orchestration: 'workflow',
    persona: [
      '当前预设：科研调研。先界定研究问题与证据标准，区分论文原文、二手资料与推断；不得编造论文、数据或引用。',
      '多个相互独立的论文、方法或证据源应优先交给 subagent 并行核验；三项以上或含多个阶段时优先使用 workflow 编排，最终由主智能体交叉检查并综合。',
      '输出应保留论文名、方法名、实验设置、局限性与可追溯来源；涉及 Obsidian 笔记时遵守库内 AGENTS.md、wikilink 与目录规范。',
    ].join('\n\n'),
  },
  {
    id: 'notes',
    name: '笔记整理',
    description: '查重、归类、双链与小步整理，默认不做大规模改动',
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    permissionMode: 'workspace-write',
    approvalPolicy: 'ask',
    toolIds: ['fs', 'fs-search', 'todo'],
    orchestration: 'off',
    persona: [
      '当前预设：笔记整理。先读懂、查重和判断归属，再做最小必要修改；优先建立 wikilink，保持现有 frontmatter、目录结构和用户原文稳定。',
      '移动、重命名、归档或批量操作必须遵守工作区 AGENTS.md；拿不准时保留原状并明确说明。普通整理不主动启动子代理或 workflow。',
    ].join('\n\n'),
  },
  {
    id: 'safe-readonly',
    name: '安全只读',
    description: '真实 read-only 沙箱，只分析和报告，不修改文件',
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    permissionMode: 'read-only',
    approvalPolicy: 'never',
    toolIds: ['fs', 'fs-search', 'todo'],
    orchestration: 'off',
    persona: [
      '当前预设：安全只读。只允许读取、搜索、分析与报告；不得创建、编辑、移动、删除文件，不得请求提升权限，也不得通过其他工具绕过 read-only 沙箱。',
      '如果用户要求修改，先给出拟修改内容和影响，但保持文件系统不变。不要启动子代理或 workflow。',
    ].join('\n\n'),
  },
  {
    id: 'deep-task',
    name: '深度任务',
    description: '底层 max + 主动子代理/Workflow 调度与最终自验',
    provider: 'opencode-go',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    permissionMode: 'workspace-write',
    approvalPolicy: 'ask',
    toolIds: TOOL_CATALOG.map((tool) => tool.id),
    orchestration: 'workflow',
    persona: [
      '当前预设：深度任务。底层推理强度为 max；“深度”来自任务分解、子代理协作、阶段化执行与自验，不得声称存在额外的 Ultra 模型推理等级。',
      '面对复杂、多文件或长链任务，先建立清晰计划；一至两个独立子任务优先并行使用 subagent，三个以上或多阶段依赖优先使用 workflow。主智能体必须整合结果、处理冲突、验证最终产物并给出未解决风险。',
      '独立的代码实现或交叉审核可按需交给 subagent_codex 或 subagent_claude_code；二者不继承当前对话，调用时必须提供完整、自包含的任务说明。',
    ].join('\n\n'),
  },
];

export function agentPreset(id: AgentPresetId): AgentPreset | undefined {
  return AGENT_PRESETS.find((preset) => preset.id === id);
}

export function agentPresetLabel(id: AgentPresetId): string {
  return id === 'manual' ? '自定义' : agentPreset(id)?.name ?? '自定义';
}

export function agentPresetPersona(id: AgentPresetId): string {
  return agentPreset(id)?.persona ?? '';
}

/** Apply every behavior-bearing field in one preset while retaining UI preferences. */
export function applyAgentPreset(settings: DshAgentSettings, id: Exclude<AgentPresetId, 'manual'>): void {
  const preset = agentPreset(id);
  if (preset === undefined) return;
  settings.agentPreset = preset.id;
  settings.provider = preset.provider;
  settings.model = preset.model;
  settings.reasoningEffort = preset.reasoningEffort;
  settings.permissionMode = preset.permissionMode;
  settings.approvalPolicy = preset.approvalPolicy;
  const enabled = new Set(preset.toolIds);
  const flags = { ...(settings.featureFlags ?? {}) };
  for (const tool of TOOL_CATALOG) flags['tool.' + tool.id] = enabled.has(tool.id);
  settings.featureFlags = flags;
}
