import { readFile } from 'node:fs/promises';

const filePath = process.argv[2];
if (!filePath) throw new Error('Usage: node scripts/analyze-plugin-data.mjs <data.json>');

const raw = await readFile(filePath, 'utf8');
const data = JSON.parse(raw);
const conversations = Array.isArray(data.conversations) ? data.conversations : [];

function textLength(value) {
  return typeof value === 'string' ? value.length : 0;
}

function summarizeMessage(message) {
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  let blockText = 0;
  let toolResult = 0;
  let toolArguments = 0;
  let undoPayload = 0;
  for (const block of blocks) {
    blockText += textLength(block.text);
    if (block.kind === 'tool') {
      toolResult += textLength(block.activity?.resultText);
      toolArguments += textLength(block.activity?.argumentsJson);
    }
  }
  for (const file of message.changeSet?.files ?? []) {
    undoPayload += textLength(file.before) + textLength(file.after);
  }
  return {
    jsonBytes: Buffer.byteLength(JSON.stringify(message)),
    text: textLength(message.text),
    reasoning: textLength(message.reasoning) + textLength(message.liveReasoning),
    streamedText: textLength(message.streamedText),
    blockText,
    toolResult,
    toolArguments,
    undoPayload,
    blockCount: blocks.length,
  };
}

const rows = conversations.map((conversation) => {
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const summaries = messages.map(summarizeMessage);
  const total = (key) => summaries.reduce((sum, entry) => sum + entry[key], 0);
  const largestMessage = summaries.reduce((largest, entry, index) => (
    entry.jsonBytes > largest.jsonBytes ? { index, ...entry } : largest
  ), { index: -1, jsonBytes: 0 });
  return {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    model: conversation.model,
    createdAt: conversation.createdAt,
    workspace: conversation.workspace,
    messageCount: messages.length,
    jsonBytes: Buffer.byteLength(JSON.stringify(conversation)),
    toolResultChars: total('toolResult'),
    blockTextChars: total('blockText'),
    undoPayloadChars: total('undoPayload'),
    largestMessage,
  };
}).sort((a, b) => b.jsonBytes - a.jsonBytes);

const activeConversation = conversations.find((entry) => entry.id === data.activeConversationId);
const activeMessages = (activeConversation?.messages ?? []).map((message, index) => ({
  index,
  id: message.id,
  role: message.role,
  time: message.time,
  ...summarizeMessage(message),
}));

function largestStrings(value, path = '$', rows = []) {
  if (typeof value === 'string') {
    rows.push({ path, chars: value.length });
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => largestStrings(entry, `${path}[${index}]`, rows));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) largestStrings(entry, `${path}.${key}`, rows);
  }
  return rows;
}

const activeLargestMessage = activeConversation?.messages?.reduce((largest, message) => (
  Buffer.byteLength(JSON.stringify(message)) > Buffer.byteLength(JSON.stringify(largest ?? {})) ? message : largest
), null);
const activeBlockDetails = (activeLargestMessage?.blocks ?? []).map((block, index) => ({
  index,
  kind: block.kind,
  name: block.activity?.name,
  status: block.activity?.status,
  jsonBytes: Buffer.byteLength(JSON.stringify(block)),
}));

console.log(JSON.stringify({
  fileBytes: Buffer.byteLength(raw),
  activeConversationId: data.activeConversationId,
  conversationCount: conversations.length,
  activeConversation: rows.find((entry) => entry.id === data.activeConversationId) ?? null,
  activeSessionId: activeConversation?.acpSessionId ?? null,
  activeError: activeLargestMessage?.error ?? null,
  activeMessages,
  activeBlockDetails,
  activeLargestStrings: largestStrings(activeLargestMessage).sort((a, b) => b.chars - a.chars).slice(0, 20),
  topConversations: rows.slice(0, 12),
}, null, 2));
