// Unified feature registry: every toggleable capability (DSH runtime
// tools and plugin-side UI features) lives here, so the settings UI renders
// one searchable, scrollable, grouped list and new features get a switch
// for free.
import { TOOL_CATALOG } from '../runtime/templates';

export type FeatureKind = 'runtime' | 'ui';

export interface FeatureEntry {
  id: string;
  label: string;
  description: string;
  category: string;
  kind: FeatureKind;
}

export const FEATURE_REGISTRY: FeatureEntry[] = [
  // DSH runtime tools (cordis entries excluded + backend restart).
  ...TOOL_CATALOG.map((tool) => ({
    id: 'tool.' + tool.id,
    label: tool.label,
    description: tool.description,
    category: tool.category,
    kind: 'runtime' as const,
  })),
  // Plugin-side UI features (hot toggles, no restart).
  {
    id: 'ui.typewriter',
    label: '打字机流式',
    description: '逐字揭示 AI 回复;关闭则整段显示',
    category: '界面功能',
    kind: 'ui',
  },
  {
    id: 'ui.quote-context',
    label: '框选引用上下文',
    description: '框选 AI 回复弹出「加入上下文」按钮与注释气泡',
    category: '界面功能',
    kind: 'ui',
  },
  {
    id: 'ui.rewind',
    label: '回退按钮',
    description: '用户消息下方的回退到某一步按钮',
    category: '界面功能',
    kind: 'ui',
  },
  {
    id: 'ui.branch',
    label: '分支按钮',
    description: 'AI 回复下方的分支新会话按钮',
    category: '界面功能',
    kind: 'ui',
  },
  {
    id: 'ui.context-badge',
    label: '上下文徽标',
    description: '用户消息下显示引用/附件计数徽标',
    category: '界面功能',
    kind: 'ui',
  },
];

/** All features enabled unless explicitly turned off. */
export const FEATURE_DEFAULTS: Record<string, boolean> = Object.fromEntries(
  FEATURE_REGISTRY.map((feature) => [feature.id, true]),
);

/** Merge stored flags over the defaults (missing keys = enabled). */
export function resolveFeatureFlags(stored: Record<string, boolean> | undefined): Record<string, boolean> {
  return { ...FEATURE_DEFAULTS, ...(stored ?? {}) };
}

/** cordis entry ids excluded for disabled runtime tools. */
export function disabledCordisIds(flags: Record<string, boolean>): string[] {
  const ids: string[] = [];
  for (const tool of TOOL_CATALOG) {
    if (flags['tool.' + tool.id] === false) ids.push(...tool.cordisIds);
  }
  return ids;
}
