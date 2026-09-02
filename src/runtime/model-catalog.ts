import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ReasoningEffort } from '../settings/settings';
import {
  LOCAL_PROVIDER_ID,
  MODEL_CATALOG,
  type ModelCatalog,
  type ModelCatalogModel,
} from './templates';

export const REASONING_EFFORT_ORDER: readonly ReasoningEffort[] = [
  'default', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

const STATIC_EFFORTS: Record<string, ReasoningEffort[]> = {
  'opencode-go::deepseek-v4-flash': ['default', 'high', 'max'],
  'opencode-go::deepseek-v4-pro': ['default', 'high', 'max'],
  'opencode-go::glm-5.2': ['default', 'high', 'max'],
  'opencode-go::hy3': ['default', 'off', 'low', 'high'],
  'opencode-go::kimi-k3': ['default', 'max'],
  'opencode-go::grok-4.5': ['default', 'low', 'medium', 'high'],
};

interface RawModel {
  id?: unknown;
  name?: unknown;
  contextWindow?: unknown;
  reasoning?: unknown;
  reasoningEfforts?: unknown;
  thinkingLevelMap?: unknown;
}

interface RawProviderProfile {
  displayName?: unknown;
  models?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedEfforts(values: Iterable<string>): ReasoningEffort[] {
  const found = new Set<ReasoningEffort>(['default']);
  for (const value of values) {
    if (REASONING_EFFORT_ORDER.includes(value as ReasoningEffort)) found.add(value as ReasoningEffort);
  }
  return REASONING_EFFORT_ORDER.filter((effort) => found.has(effort));
}

function modelEfforts(providerId: string, model: RawModel): ReasoningEffort[] {
  if (isRecord(model.reasoningEfforts)) return sortedEfforts(Object.keys(model.reasoningEfforts));
  if (model.reasoningEfforts === false) return ['default'];
  if (model.reasoning === true && isRecord(model.thinkingLevelMap)) {
    // Mirror pi-ai getSupportedThinkingLevels(): null explicitly disables a
    // level; missing base levels remain supported, while xhigh/max require an
    // explicit mapping.
    const thinkingLevelMap = model.thinkingLevelMap;
    const supported = REASONING_EFFORT_ORDER
      .filter((effort) => effort !== 'default')
      .filter((effort) => {
        const wire = thinkingLevelMap[effort];
        if (wire === null) return false;
        if (effort === 'xhigh' || effort === 'max') return wire !== undefined;
        return true;
      });
    return sortedEfforts(supported);
  }
  if (model.reasoning === true) return ['default', 'off', 'minimal', 'low', 'medium', 'high'];
  const id = typeof model.id === 'string' ? model.id : '';
  return STATIC_EFFORTS[providerId + '::' + id] ?? ['default'];
}

function toModel(providerId: string, raw: RawModel): ModelCatalogModel | undefined {
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return undefined;
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : raw.id,
    reasoningEfforts: modelEfforts(providerId, raw),
    ...(typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0
      ? { contextWindow: Math.round(raw.contextWindow) }
      : {}),
  };
}

function fallbackCatalog(): ModelCatalog {
  const result: ModelCatalog = {};
  for (const [providerId, provider] of Object.entries(MODEL_CATALOG)) {
    result[providerId] = {
      name: provider.name,
      models: provider.models.map((model) => ({
        ...model,
        reasoningEfforts: providerId === 'deepseek-official'
          ? ['default', 'off', 'low', 'high', 'max']
          : providerId === LOCAL_PROVIDER_ID
            ? ['default', 'off', 'high', 'max']
            : STATIC_EFFORTS[providerId + '::' + model.id] ?? ['default'],
      })),
    };
  }
  return result;
}

function readYaml(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const value = parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function explicitModels(providerId: string, profile: RawProviderProfile): ModelCatalogModel[] | undefined {
  if (!Array.isArray(profile.models)) return undefined;
  const models = profile.models
    .map((entry) => isRecord(entry) ? toModel(providerId, entry) : undefined)
    .filter((entry): entry is ModelCatalogModel => entry !== undefined);
  return models.length > 0 ? models : undefined;
}

function installedPiAiModels(profileDir: string, providerId: string): ModelCatalogModel[] | undefined {
  const dataPath = join(
    profileDir,
    'node_modules',
    '@earendil-works',
    'pi-ai',
    'dist',
    'providers',
    'data',
    providerId + '.json',
  );
  try {
    if (!existsSync(dataPath)) return undefined;
    const protocols = JSON.parse(readFileSync(dataPath, 'utf8')) as unknown;
    if (!isRecord(protocols)) return undefined;
    const seen = new Set<string>();
    const models: ModelCatalogModel[] = [];
    for (const entries of Object.values(protocols)) {
      if (!isRecord(entries)) continue;
      for (const value of Object.values(entries)) {
        if (!isRecord(value)) continue;
        const model = toModel(providerId, value);
        if (model === undefined || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push(model);
      }
    }
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}

/** Refresh provider/model metadata from the installed DSH catalog and live settings document. */
export function discoverRuntimeModelCatalog(profileDir: string, settingsPath: string): ModelCatalog {
  const catalog = fallbackCatalog();
  const document = readYaml(settingsPath);
  const llmPiAi = isRecord(document['llm-pi-ai']) ? document['llm-pi-ai'] : {};
  const profiles = isRecord(llmPiAi.providers) ? llmPiAi.providers : {};
  const providerIds = new Set([...Object.keys(catalog), ...Object.keys(profiles)]);
  for (const providerId of providerIds) {
    const profile = isRecord(profiles[providerId]) ? profiles[providerId] as RawProviderProfile : {};
    const models = explicitModels(providerId, profile)
      ?? installedPiAiModels(profileDir, providerId)
      ?? catalog[providerId]?.models;
    if (models === undefined || models.length === 0) continue;
    catalog[providerId] = {
      name: typeof profile.displayName === 'string' && profile.displayName.trim() !== ''
        ? profile.displayName
        : catalog[providerId]?.name ?? providerId,
      models,
    };
  }

  const deepseek = isRecord(document['llm-deepseek']) ? document['llm-deepseek'] : {};
  const deepseekModels = explicitModels('deepseek-official', deepseek);
  if (deepseekModels !== undefined) {
    catalog['deepseek-official'] = { name: catalog['deepseek-official']?.name ?? 'DeepSeek 官方 API', models: deepseekModels };
  }
  return catalog;
}

export function modelCatalogKeys(catalog: ModelCatalog): string[] {
  const keys: string[] = [];
  for (const [providerId, provider] of Object.entries(catalog)) {
    for (const model of provider.models) keys.push(providerId + '::' + model.id);
  }
  return keys.sort();
}

export interface ReconciledModelVisibility {
  knownModels: string[];
  hiddenModels: string[];
}

/**
 * Remember the authoritative catalog seen at startup. Models that appear
 * after the first catalog snapshot are hidden until the user enables them.
 */
export function reconcileDiscoveredModels(
  discovered: readonly string[],
  knownModels: readonly string[],
  hiddenModels: readonly string[],
  historyLoaded: boolean,
): ReconciledModelVisibility {
  if (!historyLoaded) {
    return { knownModels: [...new Set(discovered)].sort(), hiddenModels: [...new Set(hiddenModels)].sort() };
  }
  const known = new Set(knownModels);
  const hidden = new Set(hiddenModels);
  for (const key of discovered) {
    if (!known.has(key)) hidden.add(key);
    known.add(key);
  }
  return { knownModels: [...known].sort(), hiddenModels: [...hidden].sort() };
}

export function modelEffortsOf(catalog: ModelCatalog, providerId: string, modelId: string): ReasoningEffort[] {
  return catalog[providerId]?.models.find((model) => model.id === modelId)?.reasoningEfforts ?? ['default'];
}

export function preferredEffort(efforts: readonly ReasoningEffort[], current: ReasoningEffort): ReasoningEffort {
  if (efforts.includes(current)) return current;
  for (const effort of ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'off', 'default'] as const) {
    if (efforts.includes(effort)) return effort;
  }
  return 'default';
}
