// Skill directory scanning for the slash menu (pure, testable).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillEntry {
  name: string;
  description: string;
}

/** Parse name/description from a SKILL.md frontmatter block. */
export function parseSkillFrontmatter(text: string): { name: string; description: string } | null {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (match === null) return null;
  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(\S+)/m);
  if (nameMatch === null) return null;
  const name = nameMatch[1].trim();
  // description is usually a block scalar (| or >) — take the first content line.
  const descMatch = frontmatter.match(/^description:\s*[>|]?[-]?\s*\r?\n(\s*)(\S.*)$/m);
  let description = '';
  if (descMatch !== null) {
    description = descMatch[2].trim();
  } else {
    const inline = frontmatter.match(/^description:\s*(\S.*)$/m);
    if (inline !== null) description = inline[1].trim();
  }
  const compact = description.replace(/\s+/g, ' ').trim();
  return { name, description: compact.length > 80 ? compact.slice(0, 80) + '…' : compact };
}

/** Scan one skills directory (bundle dirs with SKILL.md or flat .md files). */
export function scanSkillsDir(dir: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return entries;
  }
  for (const item of names) {
    if (item.startsWith('.')) continue;
    const full = join(dir, item);
    try {
      const stat = existsSync(join(full, 'SKILL.md'))
        ? 'bundle'
        : existsSync(full) && full.endsWith('.md')
          ? 'flat'
          : 'none';
      if (stat === 'none') continue;
      const filePath = stat === 'bundle' ? join(full, 'SKILL.md') : full;
      const parsed = parseSkillFrontmatter(readFileSync(filePath, 'utf8'));
      if (parsed !== null) entries.push(parsed);
      else if (stat === 'flat') entries.push({ name: item.replace(/\.md$/, ''), description: '' });
    } catch {
      // unreadable entry — skip
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
