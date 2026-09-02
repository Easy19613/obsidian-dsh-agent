import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.OBSIDIAN_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const artifactDir = path.resolve('artifacts', 'obsidian-live-acceptance');

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression, timeoutMs = 30_000) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'unknown evaluation error';
    throw new Error(detail);
  }
  return result.result?.value;
}

async function screenshot(client, name) {
  const result = await client.send('Page.captureScreenshot', { format: 'png' });
  const filePath = path.join(artifactDir, name);
  await writeFile(filePath, Buffer.from(result.data, 'base64'));
  return filePath;
}

function check(name, pass, detail) {
  return { name, pass: Boolean(pass), detail };
}

await mkdir(artifactDir, { recursive: true });
const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
const target = targets.find((entry) => entry.type === 'page' && entry.url.startsWith('app://obsidian.md'));
if (target === undefined) throw new Error('Obsidian page target was not found');

const client = new CdpClient(target.webSocketDebuggerUrl);
await client.open();
await client.send('Runtime.enable');
await client.send('Log.enable');
await client.send('Page.enable');

const checks = [];
const artifacts = [];
let temporaryConversationId = null;
let temporaryBranchId = null;
let originalActiveId = null;
let originalEffort = null;

try {
  const initial = await evaluate(client, `(async () => {
    const plugin = app.plugins.getPlugin('dsh-agent');
    if (plugin === undefined) throw new Error('dsh-agent plugin instance is missing');
    await plugin.activateView();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const active = plugin.getActiveConversation();
    return {
      enabled: app.plugins.enabledPlugins.has('dsh-agent'),
      loaded: true,
      version: plugin.manifest.version,
      backend: plugin.getBackendSnapshot(),
      activeId: active?.id ?? null,
      config: plugin.getCurrentConfig(),
      dataVersion: plugin.currentData().schemaVersion,
      storage: plugin.getStorageStats(),
      contextPolicy: plugin.getContextPolicy(),
      deletedCount: plugin.getDeletedConversationCount(),
      vault: app.vault.adapter.getBasePath(),
    };
  })()`);
  originalActiveId = initial.activeId;
  originalEffort = initial.config.reasoningEffort;
  checks.push(check('插件已启用并加载', initial.enabled && initial.loaded, initial));
  checks.push(check('P0 数据版本与存储统计可用', initial.version === '0.2.0'
    && initial.dataVersion >= 2
    && initial.storage.totalBytes >= initial.storage.dataBytes, initial));
  checks.push(check('后端已进入运行态', initial.backend.state === 'running', initial.backend));

  const ui = await evaluate(client, `(() => {
    const view = document.querySelector('.dsh-agent-view');
    const ring = view?.querySelector('.dsh-agent-context-ring');
    const meter = view?.querySelector('.dsh-agent-context-meter');
    const popover = view?.querySelector('.dsh-agent-context-popover');
    const style = ring === null || ring === undefined ? null : getComputedStyle(ring);
    const rect = meter?.getBoundingClientRect();
    return {
      viewVisible: view !== null && view.getBoundingClientRect().width > 0,
      ringExists: ring !== null && ring !== undefined,
      ringWidth: style?.width ?? null,
      ringHeight: style?.height ?? null,
      ringAngle: ring?.style.getPropertyValue('--dsh-ctx-angle') ?? null,
      obsoleteRightTextCount: view?.querySelectorAll('.dsh-agent-context-text').length ?? -1,
      // textContent remains available while CSS keeps the hover popover hidden.
      popoverLabels: popover?.textContent ?? '',
      compactButtonExists: popover?.querySelector('.dsh-agent-context-compact') !== null,
      meterRect: rect === undefined ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      statusText: view?.querySelector('.dsh-agent-status')?.innerText ?? '',
    };
  })()`);
  checks.push(check('DSH 视图可见', ui.viewVisible, ui));
  checks.push(check('上下文圆环尺寸与角度变量有效', ui.ringExists && ui.ringWidth === '22px' && ui.ringHeight === '22px' && ui.ringAngle.endsWith('deg'), ui));
  checks.push(check('圆环右侧旧文本已移除', ui.obsoleteRightTextCount === 0, ui.obsoleteRightTextCount));
  checks.push(check('上下文详情浮层内容完整', ['输入', '缓存读取', '输出', '窗口'].every((label) => ui.popoverLabels.includes(label)), ui.popoverLabels));
  checks.push(check('P0 上下文治理入口可见', ui.compactButtonExists && ui.popoverLabels.includes('自动压缩'), ui));

  if (ui.meterRect !== null) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: ui.meterRect.x + ui.meterRect.width / 2,
      y: ui.meterRect.y + ui.meterRect.height / 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  artifacts.push(await screenshot(client, '01-context-popover.png'));

  const history = await evaluate(client, `(async () => {
    const button = document.querySelector('.dsh-agent-header button[aria-label="历史对话"]');
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const panel = document.querySelector('.dsh-agent-history-panel');
    const plugin = app.plugins.getPlugin('dsh-agent');
    const expected = plugin.getConversations().slice().sort((a, b) => {
      if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1;
      const activity = (conversation) => Math.max(
        conversation.createdAt ?? 0,
        ...conversation.messages.map((message) => message.time ?? 0),
      );
      return activity(b) - activity(a);
    }).map((conversation) => conversation.title);
    const actual = [...(panel?.querySelectorAll('.dsh-agent-history-title') ?? [])]
      .map((element) => element.textContent ?? '');
    return {
      visible: panel !== null,
      warningStateCount: panel?.querySelectorAll('.dsh-agent-history-state').length ?? -1,
      expected,
      actual,
    };
  })()`);
  checks.push(check('历史面板可打开且无警告图标', history.visible && history.warningStateCount === 0, history));
  checks.push(check('历史记录按置顶和最后活动时间排序', JSON.stringify(history.expected) === JSON.stringify(history.actual), history));
  artifacts.push(await screenshot(client, '02-history-panel.png'));
  await evaluate(client, `document.querySelector('.dsh-agent-history-header .dsh-agent-quote-close')?.click()`);

  const effort = await evaluate(client, `(async () => {
    const plugin = app.plugins.getPlugin('dsh-agent');
    const original = plugin.getCurrentConfig().reasoningEffort;
    const target = original === 'max' ? 'high' : 'max';
    const chip = [...document.querySelectorAll('.dsh-agent-chip')]
      .find((element) => element.textContent?.includes('Effort:'));
    const started = performance.now();
    chip?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const option = document.querySelector('.dsh-agent-hover-item[data-option-id="' + target + '"]');
    option?.click();
    const deadline = performance.now() + 4_000;
    let visible = false;
    while (performance.now() < deadline) {
      const currentChip = [...document.querySelectorAll('.dsh-agent-chip')]
        .find((element) => element.textContent?.includes('Effort:'));
      visible = currentChip?.textContent?.includes('Effort: ' + target) === true;
      if (visible) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const refreshMs = performance.now() - started;
    const switched = plugin.getCurrentConfig().reasoningEffort === target;
    await plugin.selectEffort(original);
    const restoreDeadline = Date.now() + 20_000;
    while (plugin.getBackendSnapshot().state !== 'running' && Date.now() < restoreDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return {
      original,
      target,
      switched,
      visible,
      refreshMs,
      restored: plugin.getCurrentConfig().reasoningEffort === original,
      backend: plugin.getBackendSnapshot(),
    };
  })()`, 60_000);
  checks.push(check('Effort 切换立即刷新并成功恢复', effort.switched && effort.visible && effort.restored && effort.backend.state === 'running', effort));

  const conversation = await evaluate(client, `(async () => {
    const plugin = app.plugins.getPlugin('dsh-agent');
    const previousActiveId = plugin.getActiveConversation()?.id ?? null;
    const conversation = plugin.createConversation();
    conversation.attachments = [];
    await plugin.sendMessage(conversation, '部署验收：请只回复 DSH_ACCEPT_OK，不要调用工具。');
    const assistant = [...conversation.messages].reverse().find((message) => message.role === 'assistant');
    const committedText = (assistant?.blocks ?? [])
      .filter((block) => block.kind === 'text')
      .map((block) => block.text)
      .join('\\n');
    const text = committedText.trim() !== '' ? committedText : (assistant?.text ?? '');
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      previousActiveId,
      id: conversation.id,
      status: conversation.status,
      assistantId: assistant?.id ?? null,
      assistantText: text,
      assistantError: assistant?.error ?? null,
      assistantHasUnexpectedChanges: (assistant?.changeSet?.files.length ?? 0) > 0,
      usage: conversation.lastUsage ?? null,
      messageCount: conversation.messages.length,
    };
  })()`, 180_000);
  temporaryConversationId = conversation.id;
  checks.push(check('真实 ACP 对话完成且回复可见', conversation.status === 'idle' && conversation.assistantError === null && conversation.assistantText.includes('DSH_ACCEPT_OK'), conversation));
  checks.push(check('只读验收请求未产生文件改动', conversation.assistantHasUnexpectedChanges === false, conversation));
  checks.push(check('真实对话返回上下文用量', conversation.usage !== null, conversation.usage));
  artifacts.push(await screenshot(client, '03-real-conversation.png'));

  if (conversation.assistantId !== null) {
    const branch = await evaluate(client, `(() => {
      const plugin = app.plugins.getPlugin('dsh-agent');
      const source = plugin.getConversations().find((entry) => entry.id === ${JSON.stringify(conversation.id)});
      const branch = plugin.branchConversation(source, ${JSON.stringify(conversation.assistantId)});
      return {
        id: branch.id,
        sourceId: source.id,
        branchedFrom: branch.branchedFrom,
        messageCount: branch.messages.length,
        rewindContext: branch.rewindContext ?? '',
        uniqueIds: new Set(branch.messages.map((message) => message.id)).size === branch.messages.length,
        noSourceMessageIds: branch.messages.every((message) => !source.messages.some((sourceMessage) => sourceMessage.id === message.id)),
      };
    })()`);
    temporaryBranchId = branch.id;
    checks.push(check('分支复制到选定回答并建立独立上下文', branch.branchedFrom === conversation.id
      && branch.messageCount === conversation.messageCount
      && branch.rewindContext.includes('DSH_ACCEPT_OK')
      && branch.uniqueIds
      && branch.noSourceMessageIds, branch));
  }
} finally {
  if (temporaryBranchId !== null || temporaryConversationId !== null || originalActiveId !== null || originalEffort !== null) {
    await evaluate(client, `(async () => {
      const plugin = app.plugins.getPlugin('dsh-agent');
      const currentEffort = plugin.getCurrentConfig().reasoningEffort;
      if (${JSON.stringify(originalEffort)} !== null && currentEffort !== ${JSON.stringify(originalEffort)}) {
        await plugin.selectEffort(${JSON.stringify(originalEffort)});
      }
      const branchId = ${JSON.stringify(temporaryBranchId)};
      const conversationId = ${JSON.stringify(temporaryConversationId)};
      if (branchId !== null && plugin.getConversations().some((entry) => entry.id === branchId)) plugin.removeConversation(branchId);
      if (conversationId !== null && plugin.getConversations().some((entry) => entry.id === conversationId)) plugin.removeConversation(conversationId);
      // removeConversation intentionally moves user data to the P0 recycle bin;
      // acceptance-owned conversations are purged explicitly so the test is idempotent.
      plugin.data.deletedConversations = plugin.data.deletedConversations.filter((entry) => entry.id !== branchId && entry.id !== conversationId);
      await plugin.saveSettings();
      const activeId = ${JSON.stringify(originalActiveId)};
      if (activeId !== null && plugin.getConversations().some((entry) => entry.id === activeId)) plugin.activateConversation(activeId);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return true;
    })()`, 60_000).catch(() => undefined);
  }
  const relevantErrors = client.events.filter((event) => {
    if (event.method === 'Runtime.exceptionThrown') return true;
    if (event.method === 'Log.entryAdded') return event.params?.entry?.level === 'error';
    return event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error';
  });
  checks.push(check('验收期间无未捕获异常或控制台错误', relevantErrors.length === 0, relevantErrors));
  const report = {
    generatedAt: new Date().toISOString(),
    endpoint,
    target: { id: target.id, title: target.title, url: target.url },
    passed: checks.every((entry) => entry.pass),
    checks,
    artifacts,
  };
  await writeFile(path.join(artifactDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  client.close();
}

if (checks.some((entry) => !entry.pass)) process.exitCode = 1;
