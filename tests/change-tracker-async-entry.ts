import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareWorkspaceSnapshots,
  snapshotWorkspaceAsync,
} from '../src/features/chat/change-tracker';

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log('PASS ' + label + (detail !== '' ? ' — ' + detail : ''));
  } else {
    failures += 1;
    console.log('FAIL ' + label + (detail !== '' ? ' — ' + detail : ''));
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-change-tracker-'));
  try {
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'one.md'), '# one\n', 'utf8');
    writeFileSync(join(root, 'credentials.json'), '{"token":"redacted"}\n', 'utf8');

    const pending = snapshotWorkspaceAsync(root);
    check('async snapshot returns immediately with a Promise', pending instanceof Promise);
    const before = await pending;
    check('async snapshot captures ordinary text content', before.get('notes/one.md')?.content === '# one\n');
    check('async snapshot never captures sensitive content', before.get('credentials.json')?.content === undefined);

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(root, 'notes', 'one.md'), '# one\nchanged\n', 'utf8');
    writeFileSync(join(root, 'notes', 'two.md'), '# two\n', 'utf8');
    writeFileSync(join(root, 'credentials.json'), '{"token":"updated-value"}\n', 'utf8');
    const after = await snapshotWorkspaceAsync(root);
    const changes = compareWorkspaceSnapshots(before, after, Date.now() - 20);
    check('async snapshots detect modified files', changes.files.some((file) => file.path === 'notes/one.md' && file.kind === 'modified'));
    check('async snapshots detect created files', changes.files.some((file) => file.path === 'notes/two.md' && file.kind === 'created'));
    check('metadata fingerprint detects sensitive-file changes without reading content', changes.files.some((file) => file.path === 'credentials.json' && file.kind === 'modified'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log(failures === 0 ? 'ALL ASYNC CHANGE TRACKER TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

void main();
