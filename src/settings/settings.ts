// Plugin settings model.
import { join } from 'node:path';
export type ReasoningEffort = 'default' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'ask' | 'never';
export type QueuePolicy = 'interrupt' | 'queue';
export type AgentPresetId = 'manual' | 'research' | 'notes' | 'safe-readonly' | 'deep-task';

export interface DshAgentSettings {
  dshHome: string;
  provider: string;
  model: string;
  /** Named behavior bundle; manual preserves individually selected fields. */
  agentPreset: AgentPresetId;
  /** Providers whose models should NOT appear in the chat composer's model list. */
  hiddenProviders: string[];
  /** Individual models hidden from the chat composer list ("providerId::modelId"). */
  hiddenModels: string[];
  /** Model ids observed during earlier catalog refreshes ("providerId::modelId"). */
  knownModels: string[];
  reasoningEffort: ReasoningEffort;
  permissionMode: PermissionMode;
  approvalPolicy: ApprovalPolicy;
  /** Sending while the model replies: interrupt the turn, or queue after it. */
  queuePolicy: QueuePolicy;
  /** DSH tool ids disabled in the runtime (excluded from cordis.yml). */
  disabledTools: string[];
  /** Unified feature switches (feature-registry ids -> enabled). */
  featureFlags: Record<string, boolean>;
  nodeCommand: string;
  autoStart: boolean;
  /** Automatically remove raw session logs older than this many days (0 = keep forever). */
  sessionLogRetentionDays: number;
  /** Redact common credential shapes before tool activity is persisted in data.json. */
  redactSensitiveLogs: boolean;
  /** Automatically request context compaction at this percentage (0 = disabled). */
  autoCompactPercent: number;
  /** Hard timeout for one ACP turn (0 = unlimited). */
  maxTurnMinutes: number;
}

export const DEFAULT_SETTINGS: DshAgentSettings = {
  dshHome: '',
  provider: 'opencode-go',
  model: 'deepseek-v4-flash',
  agentPreset: 'manual',
  hiddenProviders: [],
  hiddenModels: [],
  knownModels: [],
  reasoningEffort: 'max',
  permissionMode: 'workspace-write',
  approvalPolicy: 'ask',
  queuePolicy: 'interrupt',
  disabledTools: [],
  featureFlags: {},
  nodeCommand: 'node',
  autoStart: true,
  sessionLogRetentionDays: 90,
  redactSensitiveLogs: true,
  autoCompactPercent: 80,
  maxTurnMinutes: 30,
};

/** Resolve the DSH home: setting wins, then $DSH_HOME, then ~/.dsh. */
export function resolveDshHome(settings: DshAgentSettings): string {
  if (settings.dshHome !== undefined && settings.dshHome.trim() !== '') {
    return settings.dshHome.trim();
  }
  if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') {
    return process.env.DSH_HOME;
  }
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home !== undefined && home !== '') {
    return join(home, '.dsh');
  }
  return '';
}
