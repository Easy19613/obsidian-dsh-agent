// Integration tests for the plugin's bundled ACP client code
// (src/acp/transport.ts + src/acp/connection.ts), driven from Node:
//   scenario A — mock ACP server choreography (no API cost)
//   scenario B — the real dsh-acp-demo backend (real opencode-go round trip)
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NdjsonTransport } from '../src/acp/transport';
import { AcpClientConnection } from '../src/acp/connection';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log('PASS ' + label + (detail !== '' ? ' — ' + detail : ''));
  } else {
    failures += 1;
    console.log('FAIL ' + label + (detail !== '' ? ' — ' + detail : ''));
  }
}

function spawnChild(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
}

async function scenarioA(): Promise<void> {
  console.log('--- scenario A: mock ACP server ---');
  const child = spawnChild(process.execPath, [join(process.cwd(), 'tests', 'mock-acp-server.mjs')]);
  let fatal: Error | null = null;
  const transport = new NdjsonTransport(child, (error) => { fatal = error; });
  const connection = new AcpClientConnection({
    clientInfo: { name: 'test', version: '0' },
    transport,
  });

  const init = await connection.initialize();
  check('initialize protocolVersion 1', init.protocolVersion === 1);
  check('initialize advertises baseline capabilities', init.agentCapabilities.promptCapabilities.image === false);

  const session = await connection.newSession('C:\\temp');
  check('session/new returns sessionId', session.sessionId === 'mock-session-1');

  const chunks: string[] = [];
  connection.onMessageChunk((sid, text) => chunks.push(sid + '|' + text));

  let permissionParams: unknown = null;
  connection.onPermissionRequest((_request, params) => {
    permissionParams = params;
    return Promise.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  const result = await connection.prompt('mock-session-1', [{ type: 'text', text: 'hi' }], 10_000);
  check('prompt settles end_turn', result.stopReason === 'end_turn', result.stopReason);
  check('chunk forwarded to listener', chunks.includes('mock-session-1|你好'), JSON.stringify(chunks));
  check('permission request reached handler', permissionParams !== null);
  check('permission handler received options', (permissionParams as any)?.options?.length === 2);

  // second prompt, then cancel via notification path
  const pendingPrompt = connection.prompt('mock-session-1', [{ type: 'text', text: 'long task' }], 10_000);
  await new Promise((r) => setTimeout(r, 200));
  connection.cancel('mock-session-1');
  const cancelled = await pendingPrompt;
  check('cancel notification settles prompt cancelled', cancelled.stopReason === 'cancelled');

  // wait for the unsupported server request choreography to complete
  for (let i = 0; i < 30 && !chunks.includes('mock-session-1|unsupported-answered'); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  check('unknown server request answered with error (confirmed via follow-up chunk)', chunks.includes('mock-session-1|unsupported-answered'));

  check('no fatal protocol error', fatal === null);
  transport.dispose();
  connection.dispose();
  child.kill();

  console.log('--- scenario A-2: bad stdout line -> fatal ---');
  const bad = spawnChild(process.execPath, ['-e', 'setTimeout(() => { process.stdout.write("this is not json\\n"); }, 100)']);
  let fatal2: Error | null = null;
  const transport2 = new NdjsonTransport(bad, (error) => { fatal2 = error; });
  await new Promise((r) => setTimeout(r, 400));
  check('bad line triggers fatal callback', fatal2 !== null, String(fatal2?.message));
  transport2.dispose();
  bad.kill();
}

async function scenarioB(): Promise<void> {
  const localProvider = process.env.DSH_RUN_LOCAL_INTEGRATION === '1';
  console.log('--- scenario B: real dsh-acp-demo backend (' + (localProvider ? 'local-qwen' : 'opencode-go') + ') ---');
  const smokeOnly = process.env.DSH_RUN_RUNTIME_SMOKE === '1';
  if (process.env.DSH_RUN_REAL_INTEGRATION !== '1' && !localProvider && !smokeOnly) {
    console.log('SKIP scenario B: set DSH_RUN_REAL_INTEGRATION=1 to use the real provider');
    return;
  }
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const workspace = process.env.DSH_INTEGRATION_WORKSPACE ?? process.cwd();
  const childEnv = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_PERMISSION_MODE: 'workspace-write',
  };
  const bin = process.env.DSH_ACP_BIN
    ?? join(dshHome, 'profiles', 'acp', 'node_modules', '@deepseek-ai', 'dsh-acp-demo', 'lib', 'bin.js');
  const config = process.env.DSH_INTEGRATION_CONFIG
    ?? join(dshHome, 'profiles', 'acp', 'cordis.yml');
  const child = spawnChild(process.execPath, [bin, '--config', config], {
    cwd: workspace,
    env: childEnv,
  });
  let backendStderr = '';
  child.stderr.on('data', (d: Buffer) => { backendStderr += d.toString(); });
  const transport = new NdjsonTransport(child);
  const connection = new AcpClientConnection({ clientInfo: { name: 'test', version: '0' }, transport });
  const init = await connection.initialize();
  check('real backend initialize', init.agentInfo.name === 'deepseek-harness-acp', JSON.stringify(init.agentInfo));
  if (smokeOnly && !localProvider) {
    check('runtime smoke exposes ACP prompt capabilities', typeof init.agentCapabilities.promptCapabilities.image === 'boolean', JSON.stringify(init.agentCapabilities));
    transport.dispose();
    connection.dispose();
    child.stdin.end();
    await new Promise((r) => setTimeout(r, 1500));
    child.kill();
    console.log('=== backend stderr tail ===');
    console.log(backendStderr.slice(-800) || '(empty)');
    return;
  }
  const session = await connection.newSession(workspace);
  const chunks: string[] = [];
  connection.onMessageChunk((_sid, text) => chunks.push(text));
  const t0 = Date.now();
  const expectedText = process.env.DSH_INTEGRATION_EXPECTED_TEXT ?? '收到';
  const result = await connection.prompt(session.sessionId, [{ type: 'text', text: '只回复：' + expectedText }], 240_000);
  console.log('   real round trip', Date.now() - t0, 'ms; stopReason:', result.stopReason);
  check('real prompt settles end_turn', result.stopReason === 'end_turn');
  check('real chunks received through plugin client', chunks.join('').includes(expectedText), JSON.stringify(chunks).slice(0, 120));
  transport.dispose();
  connection.dispose();
  child.stdin.end();
  await new Promise((r) => setTimeout(r, 1500));
  child.kill();
  console.log('=== backend stderr tail ===');
  console.log(backendStderr.slice(-800) || '(empty)');
}

async function main(): Promise<void> {
  await scenarioA();
  await scenarioB();
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

void main();
