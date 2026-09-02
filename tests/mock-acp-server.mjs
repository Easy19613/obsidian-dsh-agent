// Mock ACP server for integration tests (plain Node, no deps).
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const pendingPrompts = new Set();
let permissionAnswered = null;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.method) {
    switch (msg.method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id: msg.id, result: {
          protocolVersion: 1,
          agentInfo: { name: 'mock-acp', version: '0.0.0' },
          agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
          authMethods: [],
        } });
        break;
      case 'session/new':
        send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'mock-session-1' } });
        break;
      case 'session/prompt': {
        pendingPrompts.add(msg.id);
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } } } });
        if (!permissionAskedOnce) {
          permissionAskedOnce = true;
          send({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: {
            sessionId: msg.params.sessionId,
            toolCall: { toolCallId: 'call-1' },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          } });
          const timer = setInterval(() => {
            if (permissionAnswered) {
              clearInterval(timer);
              if (pendingPrompts.has(msg.id)) {
                pendingPrompts.delete(msg.id);
                send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
              }
            }
          }, 10);
        } else {
          // second prompt: never settle (test will cancel it)
        }
        break;
      }
      default:
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
    }
  } else if (msg.id !== undefined && msg.id === 'p1' && msg.result) {
    permissionAnswered = msg.result;
  } else if (msg.id !== undefined && msg.id === 'u1' && msg.error) {
    // the plugin answered our unsupported server request with an error — confirm via chunk
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mock-session-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'unsupported-answered' } } } });
  } else if (msg.method === 'session/cancel') {
    for (const id of [...pendingPrompts]) {
      pendingPrompts.delete(id);
      send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
    }
  }
});

let permissionAskedOnce = false;
setTimeout(() => {
  send({ jsonrpc: '2.0', id: 'u1', method: 'terminal/create', params: {} });
}, 1500);
