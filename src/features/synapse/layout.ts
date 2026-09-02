import type { Conversation } from '../chat/session';

export const SYNAPSE_CARD_WIDTH = 300;
export const SYNAPSE_CARD_HEIGHT = 108;
const COLUMN_GAP = 92;
const ROW_GAP = 56;

export interface SynapsePosition {
  x: number;
  y: number;
}

export interface SynapseNode extends SynapsePosition {
  conversation: Conversation;
  parentId?: string;
  depth: number;
}

export interface SynapseWorkspaceGroup {
  key: string;
  label: string;
  conversations: Conversation[];
  updatedAt: number;
}

export function conversationUpdatedAt(conversation: Conversation): number {
  return conversation.messages.length > 0
    ? conversation.messages[conversation.messages.length - 1].time
    : conversation.createdAt;
}

export function workspaceLabel(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  const label = segments[segments.length - 1]?.trim();
  return label !== undefined && label !== '' ? label : path;
}

export function groupSynapseConversations(conversations: Conversation[]): SynapseWorkspaceGroup[] {
  const groups = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    if (conversation.closed === true) continue;
    const entries = groups.get(conversation.workspace) ?? [];
    entries.push(conversation);
    groups.set(conversation.workspace, entries);
  }
  return [...groups.entries()].map(([key, entries]) => ({
    key,
    label: workspaceLabel(key),
    conversations: entries.sort((a, b) => conversationUpdatedAt(b) - conversationUpdatedAt(a)),
    updatedAt: Math.max(...entries.map(conversationUpdatedAt)),
  })).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Archive every visible conversation in one ACP workspace as one action. */
export function closeSynapseWorkspaceConversations(
  conversations: Conversation[],
  workspace: string,
): number {
  let closed = 0;
  for (const conversation of conversations) {
    if (conversation.workspace !== workspace || conversation.closed === true) continue;
    conversation.closed = true;
    closed += 1;
  }
  return closed;
}

/**
 * Only data projected by Synapse belongs in this signature. Streaming text and
 * reasoning deltas intentionally stay out so they cannot rebuild a large map.
 */
export function synapseContentSignature(
  conversations: Conversation[],
  positions: Record<string, SynapsePosition>,
  ui: {
    selectedWorkspace?: string;
    searchQuery: string;
  },
): string {
  const nodes = conversations
    .filter((conversation) => conversation.closed !== true)
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      workspace: conversation.workspace,
      status: conversation.status,
      branchedFrom: conversation.branchedFrom,
      messageCount: conversation.messages.filter((message) => message.superseded !== true).length,
      updatedAt: conversationUpdatedAt(conversation),
      position: positions[conversation.id],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ ...ui, nodes });
}

/** Preserve finite signed coordinates so the whiteboard has no visible edge. */
export function normalizeSynapsePosition(position: SynapsePosition | undefined): SynapsePosition | undefined {
  if (position === undefined || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return undefined;
  return {
    x: Math.round(position.x),
    y: Math.round(position.y),
  };
}

/** Stable branch-tree layout with optional persisted drag overrides. */
export function layoutSynapseNodes(
  conversations: Conversation[],
  positions: Record<string, SynapsePosition> = {},
): SynapseNode[] {
  const ordered = [...conversations].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const byId = new Map(ordered.map((conversation) => [conversation.id, conversation]));
  const children = new Map<string, Conversation[]>();
  const roots: Conversation[] = [];
  for (const conversation of ordered) {
    const parentId = conversation.branchedFrom;
    if (parentId === undefined || parentId === conversation.id || !byId.has(parentId)) {
      roots.push(conversation);
      continue;
    }
    const entries = children.get(parentId) ?? [];
    entries.push(conversation);
    children.set(parentId, entries);
  }

  const nodes = new Map<string, SynapseNode>();
  const visiting = new Set<string>();
  let nextLeafY = 52;
  const place = (conversation: Conversation, depth: number): number => {
    const existing = nodes.get(conversation.id);
    if (existing !== undefined) return existing.y;
    if (visiting.has(conversation.id)) {
      const y = nextLeafY;
      nextLeafY += SYNAPSE_CARD_HEIGHT + ROW_GAP;
      const stored = normalizeSynapsePosition(positions[conversation.id]);
      nodes.set(conversation.id, {
        conversation,
        parentId: conversation.branchedFrom,
        depth,
        x: stored?.x ?? 58 + depth * (SYNAPSE_CARD_WIDTH + COLUMN_GAP),
        y: stored?.y ?? y,
      });
      return stored?.y ?? y;
    }
    visiting.add(conversation.id);
    const descendants = (children.get(conversation.id) ?? []).filter((child) => !visiting.has(child.id));
    let autoY: number;
    if (descendants.length === 0) {
      autoY = nextLeafY;
      nextLeafY += SYNAPSE_CARD_HEIGHT + ROW_GAP;
    } else {
      const childY = descendants.map((child) => place(child, depth + 1));
      autoY = (childY[0] + childY[childY.length - 1]) / 2;
    }
    visiting.delete(conversation.id);
    const stored = normalizeSynapsePosition(positions[conversation.id]);
    const y = stored?.y ?? Math.round(autoY);
    nodes.set(conversation.id, {
      conversation,
      parentId: conversation.branchedFrom,
      depth,
      x: stored?.x ?? 58 + depth * (SYNAPSE_CARD_WIDTH + COLUMN_GAP),
      y,
    });
    return y;
  };

  for (const root of roots) {
    place(root, 0);
    nextLeafY += ROW_GAP;
  }
  // Defensive fallback for malformed cyclic lineage.
  for (const conversation of ordered) {
    if (!nodes.has(conversation.id)) place(conversation, 0);
  }
  return ordered.map((conversation) => nodes.get(conversation.id) as SynapseNode);
}
