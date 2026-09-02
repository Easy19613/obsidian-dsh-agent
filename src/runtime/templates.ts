// DSH ACP runtime provisioning templates.
// Baseline composition adapted from the upstream deepseek-harness
// examples/acp-agent/cordis.yml (MIT, github.com/deepseek-ai/deepseek-harness)
// with additions: credentials stack, settings-file (plugin-owned doc), and the
// pi-ai multi-provider adapter (opencode-go route).
import { DEFAULT_GOAL_MAX_ROUNDS } from '../constants';
import type { ReasoningEffort } from '../settings/settings';

export const RUNTIME_VERSION = '0.1.1-rc.2';

/** Built-in local OpenAI-compatible route requested for the Obsidian runtime. */
export const LOCAL_PROVIDER_ID = 'local-qwen';
export const LOCAL_PROVIDER_BASE_URL = 'http://127.0.0.1:8081/v1';
export const LOCAL_PROVIDER_API_KEY_ENV = 'DSH_AGENT_LOCAL_QWEN_API_KEY';
export const LOCAL_PROVIDER_API_KEY = 'local';
export const LOCAL_PROVIDER_MODEL_ID = 'qwen3.6-35b-a3b-uncensored-i-compact';
export const LOCAL_PROVIDER_CONTEXT_WINDOW = 65_536;

export const RUNTIME_PACKAGES = [
  'dsh-acp-demo', 'dsh-acp', 'dsh-agent', 'dsh-agent-spine-demo',
  'dsh-attachment', 'dsh-attachment-local',
  'dsh-session-persistence-jsonl', 'dsh-session-checkpoint-policy',
  'dsh-session-query', 'dsh-session-query-sqlite', 'dsh-agent-instructions', 'dsh-tools',
  'dsh-llm-deepseek', 'dsh-llm-pi-ai',
  'dsh-credentials', 'dsh-credentials-local',
  'dsh-settings', 'dsh-settings-file',
  'dsh-sandbox-local', 'dsh-sandbox-policy', 'dsh-subprocess-local', 'dsh-bash-sandbox',
  'dsh-user-approval', 'dsh-token-meter', 'dsh-compaction-basic', 'dsh-session-projection',
  'dsh-subagent', 'dsh-subagent-spawn-in-process', 'dsh-subagent-fork-in-process',
  'dsh-subagent-codex', 'dsh-subagent-claude-code',
  'dsh-tool-subagent', 'dsh-tool-subagent-control', 'dsh-tool-subagent-report',
  'dsh-workflow', 'dsh-workflow-worker-thread', 'dsh-tool-workflow',
  'dsh-tool-ralph', 'dsh-tool-todo', 'dsh-repeat-tool-reminder',
  'dsh-fs-sandbox', 'dsh-fs-observation-policy', 'dsh-tool-fs', 'dsh-tool-fs-search',
] as const;

export function runtimePackageJson(): string {
  const deps: Record<string, string> = {};
  for (const name of RUNTIME_PACKAGES) {
    deps[`@deepseek-ai/${name}`] = RUNTIME_VERSION;
  }
  deps['@deepseek-ai/cordis'] = '^4.0.1';
  deps['@deepseek-ai/schemastery'] = '^3.18.1';
  return JSON.stringify({
    name: 'dsh-profile-acp',
    private: true,
    description: 'DSH ACP automation runtime for the Obsidian dsh-agent plugin (generated).',
    version: '1.0.0',
    dependencies: deps,
    dsh: { profile: { bundles: [] } },
  }, null, 2) + '\n';
}

/** Local Cordis plugin that hot-routes every top-level ACP Agent. */
export function hotModelRouteModule(): string {
  return `import z from '@deepseek-ai/schemastery';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';

export const name = 'dsh-agent-hot-model-route';
export const inject = ['agents'];
const NS = settingsNamespace('agent-default-model');
export const Config = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  revision: z.string(),
});

function selected(config) {
  return {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined || config.reasoningEffort === 'default'
      ? {}
      : { reasoningEffort: config.reasoningEffort }),
  };
}

export function apply(ctx, config) {
  let current = () => config;
  const refs = new Map();
  const publish = () => {
    const value = current();
    const next = selected(value);
    for (const ref of refs.values()) ref.current = next;
    if (value.revision) process.stderr.write('[dsh-agent-model-applied] ' + value.revision + '\\n');
  };
  installSettingsSection(ctx, NS, Config, config, {
    setSource(source) { current = source; },
    onChange: publish,
  });
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') return;
    const ref = { current: selected(current()), assembled: undefined };
    installModelSelection(agent.ctx, ref);
    refs.set(agent.id, ref);
  });
  ctx.on('agent/disposed', ({ agent }) => refs.delete(agent.id));
}
`;
}

export interface ToolEntry {
  id: string;
  label: string;
  description: string;
  category: string;
  /** cordis entry ids removed from cordis.yml when the tool is disabled. */
  cordisIds: string[];
}

/** Toggleable DSH tools exposed in the ACP composition (goal/skill are built
 * into the agent stack itself and are not listed). */
export const TOOL_CATALOG: ToolEntry[] = [
  {
    id: 'bash',
    label: 'bash 命令执行',
    description: '执行 shell 命令（受沙箱约束）',
    category: '文件操作',
    cordisIds: ['bash'],
  },
  {
    id: 'fs',
    label: '文件读写',
    description: '读取/写入/编辑笔记文件',
    category: '文件操作',
    cordisIds: ['tool-fs'],
  },
  {
    id: 'fs-search',
    label: '文件搜索',
    description: '在库内按 glob/内容搜索文件',
    category: '文件操作',
    cordisIds: ['tool-fs-search'],
  },
  {
    id: 'todo',
    label: '任务清单（todo）',
    description: 'AI 用 todo 工具记录与更新任务进度',
    category: '任务与编排',
    cordisIds: ['tool-todo'],
  },
  {
    id: 'workflow',
    label: 'workflow 多智能体编排',
    description: '并行编排多个 agent 完成大型任务',
    category: '任务与编排',
    cordisIds: ['tool-workflow'],
  },
  {
    id: 'ralph',
    label: 'ralph 迭代执行',
    description: '每轮新开 agent 的迭代式执行循环',
    category: '任务与编排',
    cordisIds: ['tool-ralph'],
  },
  {
    id: 'subagent',
    label: '子代理（subagent）',
    description: 'spawn/fork 子代理、控制/列表/报告工具',
    category: '子代理',
    cordisIds: [
      'tool-subagent',
      'tool-subagent-fork',
      'tool-subagent-control',
      'tool-subagent-list-agents',
      'tool-subagent-report',
    ],
  },
  {
    id: 'subagent-codex',
    label: 'Codex 子代理',
    description: '调用官方 Codex app-server 完成独立的一次性任务',
    category: '子代理',
    cordisIds: ['tool-subagent-codex'],
  },
  {
    id: 'subagent-claude-code',
    label: 'Claude Code 子代理',
    description: '调用官方 Claude Agent SDK 完成独立的一次性任务',
    category: '子代理',
    cordisIds: ['tool-subagent-claude-code'],
  },
];

/**
 * Remove cordis entries whose id is in the disabled set. Callers may pass
 * either feature/tool ids ("fs") or resolved cordis ids ("tool-fs"). Entries
 * are split on "- id: " so multi-line config blocks stay intact.
 */
export function excludeToolEntries(yaml: string, disabledIds: readonly string[]): string {
  if (disabledIds.length === 0) return yaml;
  const banned = new Set<string>();
  for (const id of disabledIds) {
    // FeatureRegistry already resolves runtime switches to concrete cordis
    // ids. Keep the id itself so that path works, while retaining support for
    // the older tool-id API used by tests and migrated settings.
    banned.add(id);
    const entry = TOOL_CATALOG.find((t) => t.id === id);
    if (entry !== undefined) for (const cordisId of entry.cordisIds) banned.add(cordisId);
  }
  const parts = yaml.split(/(?=^- id: )/m);
  return parts
    .filter((part) => {
      const idMatch = /^- id: ([^\n]+)/m.exec(part);
      return idMatch === null || !banned.has(idMatch[1].trim());
    })
    .join('');
}

export interface ModelEntry {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  reasoningEfforts: ReasoningEffort[];
  contextWindow?: number;
}

export interface ModelCatalogModel {
  id: string;
  name: string;
  reasoningEfforts?: ReasoningEffort[];
  contextWindow?: number;
}

export type ModelCatalog = Record<string, { name: string; models: ModelCatalogModel[] }>;

/**
 * Flatten the model catalog into chat-composer entries, one per model of
 * every visible provider (hiddenProviders keeps a provider's models out of
 * the list while the runtime keeps whatever provider/model is selected).
 */
export function visibleModelEntries(
  hiddenProviders: readonly string[],
  hiddenModels: readonly string[],
  catalog: ModelCatalog = MODEL_CATALOG,
): ModelEntry[] {
  const hidden = new Set(hiddenProviders);
  const hiddenModelSet = new Set(hiddenModels);
  const entries: ModelEntry[] = [];
  for (const providerId of Object.keys(catalog)) {
    if (hidden.has(providerId)) continue;
    const provider = catalog[providerId];
    for (const model of provider.models) {
      if (hiddenModelSet.has(providerId + '::' + model.id)) continue;
      entries.push({
        id: model.id,
        name: model.name,
        providerId,
        providerName: provider.name,
        reasoningEfforts: model.reasoningEfforts ?? ['default'],
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      });
    }
  }
  return entries;
}

export function providerLabel(providerId: string, catalog: ModelCatalog = MODEL_CATALOG): string {
  return catalog[providerId]?.name ?? providerId;
}

export interface CordisSubstitutions {
  settingsPath: string;
  persistenceRoot: string;
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  /** Preset-specific system guidance appended to the common Obsidian persona. */
  persona?: string;
  /** Extra skill root (the machine-wide ~/.agents/skills), synced with the main DSH. */
  agentsSkillsDir?: string;
}

/** Generate the cordis.yml for the ACP runtime. */
export function cordisTemplate(sub: CordisSubstitutions): string {
  // Single-quoted YAML: backslashes are literal (do NOT double them); only
  // single quotes need doubling.
  const yamlPath = sub.settingsPath.replace(/'/g, "''");
  const yamlPersistence = sub.persistenceRoot.replace(/'/g, "''");
  const yamlAgentsSkills = sub.agentsSkillsDir !== undefined
    ? sub.agentsSkillsDir.replace(/\\/g, '/').replace(/'/g, "''")
    : undefined;
  const reasoningEffort = sub.reasoningEffort === 'off'
    || sub.reasoningEffort === 'low'
    || sub.reasoningEffort === 'high'
    || sub.reasoningEffort === 'max'
    ? sub.reasoningEffort
    : 'high';
  const presetPersona = (sub.persona ?? '').trim();
  const personaYaml = presetPersona === '' ? '' : '\n\n'
    + presetPersona.split(/\r?\n/).map((line) => '      ' + line).join('\n');
  return `# dsh-agent ACP 自动化组合（由 Obsidian 插件生成；不要手改，改动请走插件设置）。
# 协议: stdout 只承载 ACP JSON-RPC ndjson；诊断一律走 stderr。
# 组合基线: 上游 deepseek-harness examples/acp-agent/cordis.yml
# 新增: credentials/settings 栈（复用 $DSH_HOME 凭据链与插件自有设置文档）与
#       dsh-llm-pi-ai（opencode-go 等多 provider 路由）。

# 凭据: OPENCODE_GO_API_KEY / DEEPSEEK_API_KEY 等经 ctx.credentials 按请求解析
# （env > $DSH_HOME/.credentials.yaml > <cwd>/.env > $DSH_HOME/.env）。
# 注意: provider 包自身注册 seam 服务，不要重复挂 dsh-credentials / dsh-settings。
- id: credentials-local
  name: '@deepseek-ai/dsh-credentials-local'

# 设置: 插件自有文档（绝不写用户的全局 $DSH_HOME/settings.yaml）；外部编辑热发布。
- id: settings-file
  name: '@deepseek-ai/dsh-settings-file'
  config:
    path: '${yamlPath}'

# DeepSeek 官方路由。
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    thinking: enabled
    reasoningEffort: ${reasoningEffort}
    models:
      - id: deepseek-v4-flash
      - id: deepseek-v4-pro
      - id: deepseek-v4-flash-vision-exp
        name: DeepSeek-V4-Flash-Vision-Exp
        inputModalities: [text, image]

# 通用多 provider 适配器（pi-ai）。路由基底留空：opencode-go 等路由来自
# settings.yaml 的 llm-pi-ai 分节（安装时从用户主配置复制/重新导入）。
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers: {}

# 顶层 ACP Agent 的模型路由来自 settings.yaml，可在下一步热切换。
- id: hot-model-route
  name: './dsh-agent-hot-model-route.mjs'
  config:
    provider: '${sub.provider.replace(/'/g, "''")}'
    model: '${sub.model.replace(/'/g, "''")}'
    reasoningEffort: '${sub.reasoningEffort}'

# 沙箱: bash 与文件系统工具按会话 cwd 约束为 workspace-write。
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js "process.env.DSH_PERMISSION_MODE ?? (process.env.DSH_SNAPSHOT === undefined ? 'workspace-write' : 'danger-full-access')"
    workspaceRoot: !!js process.cwd()

# 子进程组管理（bash 执行器的 spawn/kill/输出管线）。
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
  config:
    timeoutMs: 60000

# 审批: workspace-write 下按 ask 策略；升权重试经 ACP session/request_permission 到达插件。
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? (process.env.DSH_SNAPSHOT === undefined ? 'workspace-write' : 'danger-full-access')) === 'danger-full-access' ? 'never' : 'ask'"

# rc.7+ ACP 图片块需要持久化附件服务；存储位于 DSH_HOME/attachments/v1。
- id: attachment-local
  name: '@deepseek-ai/dsh-attachment-local'

# ACP 自动化应用: agent 主干 + JSONL 持久化 + 协议桥。
- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: ${sub.provider}
    model: ${sub.model}
    persistenceRoot: '${yamlPersistence}'
    persistenceCompression: 'none'
    workspaceContext:
      maxBytes: 65536${yamlAgentsSkills !== undefined ? `
    skills:
      filesystem:
        customSkillDirs:
          - '${yamlAgentsSkills}'` : ''}
    goals:
      domain:
        defaultMaxGoalRounds: ${DEFAULT_GOAL_MAX_ROUNDS}
    # persona 供系统提示词使用；循环会解析 {{model}} 与 {{cwd}}。
    persona: |
      你是由 {{model}} 模型驱动的 DeepSeek Harness 智能体，工作目录 {{cwd}} 是一个 Obsidian 笔记库。你的 bash 与文件系统工具运行在文件沙箱内——结果中出现 [sandbox: file access denied …] 表示策略拒绝，不是命令故障。

      优先遵守工作区内的 AGENTS.md 协作规范；回答使用与用户相同的语言（默认中文）；完成工作后尽量通过运行代码或检查结果进行验证；回答简洁、基于事实。

      Goal 只用于当前会话内能够持续推进并最终完成的工作，绝不能用作等待未来用户输入、持续监听、提醒或待命协议。若当前已无可执行工作，应完成或暂停目标并结束本轮，禁止通过空转轮次反复声明“等待用户”。创建 Goal 时，除非用户明确指定更高预算，否则 max_goal_rounds 不得超过 ${DEFAULT_GOAL_MAX_ROUNDS}。${personaYaml}

# 请求压力测量与压缩。
- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'

- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.08
    maxTokens: 8192
    compactionRetries: 1

# 会话投影注册表（subagent 目录身份折叠）。
- id: session-projection
  name: '@deepseek-ai/dsh-session-projection'

# Subagent 栈: spawn/fork + Codex/Claude Code Provider + 控制/列表/报告工具。
- id: subagent
  name: '@deepseek-ai/dsh-subagent'

- id: subagent-spawn-in-process
  name: '@deepseek-ai/dsh-subagent-spawn-in-process'
  config:
    providerName: spawn

- id: subagent-fork-in-process
  name: '@deepseek-ai/dsh-subagent-fork-in-process'
  config:
    providerName: fork

# 官方产品子代理：每次调用启动独立进程，只接收自包含任务并返回最终回答。
# 账号、模型与产品设置读取各自原生的 CODEX_HOME / Claude 配置。
- id: subagent-codex
  name: '@deepseek-ai/dsh-subagent-codex'
  config:
    providerName: codex
    permissionMode: !!js "process.env.DSH_PERMISSION_MODE === 'danger-full-access' ? 'dangerously-bypass-approvals-and-sandbox' : process.env.DSH_PERMISSION_MODE === 'workspace-write' ? 'approve-for-me' : 'never'"

- id: subagent-claude-code
  name: '@deepseek-ai/dsh-subagent-claude-code'
  config:
    providerName: claude-code
    permissionMode: !!js "process.env.DSH_PERMISSION_MODE === 'danger-full-access' ? 'bypassPermissions' : process.env.DSH_PERMISSION_MODE === 'workspace-write' ? 'acceptEdits' : 'dontAsk'"

- id: tool-subagent-control
  name: '@deepseek-ai/dsh-tool-subagent-control'

- id: tool-subagent-list-agents
  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'

- id: tool-subagent-report
  name: '@deepseek-ai/dsh-tool-subagent-report'

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    backgroundMode: continuable
    maxDepth: 1

- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
    toolName: subagent_fork
    backgroundMode: one-shot
    enableRunInBackground: false
    maxDepth: 1

- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    enableRunInBackground: false
    maxDepth: provider-managed

- id: tool-subagent-claude-code
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: claude-code
    toolName: subagent_claude_code
    backgroundMode: one-shot
    enableRunInBackground: false
    maxDepth: provider-managed

# Workflow 引擎（worker 线程跑模型编写的脚本，spawn 后端扇出 agent）。
- id: workflow-worker-thread
  name: '@deepseek-ai/dsh-workflow-worker-thread'
  config:
    provider: spawn

- id: tool-workflow
  name: '@deepseek-ai/dsh-tool-workflow'

- id: tool-ralph
  name: '@deepseek-ai/dsh-tool-ralph'

# 任务清单与重复提醒。
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'

# 文件系统栈: 与 bash 共用同一沙箱策略；read-before-edit 观察策略叠加其上。
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    cwd: !!js process.cwd()

- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: true
`;
}

export interface RuntimeSettingsSeed {
  llmPiAiProviders: string;
  agentDefaultModel: string;
}

/**
 * Extract the llm-pi-ai and agent-default-model sections from the user's global
 * $DSH_HOME/settings.yaml. Line-based so we never rewrite the user's file and
 * never depend on a YAML parser.
 */
export function extractUserSections(userSettingsYaml: string): RuntimeSettingsSeed {
  const sections: Record<string, string> = {};
  const lines = userSettingsYaml.split(/\r?\n/);
  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of lines) {
    const isTopLevel = line.length > 0 && !line.startsWith(' ') && !line.startsWith('#');
    if (isTopLevel) {
      if (current !== null && buffer.length > 0) sections[current] = buffer.join('\n');
      const key = line.split(':')[0].trim();
      if (key === 'llm-pi-ai' || key === 'agent-default-model') {
        current = key;
        buffer = [];
      } else {
        current = null;
        buffer = [];
      }
      continue;
    }
    if (current !== null && line.length > 0 && !line.startsWith('#')) {
      buffer.push(line);
    }
  }
  if (current !== null && buffer.length > 0) sections[current] = buffer.join('\n');
  return {
    llmPiAiProviders: sections['llm-pi-ai'] ?? '',
    agentDefaultModel: sections['agent-default-model'] ?? '',
  };
}

/** Re-indent while preserving relative nesting (first line's indent is the base). */
function reindent(text: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return '';
  const base = (lines[0].match(/^ */)?.[0].length ?? 0);
  return lines.map((line) => {
    const current = (line.match(/^ */)?.[0].length ?? 0);
    return '  ' + ' '.repeat(Math.max(0, current - base)) + line.trimStart();
  }).join('\n');
}

function localProviderProfileLines(providerIndent: number): string[] {
  const provider = ' '.repeat(providerIndent + 2);
  const field = ' '.repeat(providerIndent + 4);
  const item = ' '.repeat(providerIndent + 6);
  const itemField = ' '.repeat(providerIndent + 8);
  const effort = ' '.repeat(providerIndent + 10);
  return [
    provider + LOCAL_PROVIDER_ID + ':',
    field + 'displayName: 本地 Qwen（llama.cpp 127.0.0.1:8081）',
    field + 'apiKeyEnv: ' + LOCAL_PROVIDER_API_KEY_ENV,
    field + 'api: openai-completions',
    field + 'baseURL: ' + LOCAL_PROVIDER_BASE_URL,
    field + 'compat:',
    item + 'supportsStore: false',
    item + 'supportsDeveloperRole: false',
    item + 'supportsReasoningEffort: false',
    item + 'supportsUsageInStreaming: true',
    item + 'maxTokensField: max_tokens',
    item + 'thinkingFormat: qwen-chat-template',
    item + 'supportsStrictMode: false',
    field + 'models:',
    item + '- id: ' + LOCAL_PROVIDER_MODEL_ID,
    itemField + 'name: Qwen3.6 35B A3B Uncensored I-Compact（本地）',
    itemField + 'contextWindow: ' + LOCAL_PROVIDER_CONTEXT_WINDOW,
    itemField + 'maxTokens: 8192',
    itemField + 'input: [text]',
    itemField + 'reasoningEfforts:',
    effort + 'off:',
    effort + 'high: high',
    effort + 'max: max',
  ];
}

/** Keep the plugin-owned local route available without changing global DSH settings. */
function withBuiltinLocalProvider(text: string): string {
  const lines = reindent(text).split('\n').filter((line) => line.trim() !== '');
  let providersIndex = lines.findIndex((line) => line.trim() === 'providers:');
  if (providersIndex === -1) {
    lines.push('  providers:');
    providersIndex = lines.length - 1;
  }
  const providersIndent = lines[providersIndex].match(/^ */)?.[0].length ?? 0;
  let providersEnd = lines.length;
  for (let i = providersIndex + 1; i < lines.length; i++) {
    const indent = lines[i].match(/^ */)?.[0].length ?? 0;
    if (indent <= providersIndent) {
      providersEnd = i;
      break;
    }
  }
  const alreadyPresent = lines.some((line, index) => index > providersIndex
    && index < providersEnd
    && line.trim() === LOCAL_PROVIDER_ID + ':');
  if (!alreadyPresent) {
    lines.splice(providersEnd, 0, ...localProviderProfileLines(providersIndent));
  }
  return lines.join('\n');
}

export interface ReasoningOverride {
  provider: string;
  effort: ReasoningEffort;
}

export interface RuntimeModelSelection {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  revision: string;
}

/**
 * Render the plugin-owned runtime settings.yaml seed. When a reasoning
 * override targets a pi-ai route, the route gains a `reasoning` field
 * (hot-published by dsh-settings-file — no backend restart needed).
 */
export function settingsSeedTemplate(
  seed: RuntimeSettingsSeed,
  reasoning?: ReasoningOverride,
  selection?: RuntimeModelSelection,
): string {
  let llm = seed.llmPiAiProviders;
  if (llm.trim() === '') {
    llm = '  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_GO_API_KEY';
  }
  let model = selection === undefined
    ? seed.agentDefaultModel
    : `  provider: '${selection.provider.replace(/'/g, "''")}'\n`
      + `  model: '${selection.model.replace(/'/g, "''")}'\n`
      + `  reasoningEffort: '${selection.reasoningEffort}'\n`
      + `  revision: '${selection.revision.replace(/'/g, "''")}'`;
  if (model.trim() === '') model = '  provider: opencode-go\n  model: deepseek-v4-flash\n  reasoningEffort: max';
  let llmLines = withBuiltinLocalProvider(llm);
  if (reasoning !== undefined) {
    const lines = llmLines.split('\n');
    const providerIndex = lines.findIndex((line) => line.trim() === reasoning.provider + ':');
    if (providerIndex !== -1) {
      const providerIndent = (lines[providerIndex].match(/^ */)?.[0].length ?? 0);
      const childIndent = ' '.repeat(providerIndent + 2);
      const reasoningLine = childIndent + 'reasoning: ' + reasoning.effort;
      let providerEnd = lines.length;
      for (let i = providerIndex + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed === '') continue;
        const indent = lines[i].match(/^ */)?.[0].length ?? 0;
        if (indent <= providerIndent) {
          providerEnd = i;
          break;
        }
      }
      const reasoningIndex = lines.findIndex((line, index) => index > providerIndex
        && index < providerEnd
        && line.trim().startsWith('reasoning:'));
      if (reasoning.effort === 'default') {
        if (reasoningIndex !== -1) lines.splice(reasoningIndex, 1);
      } else if (reasoningIndex === -1) {
        lines.splice(providerIndex + 1, 0, reasoningLine);
      } else {
        lines[reasoningIndex] = reasoningLine;
      }
      llmLines = lines.join('\n');
    }
  }
  return `# dsh-agent 插件自有的 ACP 运行设置（复制自用户主配置 $DSH_HOME/settings.yaml；
# 用户主配置被插件只读，绝不写回）。外部编辑会热发布到运行中的后端。
llm-pi-ai:
${llmLines}
agent-default-model:
${reindent(model)}
`;
}

/** Static model catalog snapshots (rc.2). Free-text overrides are always allowed. */
export const MODEL_CATALOG: ModelCatalog = {
  'opencode-go': {
    name: 'opencode-go（opencode.ai/zen 网关）',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
      { id: 'kimi-k3', name: 'Kimi K3' },
      { id: 'glm-5.1', name: 'GLM-5.1' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus' },
      { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus' },
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max' },
      { id: 'minimax-m2.7', name: 'MiniMax-M2.7' },
      { id: 'minimax-m3', name: 'MiniMax-M3' },
      { id: 'mimo-v2.5', name: 'MiMo V2.5' },
      { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro' },
      { id: 'hy3', name: 'Hy3' },
      { id: 'grok-4.5', name: 'Grok 4.5' },
    ],
  },
  'deepseek-official': {
    name: 'DeepSeek 官方 API',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp' },
    ],
  },
  [LOCAL_PROVIDER_ID]: {
    name: '本地 Qwen（llama.cpp · 127.0.0.1:8081）',
    models: [
      { id: LOCAL_PROVIDER_MODEL_ID, name: 'Qwen3.6 35B A3B Uncensored I-Compact' },
    ],
  },
};
