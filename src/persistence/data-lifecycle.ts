import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

export const PLUGIN_DATA_VERSION = 5;

export interface StorageStats {
  totalBytes: number;
  dataBytes: number;
  sessionBytes: number;
  backupBytes: number;
  sessionFiles: number;
}

const SECRET_KEY = /(^|[_-])(api[_-]?key|token|secret|password|authorization|cookie|credential)([_-]|$)/i;
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi,
  /\b(sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi,
  /(["']?(?:api[_-]?key|token|secret|password|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]{6,}/gi,
];

export function redactSensitiveText(value: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) return JSON.stringify(redactValue(parsed));
  let output = value;
  for (const pattern of SECRET_TEXT_PATTERNS) {
    output = output.replace(pattern, (match, prefix: string | undefined) =>
      prefix === undefined ? '[REDACTED]' : prefix + '[REDACTED]');
  }
  return output;
}

function redactValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
  }
  if (typeof value === 'string') {
    let output = value;
    for (const pattern of SECRET_TEXT_PATTERNS) output = output.replace(pattern, '[REDACTED]');
    return output;
  }
  return value;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function backupDataBeforeMigration(pluginDir: string, fromVersion: number): string | undefined {
  const dataPath = join(pluginDir, 'data.json');
  if (!existsSync(dataPath)) return undefined;
  const backupDir = join(pluginDir, '.backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(backupDir, `data-v${fromVersion}-${stamp}.json`);
  copyFileSync(dataPath, target);
  const backups = readdirSync(backupDir)
    .filter((name) => /^data-v\d+-.*\.json$/.test(name))
    .map((name) => ({ name, time: statSync(join(backupDir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const old of backups.slice(5)) unlinkSync(join(backupDir, old.name));
  return target;
}

export function collectStorageStats(pluginDir: string): StorageStats {
  const dataBytes = fileSize(join(pluginDir, 'data.json'));
  const sessions = treeSize(join(pluginDir, '.sessions'));
  const backups = treeSize(join(pluginDir, '.backups'));
  return {
    totalBytes: dataBytes + sessions.bytes + backups.bytes,
    dataBytes,
    sessionBytes: sessions.bytes,
    backupBytes: backups.bytes,
    sessionFiles: sessions.files,
  };
}

export function archiveSessionLogs(paths: string[], persistenceRoot: string): number {
  const trashRoot = join(persistenceRoot, '.trash');
  mkdirSync(trashRoot, { recursive: true });
  let moved = 0;
  for (const filePath of paths) {
    try {
      const sessionDir = dirname(filePath);
      if (!existsSync(sessionDir) || !isInside(persistenceRoot, sessionDir)) continue;
      let target = join(trashRoot, Date.now() + '-' + basename(sessionDir));
      let suffix = 1;
      while (existsSync(target)) target = join(trashRoot, Date.now() + '-' + suffix++ + '-' + basename(sessionDir));
      renameSync(sessionDir, target);
      moved += 1;
    } catch {
      // A locked log remains in place and will still be covered by retention.
    }
  }
  return moved;
}

export function cleanupSessionLogs(persistenceRoot: string, retentionDays: number, now = Date.now()): { removed: number; bytes: number } {
  if (retentionDays <= 0 || !existsSync(persistenceRoot)) return { removed: 0, bytes: 0 };
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const trash = join(persistenceRoot, '.trash');
  let removed = 0;
  let bytes = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (!isInside(persistenceRoot, path)) continue;
      if (entry.isDirectory()) {
        if (resolve(path) === resolve(trash)) continue;
        visit(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const info = statSync(path);
      if (info.mtimeMs >= cutoff) continue;
      bytes += info.size;
      unlinkSync(path);
      removed += 1;
      removeEmptyParents(dirname(path), persistenceRoot);
    }
  };
  visit(persistenceRoot);
  // Conversation-deletion trash is intentionally recoverable for one retention window.
  if (existsSync(trash)) {
    for (const entry of readdirSync(trash, { withFileTypes: true })) {
      const path = join(trash, entry.name);
      const archivedAt = Number(entry.name.slice(0, 13));
      const ageTime = Number.isFinite(archivedAt) && archivedAt > 0 ? archivedAt : statSync(path).mtimeMs;
      if (!entry.isDirectory() || ageTime >= cutoff || !isInside(trash, path)) continue;
      const size = treeSize(path).bytes;
      rmSync(path, { recursive: true, force: false });
      bytes += size;
      removed += 1;
    }
  }
  return { removed, bytes };
}

function removeEmptyParents(start: string, root: string): void {
  let current = resolve(start);
  const resolvedRoot = resolve(root);
  while (current !== resolvedRoot && isInside(resolvedRoot, current)) {
    if (readdirSync(current).length > 0) return;
    rmdirSync(current);
    current = dirname(current);
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function treeSize(root: string): { bytes: number; files: number } {
  if (!existsSync(root)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const child = treeSize(path);
      bytes += child.bytes;
      files += child.files;
    } else if (entry.isFile()) {
      bytes += fileSize(path);
      files += 1;
    }
  }
  return { bytes, files };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !resolve(target).startsWith(resolve(root) + sep + '..');
}
