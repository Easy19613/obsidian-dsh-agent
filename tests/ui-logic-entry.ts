// Unit tests for pure UI-logic helpers (no Obsidian runtime needed):
// - reconcileWireText (recovers a final summary that missed the log poll)
// - BlockBuilder text dedup (wire + session-log double delivery)
import type { ChatMessage, Conversation } from '../src/features/chat/session';
import {
  compareConversationsByRecent,
  appendCumulativeStreamText,
  appendMessage,
  appendAssistantAfterPrompt,
  canReuseRenderedMessageDom,
  cancelPendingPrompt,
  contextTransferOfMessages,
  createConversation,
  createConversationBranch,
  dedupeCumulativeTextBlocks,
  latestAssistantMessageIndex,
  mergeMirroredStreamText,
  mergeUsageSnapshot,
  markSubagentRunActive,
  messagesBeforePending,
  movePendingPrompt,
  pruneChangeSetSnapshots,
  reconcileWireText,
  resolveActiveConversationId,
  isGoalWaitingForUserText,
  isMessageIdPrefix,
  isSyntheticContextTitle,
  normalizeConversationTitle,
  repairSyntheticContextTitle,
  rewindForAssistantRegeneration,
  settleSubagentRun,
  shouldAutoCompact,
  uncommittedStreamText,
} from '../src/features/chat/session';
import { BlockBuilder, mergeReasoningText, normalizeReasoningText } from '../src/features/chat/block-builder';
import { nextTypewriterVisibleChars, TypewriterProgressStore } from '../src/features/chat/typewriter';
import { normalizeWebViewerReadResult, webViewerReadScript } from '../src/features/editor/selection-tracker';
import {
  LOCAL_PROVIDER_BASE_URL,
  LOCAL_PROVIDER_CONTEXT_WINDOW,
  LOCAL_PROVIDER_ID,
  LOCAL_PROVIDER_MODEL_ID,
  MODEL_CATALOG,
  hotModelRouteModule,
  settingsSeedTemplate,
  visibleModelEntries,
} from '../src/runtime/templates';
import { excludeToolEntries, TOOL_CATALOG } from '../src/runtime/templates';
import {
  discoverRuntimeModelCatalog,
  modelCatalogKeys,
  modelEffortsOf,
  preferredEffort,
  reconcileDiscoveredModels,
} from '../src/runtime/model-catalog';
import { disabledCordisIds, FEATURE_REGISTRY, resolveFeatureFlags } from '../src/features/feature-registry';
import { contextWindowOf } from '../src/runtime/model-context-windows';
import { DEFAULT_SETTINGS } from '../src/settings/settings';
import { AGENT_PRESETS, agentPresetPersona, applyAgentPreset } from '../src/features/agent-presets';
import {
  closeSynapseWorkspaceConversations,
  groupSynapseConversations,
  layoutSynapseNodes,
  normalizeSynapsePosition,
  conversationUpdatedAt,
  synapseContentSignature,
  workspaceLabel,
} from '../src/features/synapse/layout';
import { ownerWindowOf } from '../src/features/synapse/window-scope';
import {
  archiveSessionLogs,
  backupDataBeforeMigration,
  cleanupSessionLogs,
  collectStorageStats,
  formatBytes,
  redactSensitiveText,
} from '../src/persistence/data-lifecycle';
import {
  compactConversationForStorage,
  rehydrateConversationForRuntime,
  STORED_THINKING_LIMIT,
  STORED_TOOL_ARGUMENT_LIMIT,
  STORED_TOOL_RESULT_LIMIT,
} from '../src/persistence/conversation-storage';
import {
  attributedWorkspacePaths,
  compareWorkspaceSnapshots,
  previewLineDiff,
  revertFileChanges,
  snapshotWorkspace,
} from '../src/features/chat/change-tracker';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log('PASS ' + label + (detail !== '' ? ' — ' + detail : ''));
  } else {
    failures += 1;
    console.log('FAIL ' + label + (detail !== '' ? ' — ' + detail : ''));
  }
}

// --- Obsidian Web Viewer selection/page extraction ---
{
  const selected = normalizeWebViewerReadResult({
    ok: true,
    title: '微信文章标题',
    url: 'https://mp.weixin.qq.com/s/example',
    selectedText: '用户选中的关键段落',
    pageText: '文章开头\n用户选中的关键段落\n文章结尾',
    selectionTruncated: false,
    pageTruncated: true,
  });
  check('web viewer: selection wins while retaining surrounding page context', selected?.mode === 'selection'
    && selected.text === '用户选中的关键段落'
    && selected.contextText?.includes('文章结尾') === true
    && selected.contextTruncated === true, JSON.stringify(selected));
  const page = normalizeWebViewerReadResult({
    ok: true,
    title: '普通网页',
    url: 'https://example.com/article',
    selectedText: '',
    pageText: '完整正文',
    selectionTruncated: false,
    pageTruncated: false,
  });
  check('web viewer: page body becomes context when no text is selected', page?.mode === 'page'
    && page.text === '完整正文' && page.contextText === undefined, JSON.stringify(page));
  check('web viewer: malformed guest result is ignored instead of clearing context',
    normalizeWebViewerReadResult({ ok: false }) === undefined);
  const script = webViewerReadScript();
  check('web viewer: reader prefers WeChat/general article containers', script.includes('#js_content')
    && script.includes("'article'") && script.includes("'[role=\"main\"]'"));
  check('web viewer: reader never accesses cookies or browser storage', !script.includes('document.cookie')
    && !script.includes('localStorage') && !script.includes('sessionStorage'));
}

// --- multi-window ownership ---
{
  const mainWindow = {} as Window;
  const popoutWindow = {} as Window;
  const element: { ownerDocument: { defaultView: Window | null } } = {
    ownerDocument: { defaultView: popoutWindow },
  };
  check('synapse: interactions use the popout window that owns the map', ownerWindowOf(element, mainWindow) === popoutWindow);
  element.ownerDocument.defaultView = null;
  check('synapse: detached elements safely fall back to the main window', ownerWindowOf(element, mainWindow) === mainWindow);
}

// --- incremental transcript rendering ---
{
  const history = [{ id: 'u1' }, { id: 'a1' }];
  check('render sequence: an appended question preserves the historical prefix',
    isMessageIdPrefix(history, [...history, { id: 'u2' }]));
  check('render sequence: an insertion inside history requires an atomic rebuild',
    !isMessageIdPrefix(history, [{ id: 'u1' }, { id: 'inserted' }, { id: 'a1' }]));
  check('render cache: exact conversation DOM can be restored immediately',
    canReuseRenderedMessageDom(history, history));
  check('render cache: an appended turn can reuse the cached prefix',
    canReuseRenderedMessageDom(history, [...history, { id: 'u2' }]));
  check('render cache: a rewritten history is rejected',
    !canReuseRenderedMessageDom(history, [{ id: 'u1' }, { id: 'replacement' }]));
}

// --- Goal idle-loop guard ---
{
  check('goal guard: detects Chinese future-input waiting loops',
    isGoalWaitingForUserText('目标继续保持 active 待命——待你提出下一个问题时再继续。'));
  check('goal guard: detects English future-input waiting loops',
    isGoalWaitingForUserText('No new user input. Waiting for the user.'));
  check('goal guard: does not stop ordinary progress reports',
    !isGoalWaitingForUserText('已完成数据清洗，下一轮继续执行模型评估。'));
}

// --- active conversation must never resolve to archived history ---
{
  const archived = createConversation('D:\\vault');
  archived.id = 'archived';
  archived.closed = true;
  const open = createConversation('D:\\vault');
  open.id = 'open';
  check('conversation selection: stale archived id falls back to an open conversation',
    resolveActiveConversationId([archived, open], archived.id) === open.id);
  open.closed = true;
  check('conversation selection: all archived conversations produce an empty state',
    resolveActiveConversationId([archived, open], open.id) === undefined);
}

// --- synthetic subagent-console lifecycle ---
{
  const run = {
    runId: 'subagent-console:test',
    name: '子代理控制台',
    kind: 'subagent' as const,
    startedAt: 100,
    agents: [
      { seq: 1, label: 'done', outcome: 'completed', endedAt: 220 },
      { seq: 2, label: 'running' },
    ],
  };
  check('subagent console: timer remains live while any child is running',
    settleSubagentRun(run, 300) === false && run.endedAt === undefined);
  run.agents[1].outcome = 'completed';
  run.agents[1].endedAt = 280;
  check('subagent console: timer freezes at the last child completion',
    settleSubagentRun(run, 300) && run.endedAt === 280 && run.stopReason === 'completed');
  markSubagentRunActive(run);
  check('subagent console: a later child reopens the aggregate run',
    run.endedAt === undefined && run.stopReason === undefined);
}

{
  const run = {
    runId: 'subagent-console:error',
    name: '子代理控制台',
    kind: 'subagent' as const,
    agents: [
      { seq: 1, label: 'done', outcome: 'completed', endedAt: 200 },
      { seq: 2, label: 'failed', outcome: 'error', endedAt: 240 },
    ],
  };
  check('subagent console: failed children also stop the timer',
    settleSubagentRun(run, 300) && run.endedAt === 240 && run.stopReason === 'error');
}

// --- native Synapse workspace projection and branch layout ---
{
  const root = createConversation('D:\\vault\\research');
  root.id = 'syn-root';
  root.title = '根会话';
  root.createdAt = 10;
  root.messages = [
    { id: 'u', role: 'user', text: '研究问题', time: 20 },
    { id: 'a', role: 'assistant', text: '研究回答', time: 30 },
  ];
  const branch = createConversation('D:\\vault\\research');
  branch.id = 'syn-branch';
  branch.title = '分支会话';
  branch.createdAt = 40;
  branch.branchedFrom = root.id;
  const other = createConversation('D:\\vault\\other');
  other.id = 'syn-other';
  other.createdAt = 50;
  const archived = createConversation('D:\\vault\\research');
  archived.id = 'syn-archived';
  archived.closed = true;
  const groups = groupSynapseConversations([root, branch, other, archived]);
  check('synapse: open conversations group by ACP workspace',
    groups.length === 2
      && groups.find((group) => group.key === root.workspace)?.conversations.length === 2);
  check('synapse: archived conversations stay off the active map',
    groups.every((group) => group.conversations.every((conversation) => conversation.id !== archived.id)));
  check('synapse: Windows workspace label uses the final folder', workspaceLabel(root.workspace) === 'research');
  const nodes = layoutSynapseNodes([root, branch], { 'syn-root': { x: 101, y: 202 } });
  const rootNode = nodes.find((node) => node.conversation.id === root.id);
  const branchNode = nodes.find((node) => node.conversation.id === branch.id);
  check('synapse: persisted drag position overrides automatic layout', rootNode?.x === 101 && rootNode.y === 202);
  const negative = normalizeSynapsePosition({ x: -451.6, y: -320.2 });
  check('synapse: whiteboard positions remain valid left and above the origin',
    negative?.x === -452 && negative.y === -320);
  check('synapse: branch lineage becomes a deeper connected column',
    branchNode?.parentId === root.id && branchNode.depth === 1 && (branchNode.x ?? 0) > (rootNode?.x ?? 0));
  check('synapse: map metadata tracks activity without projecting conversation content',
    conversationUpdatedAt(root) === 30);
  const initialSignature = synapseContentSignature([root, branch], {}, {
    selectedWorkspace: root.workspace,
    searchQuery: '',
  });
  root.messages[1].streamedText = '正在持续追加但地图无需重绘';
  const streamedSignature = synapseContentSignature([root, branch], {}, {
    selectedWorkspace: root.workspace,
    searchQuery: '',
  });
  check('synapse: streamed text does not rebuild the whole map', initialSignature === streamedSignature);
  root.title = '新标题';
  check('synapse: title changes still rebuild the map', initialSignature !== synapseContentSignature([root, branch], {}, {
    selectedWorkspace: root.workspace,
    searchQuery: '',
  }));
  const bulkA = createConversation('D:\\vault\\bulk');
  const bulkB = createConversation('D:\\vault\\bulk');
  const alreadyClosed = createConversation('D:\\vault\\bulk');
  alreadyClosed.closed = true;
  const untouched = createConversation('D:\\vault\\untouched');
  const closedCount = closeSynapseWorkspaceConversations(
    [bulkA, bulkB, alreadyClosed, untouched],
    'D:\\vault\\bulk',
  );
  check('synapse: close workspace archives every open conversation exactly once', closedCount === 2
    && bulkA.closed === true && bulkB.closed === true && alreadyClosed.closed === true);
  check('synapse: close workspace never affects another workspace', untouched.closed !== true);
  check('synapse: repeating close workspace is an idempotent no-op',
    closeSynapseWorkspaceConversations([bulkA, bulkB, alreadyClosed, untouched], 'D:\\vault\\bulk') === 0);
  const synapseViewSource = readFileSync(join(process.cwd(), 'src', 'features', 'synapse', 'view.ts'), 'utf8');
  check('synapse: workspace rail preserves scroll position across full renders',
    synapseViewSource.includes('this.workspaceScrollTop = previousWorkspaceList.scrollTop')
      && synapseViewSource.includes('workspaceList.scrollTop = this.workspaceScrollTop')
      && synapseViewSource.includes('workspaceList.onscroll'));
}

// --- server title filtering and persisted-title repair ---
{
  const conversation = createConversation('D:\\vault');
  conversation.messages.push({ id: 'u', role: 'user', text: '真正的问题名称', time: 1 });
  conversation.title = '以下是我们此前对话的历史（';
  conversation.titleFromServer = true;
  check('title: injected history preface is recognized', isSyntheticContextTitle(conversation.title));
  check('title: old synthetic server title is repaired from the user question',
    repairSyntheticContextTitle(conversation) && conversation.title === '真正的问题名称' && conversation.titleFromServer === false);
  conversation.title = '以下是我们此前对话的历史（';
  conversation.titleManuallySet = true;
  check('title: an explicitly renamed conversation is never auto-repaired', !repairSyntheticContextTitle(conversation));
  check('title: manual normalization is bounded and single-line',
    normalizeConversationTitle('  第一行\n第二行  ') === '第一行 第二行');
}

// --- mirrored JSONL/wire streaming text ---
check('stream merge: live mirror extends canonical text',
  mergeMirroredStreamText('你好', '你好，世界') === '你好，世界');
check('stream merge: canonical text can lead delayed mirror',
  mergeMirroredStreamText('你好，世界', '你好') === '你好，世界');
check('stream merge: divergent sources never concatenate duplicate answers',
  mergeMirroredStreamText('旧', '新的回答') === '新的回答');
check('stream lifecycle: closed cursor never replays the full answer',
  uncommittedStreamText({ id: 'closed', role: 'assistant', text: '完整回答', time: 0 }) === '');
check('stream lifecycle: open cursor returns only the uncommitted suffix',
  uncommittedStreamText({
    id: 'open', role: 'assistant', text: '第一段第二段', time: 0, streamedTextCursor: '第一段'.length,
  }) === '第二段');

{
  const short = '实时输出'.repeat(10);
  check('typewriter: ordinary live chunks finish on the next animation frame',
    nextTypewriterVisibleChars(short, 0) === short.length);
  const large = '长回答'.repeat(200);
  const advanced = nextTypewriterVisibleChars(large, 0);
  check('typewriter: buffered chunks catch up in batches', advanced >= 48 && advanced < large.length, String(advanced));
  check('typewriter: adaptive cursor never splits a surrogate pair',
    nextTypewriterVisibleChars('a'.repeat(47) + '🤖' + 'b'.repeat(48), 0) === 49);

  const progress = new TypewriterProgressStore();
  progress.remember('assistant-1', '0', 18, '正在流式输出的回答'.repeat(4));
  check('typewriter: switching conversations restores the revealed position',
    progress.restore('assistant-1', '0', '正在流式输出的回答'.repeat(5)) === 18);
  check('typewriter: a new stream segment starts independently',
    progress.restore('assistant-1', '18', '新片段') === 0);
  progress.forgetMessage('assistant-1');
  check('typewriter: completed messages release remembered progress',
    progress.restore('assistant-1', '0', '回答') === 0);
}

{
  const message: ChatMessage = {
    id: 'stream-cursor', role: 'assistant', text: '', time: 0, streamedTextCursor: 0,
  };
  const first = appendCumulativeStreamText(message, '第一段');
  const repeated = appendCumulativeStreamText(message, '第一段');
  const second = appendCumulativeStreamText(message, '第一段\n\n第二段');
  check('stream cursor: cumulative snapshots append only novel tail', first && !repeated && second
    && textBlocks(message).map((block) => block.text).join('|') === '第一段|第二段', JSON.stringify(message.blocks));
}

{
  const message: ChatMessage = {
    id: 'stream-migration', role: 'assistant', text: '第一段\n\n第二段\n\n第三段', time: 0,
    blocks: [
      { kind: 'text', text: '第一段' },
      { kind: 'todo', todos: [] },
      { kind: 'text', text: '第二段' },
      { kind: 'text', text: '第一段\n\n第二段' },
      { kind: 'text', text: '第一段\n\n第二段\n\n第三段' },
      { kind: 'text', text: '第一段\n\n第二段\n\n第三段' },
    ],
  };
  const changed = dedupeCumulativeTextBlocks(message);
  check('stream migration: old cumulative blocks collapse to novel segments', changed
    && textBlocks(message).map((block) => block.text).join('|') === '第一段|第二段|第三段'
    && message.blocks?.[1].kind === 'todo', JSON.stringify(message.blocks));
}

function textBlocks(m: ChatMessage): { kind: 'text'; text: string }[] {
  return (m.blocks ?? []).filter((b): b is { kind: 'text'; text: string } => b.kind === 'text');
}

// --- reconcileWireText ---
{
  const m: ChatMessage = { id: 'r1', role: 'assistant', text: '## 总结\n拆分完成。', time: 0, blocks: [] };
  const changed = reconcileWireText(m);
  check('reconcile: no blocks appends wire', changed && textBlocks(m).map((b) => b.text).join('') === '## 总结\n拆分完成。', JSON.stringify(m.blocks));
}
{
  const m: ChatMessage = {
    id: 'r2', role: 'assistant', text: '第一部分\n第二部分', time: 0,
    blocks: [{ kind: 'text', text: '第一部分' }, { kind: 'text', text: '第二部分' }],
  };
  check('reconcile: covered blocks unchanged', reconcileWireText(m) === false);
}
{
  const m: ChatMessage = {
    id: 'r3', role: 'assistant', text: '已拆分 5 篇笔记。\n## 总结\n全部完成。', time: 0,
    blocks: [{ kind: 'text', text: '已拆分 5 篇笔记。' }],
  };
  const changed = reconcileWireText(m);
  const tail = textBlocks(m)[textBlocks(m).length - 1];
  check('reconcile: appends missing final summary', changed && tail !== undefined && tail.text === '## 总结\n全部完成。', JSON.stringify(tail));
}
{
  const m: ChatMessage = {
    id: 'r4', role: 'assistant', text: 'a b', time: 0,
    blocks: [{ kind: 'text', text: 'a\nb' }],
  };
  check('reconcile: whitespace-equal unchanged', reconcileWireText(m) === false);
}
{
  const m: ChatMessage = {
    id: 'r5', role: 'assistant', text: 'a\nb\n结尾', time: 0,
    blocks: [{ kind: 'text', text: 'a b' }],
  };
  const changed = reconcileWireText(m);
  const tail = textBlocks(m)[textBlocks(m).length - 1];
  check('reconcile: whitespace-prefix remainder', changed && tail !== undefined && tail.text.includes('结尾'), JSON.stringify(tail));
}
{
  const m: ChatMessage = { id: 'r6', role: 'assistant', text: '   ', time: 0, blocks: [] };
  check('reconcile: empty wire unchanged', reconcileWireText(m) === false && (m.blocks ?? []).length === 0);
}

// --- BlockBuilder dedup ---
{
  const message: ChatMessage = { id: 'b1', role: 'assistant', text: '', time: 0 };
  const builder = BlockBuilder.from(message);
  builder.applyStepMessage(undefined, '同一段文本');
  builder.applyStepMessage(undefined, '同一段文本');
  message.blocks = builder.list();
  check('builder: duplicate text kept once', message.blocks.length === 1, JSON.stringify(message.blocks));
}
{
  const message: ChatMessage = { id: 'b2', role: 'assistant', text: '', time: 0 };
  const builder = BlockBuilder.from(message);
  builder.applyStepMessage('思考', '第一段');
  builder.applyStepMessage(undefined, '第一段');
  builder.applyStepMessage(undefined, '第二段');
  message.blocks = builder.list();
  const texts = message.blocks
    .filter((b) => b.kind === 'text')
    .map((b) => (b as { kind: 'text'; text: string }).text);
  check('builder: distinct texts kept in order', JSON.stringify(texts) === JSON.stringify(['第一段', '第二段']), JSON.stringify(texts));
}

// --- visibleModelEntries (chat composer model list visibility) ---
{
  const all = visibleModelEntries([], []);
  const expected = Object.values(MODEL_CATALOG).reduce((sum, c) => sum + c.models.length, 0);
  check('catalog: all providers visible by default', all.length === expected, String(all.length) + ' vs ' + String(expected));
  check('catalog: entries carry provider', all.every((e) => e.providerId !== '' && e.providerName !== ''), '');
}
{
  const filtered = visibleModelEntries(['opencode-go'], []);
  check('catalog: hidden provider excluded', filtered.every((e) => e.providerId !== 'opencode-go'), JSON.stringify(filtered.map((e) => e.providerId)));
  const expected = Object.entries(MODEL_CATALOG)
    .filter(([providerId]) => providerId !== 'opencode-go')
    .reduce((sum, [, catalog]) => sum + catalog.models.length, 0);
  check('catalog: other provider intact', filtered.length === expected, String(filtered.length));
}
{
  const filtered = visibleModelEntries([], ['opencode-go::deepseek-v4-flash']);
  check('catalog: single model hidden', !filtered.some((e) => e.providerId === 'opencode-go' && e.id === 'deepseek-v4-flash'), '');
  const expected = Object.values(MODEL_CATALOG).reduce((sum, c) => sum + c.models.length, 0) - 1;
  check('catalog: others intact when one model hidden', filtered.length === expected, String(filtered.length));
}
{
  const allOpen = MODEL_CATALOG['opencode-go'].models.map((mm) => 'opencode-go::' + mm.id);
  const filtered = visibleModelEntries([], allOpen);
  check('catalog: whole provider hidden via per-model', filtered.every((e) => e.providerId !== 'opencode-go'), String(filtered.length));
}
{
  const first = reconcileDiscoveredModels(['route::old'], [], ['manual::hidden'], false);
  check('catalog: migration seeds current models without hiding them', first.knownModels.join(',') === 'route::old'
    && first.hiddenModels.join(',') === 'manual::hidden', JSON.stringify(first));
  const next = reconcileDiscoveredModels(['route::old', 'route::new'], first.knownModels, first.hiddenModels, true);
  check('catalog: a model first seen on a later startup defaults to unchecked', next.knownModels.includes('route::new')
    && next.hiddenModels.includes('route::new'), JSON.stringify(next));
  const reappeared = reconcileDiscoveredModels(['route::new'], next.knownModels, [], true);
  check('catalog: a previously known model does not become hidden again', reappeared.hiddenModels.length === 0,
    JSON.stringify(reappeared));
}
{
  const profile = mkdtempSync(join(tmpdir(), 'dsh-model-catalog-'));
  try {
    const dataDir = join(profile, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'opencode-go.json'), JSON.stringify({
      'openai-completions': {
        'new-thinking-model': {
          id: 'new-thinking-model',
          name: 'New Thinking Model',
          contextWindow: 123456,
          reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
        },
        'catalog-thinking-model': {
          id: 'catalog-thinking-model',
          reasoning: true,
          thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
        },
        'default-thinking-model': {
          id: 'default-thinking-model',
          reasoning: true,
        },
      },
    }), 'utf8');
    const settingsPath = join(profile, 'settings.yaml');
    writeFileSync(settingsPath, [
      'llm-pi-ai:',
      '  providers:',
      '    custom-route:',
      '      displayName: Custom Route',
      '      models:',
      '        - id: custom-model',
      '          reasoningEfforts:',
      '            off:',
      '            xhigh: xhigh',
    ].join('\n'), 'utf8');
    const catalog = discoverRuntimeModelCatalog(profile, settingsPath);
    check('catalog: startup refresh reads newly installed provider models', modelCatalogKeys(catalog)
      .includes('opencode-go::new-thinking-model'));
    check('catalog: effort choices follow each model capability', modelEffortsOf(catalog, 'opencode-go', 'new-thinking-model')
      .join(',') === 'default,low,medium,high');
    check('catalog: custom provider effort levels are preserved', modelEffortsOf(catalog, 'custom-route', 'custom-model')
      .join(',') === 'default,off,xhigh');
    check('catalog: installed thinking map follows pi-ai null/missing semantics',
      modelEffortsOf(catalog, 'opencode-go', 'catalog-thinking-model').join(',') === 'default,off,high,max');
    check('catalog: reasoning models without a map expose pi-ai base levels',
      modelEffortsOf(catalog, 'opencode-go', 'default-thinking-model').join(',')
        === 'default,off,minimal,low,medium,high');
    check('catalog: installed context metadata is retained', catalog['opencode-go'].models[0].contextWindow === 123456);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}
{
  check('catalog: unsupported effort adapts to the strongest model-supported value',
    preferredEffort(['default', 'low', 'medium'], 'max') === 'medium');
  const module = hotModelRouteModule();
  check('hot model route: top-level agents receive mutable model selection', module.includes('installModelSelection(agent.ctx, ref)')
    && module.includes("agent.session.header.origin === 'subagent'")
    && !module.includes('agent.session.meta.origin')
    && module.includes('[dsh-agent-model-applied]'));
}

// --- excludeToolEntries (settings tool switches) ---
{
  const sample = '# 头\n- id: bash\n  name: x\n  config:\n    a: 1\n- id: tool-fs\n  name: y\n- id: acp-agent\n  name: z\n';
  const out = excludeToolEntries(sample, ['fs']);
  check('tools: disabling fs removes tool-fs keeps others', !out.includes('tool-fs') && out.includes('id: bash') && out.includes('id: acp-agent'), JSON.stringify(out));
}
{
  const sample = '- id: tool-todo\n  name: t\n- id: tool-workflow\n  name: w\n';
  const out = excludeToolEntries(sample, ['todo', 'workflow']);
  check('tools: disabling multiple removes both', !out.includes('tool-todo') && !out.includes('tool-workflow'), JSON.stringify(out));
}
{
  const sample = '- id: bash\n  name: b\n';
  const out = excludeToolEntries(sample, ['no-such-tool']);
  check('tools: unknown id untouched', out === sample, JSON.stringify(out));
}
{
  const out = excludeToolEntries('- id: bash\n', []);
  check('tools: empty disabled untouched', out === '- id: bash\n', JSON.stringify(out));
}

// --- feature registry ---
{
  const flags = resolveFeatureFlags(undefined);
  check('registry: defaults all enabled', FEATURE_REGISTRY.every((f) => flags[f.id] === true), String(FEATURE_REGISTRY.length));
}

// --- Agent presets: one choice applies the complete behavior bundle ---
check('preset: code-development preset removed', AGENT_PRESETS.map((preset) => preset.id).join(',')
  === 'research,notes,safe-readonly,deep-task', AGENT_PRESETS.map((preset) => preset.id).join(','));
{
  const settings = {
    ...DEFAULT_SETTINGS,
    hiddenProviders: [], hiddenModels: [], disabledTools: [], featureFlags: {},
  };
  applyAgentPreset(settings, 'safe-readonly');
  const flags = resolveFeatureFlags(settings.featureFlags);
  check('preset: safe-readonly is a real read-only sandbox', settings.agentPreset === 'safe-readonly'
    && settings.permissionMode === 'read-only' && settings.approvalPolicy === 'never');
  check('preset: safe-readonly removes execution/orchestration tools', flags['tool.bash'] === false
    && flags['tool.subagent'] === false && flags['tool.subagent-codex'] === false
    && flags['tool.subagent-claude-code'] === false
    && flags['tool.workflow'] === false && flags['tool.fs'] === true, JSON.stringify(flags));
  applyAgentPreset(settings, 'deep-task');
  check('preset: deep task maps to max without fake Ultra effort', settings.reasoningEffort === 'max'
    && AGENT_PRESETS.find((preset) => preset.id === 'deep-task')?.orchestration === 'workflow');
  check('preset: deep task enables every registered runtime tool', FEATURE_REGISTRY
    .filter((feature) => feature.kind === 'runtime')
    .every((feature) => resolveFeatureFlags(settings.featureFlags)[feature.id] === true));
  check('preset: persona carries orchestration policy', agentPresetPersona('deep-task').includes('subagent')
    && agentPresetPersona('deep-task').includes('workflow')
    && agentPresetPersona('deep-task').includes('subagent_codex')
    && agentPresetPersona('deep-task').includes('subagent_claude_code'));
}
{
  const flags = resolveFeatureFlags({ 'ui.typewriter': false });
  check('registry: stored flag overrides', flags['ui.typewriter'] === false && flags['ui.rewind'] === true, '');
}
{
  const ids = disabledCordisIds(resolveFeatureFlags({ 'tool.fs': false }));
  check('registry: disabled tool maps to cordis ids', ids.includes('tool-fs') && !ids.includes('bash'), JSON.stringify(ids));
  const generated = excludeToolEntries('- id: tool-fs\n  name: fs\n- id: bash\n  name: bash\n', ids);
  check('registry: resolved cordis ids remove runtime entries end-to-end', !generated.includes('tool-fs') && generated.includes('id: bash'), JSON.stringify(generated));
}
{
  const ids = disabledCordisIds(resolveFeatureFlags({ 'ui.typewriter': false }));
  check('registry: ui flag leaves cordis alone', ids.length === 0, JSON.stringify(ids));
}

// --- reasoning snapshot dedup ---
{
  const merged = mergeReasoningText('先读文件', '先读文件并检查公式');
  check('reasoning: cumulative snapshot replaces prefix', merged === '先读文件并检查公式', merged);
  const normalized = normalizeReasoningText('先读文件\n先读文件并检查公式\n先读文件并检查公式');
  check('reasoning: persisted cumulative duplicates collapse', normalized === '先读文件并检查公式', normalized);
  const positioned = new BlockBuilder();
  positioned.applyStepMessage('片段 A', undefined, { turn: 1, step: 1 });
  positioned.applyStepMessage('片段 A 增量', undefined, { turn: 1, step: 1 });
  check('reasoning: same turn/step keeps one block', positioned.list().length === 1
    && positioned.list()[0].kind === 'thinking'
    && positioned.list()[0].text === '片段 A 增量', JSON.stringify(positioned.list()));
}

// --- queue/reconnect, branch, recency, usage ---
{
  const source = createConversation('D:\\vault');
  source.title = '原会话';
  source.messages = [
    { id: 'u1', role: 'user', text: '问题一', time: 10 },
    { id: 'a1', role: 'assistant', text: '回答一', time: 20, changeSet: {
      startedAt: 1, completedAt: 2, truncated: false,
      files: [{ path: 'note.md', kind: 'modified', before: 'a', after: 'b', additions: 1, deletions: 1, reversible: true }],
    } },
    { id: 'u2', role: 'user', text: '后续问题', time: 30 },
  ];
  const branch = createConversationBranch(source, 'a1');
  check('branch: truncates through selected answer', branch.messages.length === 2 && branch.messages[1].text === '回答一', JSON.stringify(branch.messages));
  check('branch: regenerates ids and injects transcript', branch.messages[0].id !== 'u1'
    && (branch.rewindContext ?? '').includes('问题一')
    && (branch.rewindContext ?? '').includes('回答一'), branch.rewindContext ?? '');
  check('branch: does not duplicate source file-undo ownership', branch.messages.every((message) => message.changeSet === undefined));

  const regeneration = createConversation('D:\\vault');
  regeneration.messages = [
    { id: 'before', role: 'assistant', text: '更早回答', time: 1 },
    { id: 'question', role: 'user', text: '需要重新回答的问题', time: 2 },
    { id: 'answer', role: 'assistant', text: '待移除回答', time: 3 },
    { id: 'later', role: 'user', text: '后续内容', time: 4 },
  ];
  regeneration.pendingInput = [{ messageId: 'later', text: '后续内容', attachments: [], quotes: [] }];
  const rewind = rewindForAssistantRegeneration(regeneration, 'answer');
  check('regenerate: restores transcript to immediately after the original question', rewind?.userMessage.id === 'question'
    && regeneration.messages.map((message) => message.id).join(',') === 'before,question');
  check('regenerate: removes later queued turns so they cannot execute after replacement', regeneration.pendingInput?.length === 0);
  check('regenerate: stale repeated action cannot target the removed answer', rewindForAssistantRegeneration(regeneration, 'answer') === undefined);

  source.pendingInput = [{ text: '后续问题', attachments: [], quotes: [] }];
  check('queue: reconnect transcript excludes queued visible user turn', messagesBeforePending(source).length === 2);
  const queuedConversation = createConversation('D:\\vault');
  queuedConversation.messages = [
    { id: 'a0', role: 'assistant', text: '当前回复', time: 1 },
    { id: 'q1', role: 'user', text: '排队一', time: 2 },
    { id: 'q2', role: 'user', text: '排队二', time: 3 },
  ];
  appendAssistantAfterPrompt(queuedConversation, { id: 'a1', role: 'assistant', text: '回复一', time: 4 }, 'q1');
  check('queue: assistant is inserted before later queued users', queuedConversation.messages.map((message) => message.id).join(',') === 'a0,q1,a1,q2', JSON.stringify(queuedConversation.messages));
  check('queue: live renderer still finds assistant before queued user', latestAssistantMessageIndex(queuedConversation) === 2);

  const older = createConversation('D:\\vault');
  older.createdAt = 1;
  older.messages = [{ id: 'o', role: 'user', text: 'old', time: 100 }];
  const newer = createConversation('D:\\vault');
  newer.createdAt = 2;
  newer.messages = [{ id: 'n', role: 'user', text: 'new', time: 200 }];
  const sorted = [older, newer].sort(compareConversationsByRecent);
  check('history: newest activity sorts first', sorted[0] === newer);
  older.pinned = true;
  const pinned = [newer, older].sort(compareConversationsByRecent);
  check('history: pin remains above recency groups', pinned[0] === older);

  const usage1 = mergeUsageSnapshot(undefined, { inputTokens: 14000, cacheReadTokens: 2000 }, 1);
  const usage2 = mergeUsageSnapshot(usage1, { outputTokens: 800 }, 2);
  check('usage: partial chunks do not reset context fields', usage2.inputTokens === 14000
    && usage2.cacheReadTokens === 2000 && usage2.outputTokens === 800, JSON.stringify(usage2));
}

// --- context aliases and provider-scoped effort ---
{
  check('context: deepseek-official resolves generated deepseek catalog', contextWindowOf('deepseek-official', 'deepseek-v4-flash') === 1000000);
  check('catalog: built-in local Qwen route is selectable', MODEL_CATALOG[LOCAL_PROVIDER_ID]?.models
    .some((entry) => entry.id === LOCAL_PROVIDER_MODEL_ID) === true);
  check('context: local Qwen uses the live llama.cpp window', contextWindowOf(LOCAL_PROVIDER_ID, LOCAL_PROVIDER_MODEL_ID)
    === LOCAL_PROVIDER_CONTEXT_WINDOW);
  const seeded = settingsSeedTemplate({
    llmPiAiProviders: '  providers:\n    opencode-go:\n      reasoning: low\n    another:\n      reasoning: high',
    agentDefaultModel: '',
  }, { provider: 'opencode-go', effort: 'max' });
  check('settings: effort update stays inside selected provider', seeded.includes('opencode-go:\n      reasoning: max')
    && seeded.includes('another:\n      reasoning: high'), seeded);
  check('settings: local provider is merged without dropping imported routes', seeded.includes(LOCAL_PROVIDER_ID + ':')
    && seeded.includes('baseURL: ' + LOCAL_PROVIDER_BASE_URL)
    && seeded.includes('model: deepseek-v4-flash'), seeded);
  const localSeeded = settingsSeedTemplate({ llmPiAiProviders: '', agentDefaultModel: '' }, {
    provider: LOCAL_PROVIDER_ID,
    effort: 'high',
  });
  check('settings: local route carries compatible streaming/thinking configuration', localSeeded.includes(LOCAL_PROVIDER_ID + ':\n      reasoning: high')
    && localSeeded.includes('thinkingFormat: qwen-chat-template')
    && localSeeded.includes('maxTokensField: max_tokens')
    && localSeeded.includes('contextWindow: 65536'), localSeeded);
  const existingLocalSeeded = settingsSeedTemplate({
    llmPiAiProviders: '  providers:\n    ' + LOCAL_PROVIDER_ID + ':\n      displayName: existing',
    agentDefaultModel: '',
  });
  check('settings: local route is never duplicated', existingLocalSeeded.split(LOCAL_PROVIDER_ID + ':').length === 2,
    existingLocalSeeded);
  const hotSeeded = settingsSeedTemplate({ llmPiAiProviders: '', agentDefaultModel: '' }, undefined, {
    provider: 'custom-route',
    model: 'custom-model',
    reasoningEffort: 'medium',
    revision: 'revision-42',
  });
  check('settings: hot model selection carries provider/model/effort/revision', hotSeeded.includes("provider: 'custom-route'")
    && hotSeeded.includes("model: 'custom-model'")
    && hotSeeded.includes("reasoningEffort: 'medium'")
    && hotSeeded.includes("revision: 'revision-42'"), hotSeeded);
}

// --- P0 queue controls + context governance ---
{
  const conversation = createConversation('D:\\vault');
  conversation.messages = [
    { id: 'q1', role: 'user', text: '一', time: 1 },
    { id: 'q2', role: 'user', text: '二', time: 2 },
    { id: 'q3', role: 'user', text: '三', time: 3 },
  ];
  conversation.pendingInput = [
    { messageId: 'q1', text: '一', attachments: [], quotes: [] },
    { messageId: 'q2', text: '二', attachments: [], quotes: [] },
    { messageId: 'q3', text: '三', attachments: [], quotes: [] },
  ];
  check('queue: pending prompt moves up by message id', movePendingPrompt(conversation, 'q3', -1)
    && conversation.pendingInput.map((prompt) => prompt.messageId).join(',') === 'q1,q3,q2');
  check('queue: visible user messages follow queue order', conversation.messages.map((message) => message.id).join(',') === 'q1,q3,q2');
  check('queue: cancel removes queue item and visible message', cancelPendingPrompt(conversation, 'q3')
    && conversation.pendingInput.map((prompt) => prompt.messageId).join(',') === 'q1,q2'
    && conversation.messages.map((message) => message.id).join(',') === 'q1,q2');
}
{
  const messages: ChatMessage[] = Array.from({ length: 35 }, (_, index) => ({
    id: String(index), role: index % 2 === 0 ? 'user' : 'assistant', text: index === 34 ? 'x'.repeat(2100) : '消息 ' + index, time: index,
  }));
  const transfer = contextTransferOfMessages(messages);
  check('context: fresh-session transfer reports omitted messages', transfer.includedMessages === 30 && transfer.omittedMessages === 5, JSON.stringify(transfer));
  check('context: fresh-session transfer reports truncated messages', transfer.truncatedMessages === 1 && transfer.preview !== '', JSON.stringify(transfer));
  const conversation = createConversation('D:\\vault');
  conversation.lastUsage = { inputTokens: 80, outputTokens: 1, cacheReadTokens: 0, time: 42 };
  check('context: threshold triggers once per usage event', shouldAutoCompact(conversation, 100, 80));
  conversation.lastAutoCompactUsageTime = 42;
  check('context: same usage event does not trigger twice', !shouldAutoCompact(conversation, 100, 80));
  conversation.lastAutoCompactUsageTime = undefined;
  conversation.contextMaintenance = { kind: 'auto-compaction', percent: 80, time: 100 };
  check('context: auto compaction has a repeat cooldown', !shouldAutoCompact(conversation, 100, 80, 200));
  const bounded = createConversation('D:\\vault');
  for (let index = 0; index < 405; index++) appendMessage(bounded, { id: String(index), role: 'user', text: 'x', time: index });
  check('context: local transcript eviction is counted explicitly', bounded.messages.length === 400 && bounded.droppedMessageCount === 5);
  const changeHistory = createConversation('D:\\vault');
  changeHistory.messages = Array.from({ length: 3 }, (_, index) => ({
    id: 'c' + index, role: 'assistant' as const, text: '', time: index,
    changeSet: { startedAt: 1, completedAt: 2, truncated: false, files: [{
      path: index + '.md', kind: 'modified' as const, before: 'a', after: 'b', additions: 1, deletions: 1, reversible: true,
    }] },
  }));
  pruneChangeSetSnapshots(changeHistory, 2);
  check('changes: old undo payloads are pruned but summaries remain', changeHistory.messages[0].changeSet?.files[0].before === undefined
    && changeHistory.messages[0].changeSet?.files[0].reversible === false
    && changeHistory.messages[1].changeSet?.files[0].before === 'a');
}

// --- P0 redaction + file change center/undo ---
{
  const redactedJson = redactSensitiveText(JSON.stringify({ token: 'abc123456', nested: { api_key: 'sk-1234567890123456' }, safe: 'ok' }));
  check('privacy: structured secrets are redacted', redactedJson.includes('[REDACTED]') && !redactedJson.includes('abc123456') && redactedJson.includes('"safe":"ok"'), redactedJson);
  const redactedText = redactSensitiveText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
  check('privacy: bearer tokens are redacted in plain text', !redactedText.includes('abcdefghijklmnopqrstuvwxyz'), redactedText);
  check('storage: byte formatter uses readable units', formatBytes(1536) === '1.5 KB', formatBytes(1536));
}
{
  const hugeResult = 'result-line\n'.repeat(20_000);
  const hugeArguments = JSON.stringify({ path: 'paper.md', content: 'x'.repeat(50_000) });
  const activity = {
    callId: 'read-paper',
    name: 'read',
    argumentsJson: hugeArguments,
    status: 'done' as const,
    resultText: hugeResult,
    meta: {
      path: 'paper.md',
      offset: 1,
      lines: Array.from({ length: 5_000 }, (_, index) => ({ line: index + 1, text: 'paper '.repeat(20) })),
    },
    startTime: 1,
    endTime: 2,
  };
  const conversation: Conversation = {
    id: 'large-review',
    title: '审稿',
    workspace: 'vault',
    status: 'idle',
    createdAt: 1,
    messages: [{
      id: 'assistant-review',
      role: 'assistant',
      text: '完整审稿意见必须保留',
      time: 2,
      toolActivities: [activity],
      reasoning: 'think\n'.repeat(20_000),
      blocks: [
        { kind: 'thinking', text: 'think\n'.repeat(20_000) },
        { kind: 'tool', activity },
        { kind: 'text', text: '完整审稿意见必须保留' },
      ],
    }],
  };
  const originalBytes = JSON.stringify(conversation).length;
  const compact = compactConversationForStorage(conversation);
  const storedMessage = compact.messages[0];
  const storedTool = storedMessage.blocks?.find(
    (block): block is Extract<NonNullable<ChatMessage['blocks']>[number], { kind: 'tool' }> => block.kind === 'tool',
  );
  const storedThinking = storedMessage.blocks?.find((block) => block.kind === 'thinking');
  const storedMeta = storedTool?.activity.meta as { path?: string; lines?: unknown } | undefined;
  check('storage: derived tool collection is omitted from snapshot', storedMessage.toolActivities === undefined);
  check('storage: full assistant answer remains intact', storedMessage.text === '完整审稿意见必须保留'
    && storedMessage.blocks?.some((block) => block.kind === 'text' && block.text === storedMessage.text) === true);
  check('storage: tool payloads and thinking are bounded', (storedTool?.activity.resultText.length ?? Infinity) <= STORED_TOOL_RESULT_LIMIT
    && (storedTool?.activity.argumentsJson.length ?? Infinity) <= STORED_TOOL_ARGUMENT_LIMIT
    && (storedThinking?.kind === 'thinking' ? storedThinking.text.length : Infinity) <= STORED_THINKING_LIMIT);
  check('storage: read metadata keeps location but drops duplicate line bodies', storedMeta?.path === 'paper.md'
    && storedMeta.lines === 5_000, JSON.stringify(storedMeta));
  check('storage: long review snapshot shrinks substantially', JSON.stringify(compact).length < originalBytes / 5,
    JSON.stringify({ originalBytes, compactBytes: JSON.stringify(compact).length }));
  rehydrateConversationForRuntime(compact);
  const hydrated = compact.messages[0];
  const hydratedTool = hydrated.blocks?.find((block) => block.kind === 'tool');
  check('storage: runtime collection reuses canonical block activity', hydratedTool?.kind === 'tool'
    && hydrated.toolActivities?.[0] === hydratedTool.activity);
}
{
  const pluginDir = mkdtempSync(join(tmpdir(), 'dsh-data-test-'));
  try {
    writeFileSync(join(pluginDir, 'data.json'), '{"schemaVersion":0}', 'utf8');
    const backup = backupDataBeforeMigration(pluginDir, 0);
    check('storage: migration creates a readable backup', backup !== undefined && existsSync(backup)
      && readFileSync(backup, 'utf8').includes('schemaVersion'));
    const sessionPath = join(pluginDir, '.sessions', 'project', 'session', 'session.jsonl');
    mkdirSync(join(pluginDir, '.sessions', 'project', 'session'), { recursive: true });
    writeFileSync(sessionPath, '{"old":true}\n', 'utf8');
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(sessionPath, old, old);
    const stats = collectStorageStats(pluginDir);
    check('storage: usage separates data, sessions and backups', stats.dataBytes > 0 && stats.sessionBytes > 0 && stats.backupBytes > 0, JSON.stringify(stats));
    const cleaned = cleanupSessionLogs(join(pluginDir, '.sessions'), 7);
    check('storage: retention removes only expired raw logs', cleaned.removed === 1 && !existsSync(sessionPath), JSON.stringify(cleaned));
    const archivedLog = join(pluginDir, '.sessions', 'project', 'restored-session', 'session.jsonl');
    mkdirSync(join(pluginDir, '.sessions', 'project', 'restored-session'), { recursive: true });
    writeFileSync(archivedLog, 'recoverable\n', 'utf8');
    utimesSync(archivedLog, old, old);
    check('storage: conversation deletion moves log to recycle area', archiveSessionLogs([archivedLog], join(pluginDir, '.sessions')) === 1
      && !existsSync(archivedLog));
    const freshCleanup = cleanupSessionLogs(join(pluginDir, '.sessions'), 7);
    check('storage: freshly archived old log survives one retention window', freshCleanup.removed === 0, JSON.stringify(freshCleanup));
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
}
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-change-test-'));
  const trash = join(root, '.plugin-trash');
  try {
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'existing.md'), 'old\n', 'utf8');
    const before = snapshotWorkspace(root);
    writeFileSync(join(root, 'notes', 'existing.md'), 'new\nline\n', 'utf8');
    writeFileSync(join(root, 'notes', 'created.md'), 'created\n', 'utf8');
    const after = snapshotWorkspace(root);
    const changes = compareWorkspaceSnapshots(before, after, 1, 2);
    check('changes: detects modified and created files', changes.files.length === 2
      && changes.files.some((file) => file.kind === 'modified')
      && changes.files.some((file) => file.kind === 'created'), JSON.stringify(changes.files));
    const candidates = new Set([...before.keys(), ...after.keys()]);
    const attributed = attributedWorkspacePaths(root, [{
      callId: 'edit-1',
      name: 'edit',
      argumentsJson: JSON.stringify({ file_path: 'notes/existing.md' }),
      status: 'done',
      resultText: '',
      startTime: 1,
      endTime: 2,
    }], candidates);
    const ownedChanges = compareWorkspaceSnapshots(before, after, 1, 2, attributed);
    check('changes: excludes concurrent edits not named by this turn mutating tools', ownedChanges.files.length === 1
      && ownedChanges.files[0].path === 'notes/existing.md', JSON.stringify(ownedChanges.files));
    const modified = changes.files.find((file) => file.path.endsWith('existing.md'));
    check('changes: diff preview contains before/after lines', modified !== undefined
      && previewLineDiff(modified).includes('- old') && previewLineDiff(modified).includes('+ new'));
    const result = revertFileChanges(root, changes, trash);
    check('changes: undo restores modified file', result.reverted.length === 2
      && readFileSync(join(root, 'notes', 'existing.md'), 'utf8') === 'old\n');
    check('changes: undo moves created file to recoverable trash', !snapshotWorkspace(root).has('notes/created.md'));
    const conflictBefore = snapshotWorkspace(root);
    writeFileSync(join(root, 'notes', 'existing.md'), 'assistant edit\n', 'utf8');
    const conflictSet = compareWorkspaceSnapshots(conflictBefore, snapshotWorkspace(root), 3, 4);
    writeFileSync(join(root, 'notes', 'existing.md'), 'user edit after assistant\n', 'utf8');
    const conflictResult = revertFileChanges(root, conflictSet, trash);
    check('changes: undo never overwrites a later user edit', conflictResult.conflicts.includes('notes/existing.md')
      && readFileSync(join(root, 'notes', 'existing.md'), 'utf8') === 'user edit after assistant\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(failures + ' assertion(s) failed');
  process.exit(1);
}
console.log('ui-logic: all assertions passed');
