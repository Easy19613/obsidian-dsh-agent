// DSH ACP runtime provisioning under $DSH_HOME/profiles/acp.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DshAgentSettings, ReasoningEffort } from '../settings/settings';
import {
  cordisTemplate,
  excludeToolEntries,
  extractUserSections,
  hotModelRouteModule,
  RUNTIME_PACKAGES,
  RUNTIME_VERSION,
  runtimePackageJson,
  settingsSeedTemplate,
} from '../runtime/templates';
import { disabledCordisIds, resolveFeatureFlags } from '../features/feature-registry';
import { agentPresetPersona } from '../features/agent-presets';

export type InstallStatus =
  | { kind: 'not-installed' }
  | { kind: 'installing'; detail: string }
  | { kind: 'installed'; detail: string }
  | { kind: 'error'; detail: string };

export interface InstallPaths {
  profileDir: string;
  cordisPath: string;
  settingsPath: string;
  hotModelRoutePath: string;
  binPath: string;
  persistenceRoot: string;
}

interface RuntimeUpgradeBackup {
  dir: string;
  packageJson: string;
  packageLock: string;
  nodeModules: string;
}

export class DshRuntimeInstaller {
  private revisionCounter = 0;

  constructor(private readonly dshHome: string) {}

  get paths(): InstallPaths {
    const profileDir = join(this.dshHome, 'profiles', 'acp');
    return {
      profileDir,
      cordisPath: join(profileDir, 'cordis.yml'),
      settingsPath: join(profileDir, 'settings.yaml'),
      hotModelRoutePath: join(profileDir, 'dsh-agent-hot-model-route.mjs'),
      binPath: join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-acp-demo', 'lib', 'bin.js'),
      persistenceRoot: '',
    };
  }

  isInstalled(): boolean {
    if (!existsSync(this.paths.binPath)) return false;
    if (this.installedVersion() !== RUNTIME_VERSION) return false;
    return RUNTIME_PACKAGES.every((name) => existsSync(join(
      this.paths.profileDir,
      'node_modules',
      '@deepseek-ai',
      name,
      'package.json',
    )));
  }

  private installedVersion(): string | undefined {
    const packagePath = join(
      this.paths.profileDir,
      'node_modules',
      '@deepseek-ai',
      'dsh-acp-demo',
      'package.json',
    );
    try {
      const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
      return typeof manifest.version === 'string' ? manifest.version : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * npm can reject an in-place prerelease upgrade because the old dependency
   * tree still participates in peer resolution. Move the plugin-owned tree to
   * a recoverable backup before installing the new exact-version manifest.
   */
  private prepareRuntimeUpgrade(): RuntimeUpgradeBackup | undefined {
    if (!existsSync(this.paths.binPath)) return undefined;
    const fromVersion = this.installedVersion();
    if (fromVersion === undefined || fromVersion === RUNTIME_VERSION) return undefined;

    const safeVersion = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(
      this.paths.profileDir,
      '.upgrade-backups',
      stamp + '-' + safeVersion(fromVersion) + '-to-' + safeVersion(RUNTIME_VERSION),
    );
    mkdirSync(dir, { recursive: true });
    const backup: RuntimeUpgradeBackup = {
      dir,
      packageJson: join(dir, 'package.json'),
      packageLock: join(dir, 'package-lock.json'),
      nodeModules: join(dir, 'node_modules'),
    };
    const profilePackage = join(this.paths.profileDir, 'package.json');
    const profileLock = join(this.paths.profileDir, 'package-lock.json');
    const profileModules = join(this.paths.profileDir, 'node_modules');
    if (existsSync(profilePackage)) copyFileSync(profilePackage, backup.packageJson);
    if (existsSync(profileLock)) renameSync(profileLock, backup.packageLock);
    if (existsSync(profileModules)) renameSync(profileModules, backup.nodeModules);
    return backup;
  }

  /** Restore the prior working runtime after an install failure, without deleting the failed tree. */
  private restoreRuntimeUpgrade(backup: RuntimeUpgradeBackup): void {
    const profilePackage = join(this.paths.profileDir, 'package.json');
    const profileLock = join(this.paths.profileDir, 'package-lock.json');
    const profileModules = join(this.paths.profileDir, 'node_modules');
    if (existsSync(profileModules)) renameSync(profileModules, join(backup.dir, 'failed-node_modules'));
    if (existsSync(profileLock)) renameSync(profileLock, join(backup.dir, 'failed-package-lock.json'));
    if (existsSync(profilePackage)) copyFileSync(profilePackage, join(backup.dir, 'failed-package.json'));
    if (existsSync(backup.nodeModules)) renameSync(backup.nodeModules, profileModules);
    if (existsSync(backup.packageLock)) renameSync(backup.packageLock, profileLock);
    if (existsSync(backup.packageJson)) copyFileSync(backup.packageJson, profilePackage);
  }

  /** Regenerate cordis.yml + settings.yaml from current plugin settings. */
  writeRuntimeFiles(
    settings: DshAgentSettings,
    persistenceRoot: string,
    reasoning?: { provider: string; effort: ReasoningEffort },
  ): string {
    const p = this.paths;
    mkdirSync(p.profileDir, { recursive: true });
    writeFileSync(
      join(p.profileDir, 'package.json'),
      runtimePackageJson(),
      'utf8',
    );
    writeFileSync(p.hotModelRoutePath, hotModelRouteModule(), 'utf8');
    const agentsSkillsDir = this.resolveAgentsSkillsDir();
    writeFileSync(
      p.cordisPath,
      excludeToolEntries(cordisTemplate({
        settingsPath: p.settingsPath,
        persistenceRoot,
        provider: settings.provider,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        persona: agentPresetPersona(settings.agentPreset),
        ...agentsSkillsDir !== undefined ? { agentsSkillsDir } : {},
      }), disabledCordisIds(resolveFeatureFlags(settings.featureFlags))),
      'utf8',
    );
    return this.seedSettings(settings, reasoning);
  }

  /** Copy the relevant sections from the user's global settings.yaml into the plugin-owned doc. */
  seedSettings(settings: DshAgentSettings, reasoning?: { provider: string; effort: ReasoningEffort }): string {
    const userSettingsPath = join(this.dshHome, 'settings.yaml');
    let userYaml = '';
    if (existsSync(userSettingsPath)) {
      try {
        userYaml = readFileSync(userSettingsPath, 'utf8');
      } catch {
        userYaml = '';
      }
    }
    const seed = extractUserSections(userYaml);
    const revision = Date.now().toString(36) + '-' + (++this.revisionCounter).toString(36);
    const text = settingsSeedTemplate(seed, reasoning, {
      provider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      revision,
    });
    mkdirSync(this.paths.profileDir, { recursive: true });
    writeFileSync(this.paths.settingsPath, text, 'utf8');
    return revision;
  }

  /** Hot-publish only provider/model/effort; the running Cordis composition stays untouched. */
  writeRuntimeModelSettings(
    settings: DshAgentSettings,
    reasoning?: { provider: string; effort: ReasoningEffort },
  ): string {
    return this.seedSettings(settings, reasoning);
  }

  /**
   * The machine-wide skill root shared with the main DSH (~/.agents/skills,
   * overridable via $DSH_AGENTS_HOME). Included in the runtime config when it
   * exists so the Obsidian agent sees the same skills as the computer DSH.
   */
  resolveAgentsSkillsDir(): string | undefined {
    const base = process.env.DSH_AGENTS_HOME !== undefined && process.env.DSH_AGENTS_HOME !== ''
      ? process.env.DSH_AGENTS_HOME
      : join(homedir(), '.agents');
    const skillsDir = join(base, 'skills');
    return existsSync(skillsDir) ? skillsDir : undefined;
  }

  /** npm install inside the profile dir. Resolves when the process closes. */
  runInstall(onLine?: (line: string) => void): Promise<{ code: number | null; log: string }> {
    const p = this.paths;
    return new Promise((resolve) => {
      let log = '';
      const child = spawn('npm', ['install', '--no-fund', '--no-audit', '--loglevel=error'], {
        cwd: p.profileDir,
        env: { ...process.env },
        shell: true,
      });
      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        log += text;
        onLine?.(text);
      });
      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        log += text;
        onLine?.(text);
      });
      child.on('error', (error) => {
        log += '\n' + String(error);
        resolve({ code: null, log });
      });
      child.on('close', (code) => {
        resolve({ code, log });
      });
    });
  }

  async ensureInstalled(
    settings: DshAgentSettings,
    persistenceRoot: string,
    onProgress?: (detail: string) => void,
  ): Promise<InstallStatus> {
    if (this.isInstalled()) {
      this.writeRuntimeFiles(settings, persistenceRoot);
      return { kind: 'installed', detail: '运行时已就绪' };
    }
    let upgradeBackup: RuntimeUpgradeBackup | undefined;
    try {
      upgradeBackup = this.prepareRuntimeUpgrade();
    } catch (error) {
      return { kind: 'error', detail: '旧运行时备份失败，未执行升级: ' + String(error) };
    }
    if (upgradeBackup !== undefined) {
      onProgress?.('检测到旧版 DSH，已创建可恢复备份，正在执行干净升级…');
    }
    onProgress?.('正在生成运行时配置…');
    try {
      this.writeRuntimeFiles(settings, persistenceRoot);
    } catch (error) {
      if (upgradeBackup !== undefined) {
        try {
          this.restoreRuntimeUpgrade(upgradeBackup);
        } catch (restoreError) {
          return { kind: 'error', detail: '生成运行时配置失败且旧运行时恢复失败: ' + String(restoreError) };
        }
      }
      return { kind: 'error', detail: '生成运行时配置失败'
        + (upgradeBackup !== undefined ? '，已恢复旧运行时' : '') + ': ' + String(error) };
    }
    onProgress?.('正在安装 DSH 运行时依赖（首次约 1-3 分钟）…');
    const { code, log } = await this.runInstall(onProgress);
    if (code !== 0 || !this.isInstalled()) {
      if (upgradeBackup !== undefined) {
        try {
          this.restoreRuntimeUpgrade(upgradeBackup);
        } catch (error) {
          return { kind: 'error', detail: '安装失败且旧运行时恢复失败: ' + String(error) + '\n' + log.slice(-400) };
        }
      }
      return { kind: 'error', detail: '安装失败' + (upgradeBackup !== undefined ? '，已恢复旧运行时' : '') + ': ' + log.slice(-600) };
    }
    return { kind: 'installed', detail: '安装完成' };
  }
}
