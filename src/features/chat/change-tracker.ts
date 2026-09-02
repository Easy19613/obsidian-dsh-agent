import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  readFile as readFileAsync,
  readdir as readdirAsync,
  stat as statAsync,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FileChange, FileChangeSet, ToolActivity } from './session';

interface SnapshotEntry { content?: string; hash: string; size: number }
export type WorkspaceSnapshot = Map<string, SnapshotEntry>;

const TEXT_EXTENSIONS = new Set([
  '.md', '.canvas', '.base', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.html', '.xml', '.py', '.sh', '.ps1',
  '.bat', '.ini', '.cfg', '.sql', '.r', '.c', '.h', '.cpp', '.java', '.go', '.rs',
]);
const SKIP_DIRECTORIES = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.dsh-agent-trash']);
const SENSITIVE_PATH = /(^|\/)(\.env(?:\.|$)|[^/]*(?:credential|password|secret|token|api[_-]?key)[^/]*)/i;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_CHANGED_FILES = 80;
const MAX_CHANGESET_CONTENT_BYTES = 8 * 1024 * 1024;
const DIRECT_MUTATION_TOOLS = new Set([
  'write', 'edit', 'apply_patch', 'delete', 'remove', 'move', 'rename',
]);
const SHELL_MUTATION_TOOLS = new Set(['bash', 'shell', 'exec', 'exec_command']);

export function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const snapshot: WorkspaceSnapshot = new Map();
  let capturedBytes = 0;
  if (!existsSync(root)) return snapshot;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      try {
        const path = normalizeRelative(root, absolute);
        const size = statSync(absolute).size;
        if (SENSITIVE_PATH.test(path) || size > MAX_FILE_BYTES || capturedBytes + size > MAX_TOTAL_BYTES) {
          snapshot.set(path, { hash: hashFile(absolute), size });
          continue;
        }
        const content = readFileSync(absolute, 'utf8');
        capturedBytes += Buffer.byteLength(content);
        snapshot.set(path, { content, hash: hashText(content), size });
      } catch {
        // A concurrently moved or unreadable file must not disable tracking
        // for the rest of the workspace.
      }
    }
  };
  visit(root);
  return snapshot;
}

/**
 * Capture a workspace without blocking Obsidian's renderer thread on disk IO.
 * Files are discovered asynchronously, metadata is collected with bounded
 * concurrency, and only the content budget is read. Files outside that budget
 * use a cheap metadata fingerprint instead of synchronously hashing the whole
 * file.
 */
export async function snapshotWorkspaceAsync(root: string): Promise<WorkspaceSnapshot> {
  const snapshot: WorkspaceSnapshot = new Map();
  if (!existsSync(root)) return snapshot;

  const files: Array<{ absolute: string; path: string }> = [];
  const pendingDirectories = [root];
  while (pendingDirectories.length > 0) {
    const dir = pendingDirectories.pop();
    if (dir === undefined) break;
    try {
      const entries = await readdirAsync(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push(absolute);
        } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          files.push({ absolute, path: normalizeRelative(root, absolute) });
        }
      }
    } catch {
      // A concurrently moved or unreadable directory must not disable
      // tracking for the rest of the workspace.
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const candidates: Array<{ absolute: string; path: string; size: number; mtimeMs: number }> = [];
  await runWithConcurrency(files, 48, async (file) => {
    try {
      const info = await statAsync(file.absolute);
      if (!info.isFile()) return;
      candidates.push({ ...file, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // The file changed between discovery and stat; ignore it for this
      // snapshot and allow the next turn to observe its final state.
    }
  });
  candidates.sort((a, b) => a.path.localeCompare(b.path));

  let reservedBytes = 0;
  const contentCandidates: typeof candidates = [];
  for (const candidate of candidates) {
    if (SENSITIVE_PATH.test(candidate.path)
      || candidate.size > MAX_FILE_BYTES
      || reservedBytes + candidate.size > MAX_TOTAL_BYTES) {
      snapshot.set(candidate.path, {
        hash: hashMetadata(candidate.size, candidate.mtimeMs),
        size: candidate.size,
      });
      continue;
    }
    reservedBytes += candidate.size;
    contentCandidates.push(candidate);
  }

  await runWithConcurrency(contentCandidates, 16, async (candidate) => {
    try {
      const content = await readFileAsync(candidate.absolute, 'utf8');
      const size = Buffer.byteLength(content);
      snapshot.set(candidate.path, { content, hash: hashText(content), size });
    } catch {
      // The file changed between stat and read; leave it out of this snapshot.
    }
  });
  return snapshot;
}

export function compareWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  startedAt: number,
  completedAt = Date.now(),
  includedPaths?: ReadonlySet<string>,
): FileChangeSet {
  const paths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => includedPaths === undefined || includedPaths.has(path))
    .sort();
  const files: FileChange[] = [];
  let truncated = false;
  let storedContentBytes = 0;
  for (const path of paths) {
    const old = before.get(path);
    const current = after.get(path);
    if (old?.hash === current?.hash) continue;
    if (files.length >= MAX_CHANGED_FILES) {
      truncated = true;
      continue;
    }
    const kind: FileChange['kind'] = old === undefined ? 'created' : current === undefined ? 'deleted' : 'modified';
    let beforeText = old?.content;
    let afterText = current?.content;
    const contentBytes = Buffer.byteLength(beforeText ?? '') + Buffer.byteLength(afterText ?? '');
    if (storedContentBytes + contentBytes > MAX_CHANGESET_CONTENT_BYTES) {
      beforeText = undefined;
      afterText = undefined;
      truncated = true;
    } else {
      storedContentBytes += contentBytes;
    }
    const counts = countLineChanges(beforeText ?? '', afterText ?? '');
    files.push({
      path,
      kind,
      before: beforeText,
      after: afterText,
      additions: counts.additions,
      deletions: counts.deletions,
      reversible: kind === 'created'
        ? afterText !== undefined
        : kind === 'deleted'
          ? beforeText !== undefined
          : beforeText !== undefined && afterText !== undefined,
    });
    if ((old !== undefined && old.content === undefined) || (current !== undefined && current.content === undefined)) truncated = true;
  }
  return { startedAt, completedAt, files, truncated };
}

/**
 * Attribute candidate workspace changes to successful mutating tool calls in
 * this assistant turn. This prevents edits made concurrently by another agent
 * or by the user from appearing in the current answer's change card.
 */
export function attributedWorkspacePaths(
  root: string,
  activities: ToolActivity[],
  candidatePaths: Iterable<string>,
): Set<string> {
  const candidates = [...candidatePaths];
  const attributed = new Set<string>();
  for (const activity of activities) {
    if (activity.status === 'error') continue;
    const toolName = normalizedToolName(activity.name);
    const args = parseObject(activity.argumentsJson);
    if (DIRECT_MUTATION_TOOLS.has(toolName)) {
      for (const value of pathValues(args, activity.meta)) {
        const path = normalizeToolPath(root, value);
        if (path === undefined) continue;
        let matched = false;
        for (const candidate of candidates) {
          if (candidate === path || candidate.startsWith(path.replace(/\/$/, '') + '/')) {
            attributed.add(candidate);
            matched = true;
          }
        }
        if (!matched) attributed.add(path);
      }
      continue;
    }
    if (!SHELL_MUTATION_TOOLS.has(toolName)) continue;
    const command = stringValue(args, ['command', 'cmd', 'script']);
    if (command === undefined) continue;
    const commandText = command.replace(/\\/g, '/');
    const workdirValue = stringValue(args, ['workdir', 'cwd']);
    const workdir = workdirValue === undefined ? '' : normalizeToolDirectory(root, workdirValue);
    for (const candidate of candidates) {
      const normalized = candidate.replace(/\\/g, '/');
      if (commandText.includes(normalized)) {
        attributed.add(candidate);
        continue;
      }
      const candidateDirectory = dirname(normalized).replace(/\\/g, '/');
      const inCommandWorkdir = (candidateDirectory === '.' ? '' : candidateDirectory) === workdir;
      if (inCommandWorkdir && commandText.includes(basename(normalized))) attributed.add(candidate);
    }
  }
  return attributed;
}

export function revertFileChanges(
  root: string,
  changeSet: FileChangeSet,
  trashRoot: string,
): { reverted: string[]; conflicts: string[]; unavailable: string[] } {
  const reverted: string[] = [];
  const conflicts: string[] = [];
  const unavailable: string[] = [];
  mkdirSync(trashRoot, { recursive: true });
  for (const change of [...changeSet.files].reverse()) {
    if (change.reverted) continue;
    const target = resolveInside(root, change.path);
    if (target === undefined || !change.reversible) {
      unavailable.push(change.path);
      continue;
    }
    const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    if (change.kind === 'created') {
      if (current === undefined) {
        change.reverted = true;
        reverted.push(change.path);
        continue;
      }
      if (change.after !== undefined && hashText(current) !== hashText(change.after)) {
        conflicts.push(change.path);
        continue;
      }
      const trashPath = join(trashRoot, Date.now() + '-' + change.path.replace(/[\\/]/g, '__'));
      mkdirSync(dirname(trashPath), { recursive: true });
      renameSync(target, trashPath);
    } else {
      if (change.kind === 'modified' && current === undefined) {
        conflicts.push(change.path);
        continue;
      }
      if (change.kind === 'modified' && current !== undefined && change.after !== undefined
        && hashText(current) !== hashText(change.after)) {
        conflicts.push(change.path);
        continue;
      }
      if (change.kind === 'deleted' && current !== undefined) {
        conflicts.push(change.path);
        continue;
      }
      if (change.before === undefined) {
        unavailable.push(change.path);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, change.before, 'utf8');
    }
    change.reverted = true;
    reverted.push(change.path);
  }
  if (reverted.length > 0) changeSet.revertedAt = Date.now();
  return { reverted, conflicts, unavailable };
}

export function previewLineDiff(change: FileChange, maxLines = 120): string {
  const before = (change.before ?? '').split(/\r?\n/);
  const after = (change.after ?? '').split(/\r?\n/);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  while (beforeEnd >= prefix && afterEnd >= prefix && before[beforeEnd] === after[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const lines = [
    ...before.slice(prefix, beforeEnd + 1).map((line) => '- ' + line),
    ...after.slice(prefix, afterEnd + 1).map((line) => '+ ' + line),
  ];
  if (lines.length === 0) return '（内容无可显示的行级差异）';
  return lines.slice(0, maxLines).join('\n') + (lines.length > maxLines ? '\n… 差异过长，已截断' : '');
}

function countLineChanges(before: string, after: string): { additions: number; deletions: number } {
  if (before === '') return { additions: after === '' ? 0 : after.split(/\r?\n/).length, deletions: 0 };
  if (after === '') return { additions: 0, deletions: before.split(/\r?\n/).length };
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const common = new Map<string, number>();
  for (const line of a) common.set(line, (common.get(line) ?? 0) + 1);
  let matched = 0;
  for (const line of b) {
    const count = common.get(line) ?? 0;
    if (count > 0) {
      matched += 1;
      common.set(line, count - 1);
    }
  }
  return { additions: b.length - matched, deletions: a.length - matched };
}

function normalizeRelative(root: string, absolute: string): string {
  return relative(resolve(root), resolve(absolute)).replace(/\\/g, '/');
}

function normalizedToolName(name: string): string {
  const normalized = name.toLowerCase();
  const parts = normalized.split(/[.:/]/).filter((part) => part !== '');
  return parts.length > 0 ? parts[parts.length - 1] : normalized;
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value = JSON.parse(json) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringValue(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function pathValues(args: Record<string, unknown>, meta: unknown): string[] {
  const values: string[] = [];
  const collect = (object: unknown): void => {
    if (object === null || typeof object !== 'object' || Array.isArray(object)) return;
    const record = object as Record<string, unknown>;
    for (const key of [
      'file_path', 'filePath', 'path', 'target', 'target_path', 'destination',
      'destination_path', 'source', 'source_path', 'old_path', 'new_path',
    ]) {
      if (typeof record[key] === 'string') values.push(record[key] as string);
    }
    for (const key of ['paths', 'file_paths']) {
      if (Array.isArray(record[key])) {
        for (const value of record[key] as unknown[]) {
          if (typeof value === 'string') values.push(value);
        }
      }
    }
  };
  collect(args);
  collect(meta);
  return values;
}

function normalizeToolPath(root: string, value: string): string | undefined {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(resolve(root), absolute);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep)) return undefined;
  return rel.replace(/\\/g, '/');
}

function normalizeToolDirectory(root: string, value: string): string {
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(resolve(root), absolute);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + sep)) return '__outside_workspace__';
  return rel.replace(/\\/g, '/').replace(/\/$/, '');
}

function resolveInside(root: string, path: string): string | undefined {
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep)) return undefined;
  return absolute;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hashMetadata(size: number, mtimeMs: number): string {
  return 'metadata:' + size + ':' + mtimeMs;
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}
