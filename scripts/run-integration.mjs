// Bundle + run the ACP integration tests (mock server + real backend).
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('tests/dist', { recursive: true });

const suites = [
  { entry: 'tests/integration-entry.ts', output: 'tests/dist/integration.cjs', timeout: 400000 },
  { entry: 'tests/tailer-test-entry.ts', output: 'tests/dist/tailer-test.cjs', timeout: 120000 },
  { entry: 'tests/ui-logic-entry.ts', output: 'tests/dist/ui-logic.cjs', timeout: 120000 },
  { entry: 'tests/change-tracker-async-entry.ts', output: 'tests/dist/change-tracker-async.cjs', timeout: 120000 },
];

for (const suite of suites) {
  const bundle = spawnSync(process.execPath, [
    'node_modules/esbuild/bin/esbuild',
    suite.entry,
    '--bundle', '--platform=node', '--format=cjs', '--target=node18',
    '--external:node:*', '--outfile=' + suite.output, '--log-level=warning',
  ], { encoding: 'utf8' });
  if (bundle.status !== 0) {
    console.error(bundle.stderr);
    process.exit(1);
  }
  const run = spawnSync(process.execPath, [suite.output], {
    encoding: 'utf8', timeout: suite.timeout, stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(run.stdout ?? '');
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.status !== 0) process.exit(run.status ?? 1);
}
