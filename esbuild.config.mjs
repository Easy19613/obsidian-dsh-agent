import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const prod = process.argv[2] === 'production';
const noDeploy = process.argv.includes('--no-deploy');

function readLocalEnv(name) {
  const envPath = path.resolve('.env.local');
  if (!existsSync(envPath)) return undefined;
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1 || line.slice(0, separator).trim() !== name) continue;
    const value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  }
  return undefined;
}

// Deployment is opt-in through the environment or an ignored .env.local file.
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT ?? readLocalEnv('OBSIDIAN_VAULT');
const OBSIDIAN_PLUGIN_PATH = !noDeploy && OBSIDIAN_VAULT && existsSync(OBSIDIAN_VAULT)
  ? path.join(OBSIDIAN_VAULT, '.obsidian', 'plugins', 'dsh-agent')
  : null;

/**
 * Electron renderer has no timer.unref(). Obsidian plugins run in the renderer,
 * so any bundled call to setTimeout(...).unref() would crash at runtime. Our own
 * code never calls it; this plugin fails the build loudly if a dependency brings
 * one in (fix the call site instead of patching blindly).
 */
const unrefGuard = {
  name: 'unref-guard',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      for (const outputPath of ['main.js']) {
        if (!existsSync(outputPath)) continue;
        const contents = readFileSync(outputPath, 'utf8');
        const re = /set(?:Timeout|Interval)\s*\(/g;
        let m;
        const hits = [];
        while ((m = re.exec(contents)) !== null) {
          const window = contents.slice(m.index, m.index + 600);
          const close = window.indexOf(';');
          const snippet = window.slice(0, close === -1 ? 600 : close + 1);
          if (snippet.includes('.unref()')) hits.push(snippet.slice(0, 300));
        }
        if (hits.length > 0) {
          throw new Error(
            'Renderer-unsafe .unref() calls found in main.js:\n' +
            hits.map((h) => '  ' + h.replace(/\s+/g, ' ')).join('\n'),
          );
        }
      }
    });
  },
};

const copyToObsidian = {
  name: 'copy-to-obsidian',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      if (!OBSIDIAN_PLUGIN_PATH) return;
      mkdirSync(OBSIDIAN_PLUGIN_PATH, { recursive: true });
      for (const file of ['main.js', 'manifest.json', 'styles.css', 'THIRD_PARTY_NOTICES.md']) {
        if (existsSync(file)) {
          copyFileSync(file, path.join(OBSIDIAN_PLUGIN_PATH, file));
          console.log(`copied ${file} -> ${OBSIDIAN_PLUGIN_PATH}`);
        }
      }
    });
  },
};

const external = [
  'obsidian',
  'electron',
  '@codemirror/*',
  '@lezer/*',
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [unrefGuard, copyToObsidian],
  external,
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  minify: prod,
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
