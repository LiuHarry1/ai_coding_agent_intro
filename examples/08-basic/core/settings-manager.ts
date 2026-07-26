import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AppConfig, LspServerConfig, MCPServerConfig } from './types.js'
import {
  DEFAULT_PROFILE,
  profileToRecord,
  resolveModelProfiles,
  type ModelProfiles,
} from './llm/index.js'
import { loadPlugins } from './plugins/index.js'
import {
  getAppDirName,
  LOCAL_SETTINGS_FILE_NAME,
  SETTINGS_FILE_NAME,
} from '../utils/app-dir.js'

function defaultModels(): ModelProfiles {
  const large = { ...DEFAULT_PROFILE }
  return { large, medium: { ...large }, small: { ...large } }
}

export const DEFAULTS: AppConfig = {
  models: defaultModels(),
  compaction: {
    enabled: true,
    contextWindow: 200_000,
    microCompactKeepRecent: 5,
    maxFilesToRestore: 5,
    maxTokensPerFile: 5_000,
    fileBudget: 50_000,
    timeBasedMicroEnabled: false,
    timeBasedMicroGapMinutes: 5,
  },
  sessionMemory: {
    enabled: true,
    minimumTokensToInit: 10_000,
    minimumTokensBetweenUpdate: 5_000,
    toolCallsBetweenUpdates: 3,
    cacheSafe: true,
    modelTier: 'medium',
    compactMinTokens: 10_000,
    compactMaxTokens: 40_000,
    compactMinTextMessages: 5,
  },
  mcpServers: {},
  lspServers: {},
  disabledTools: [],
}

export type SettingsScope = 'user' | 'project' | 'local'

export interface SettingsSource {
  scope: SettingsScope
  path: string
  exists: boolean
  applied: boolean
  error?: string
}

export interface ResolvedSettings {
  config: AppConfig
  sources: SettingsSource[]
  userDir: string
  projectDir: string
  userPath: string
  projectPath: string
  localPath: string
}

export interface EffectiveSettings extends ResolvedSettings {
  /** Plugin MCP merged with settings MCP (settings win on name collision). */
  effectiveMcpServers: Record<string, MCPServerConfig>
}

type PartialAppConfig = Partial<{
  models: Record<string, unknown>
  compaction: Record<string, unknown>
  sessionMemory: Record<string, unknown>
  mcpServers: Record<string, MCPServerConfig>
  lspServers: Record<string, LspServerConfig>
  disabledTools: unknown[]
}>

type ParsedSettingsFile = {
  settings: PartialAppConfig | null
  error?: string
}

/** path-keyed parse cache invalidated by resetSettingsCache(). */
const parseFileCache = new Map<
  string,
  { mtimeMs: number; parsed: ParsedSettingsFile }
>()

/** Per-cwd merged settings cache keyed by source-file mtimes. */
const resolvedCache = new Map<
  string,
  { mtimeKey: string; result: ResolvedSettings }
>()

function cloneDefaults(): AppConfig {
  return structuredClone(DEFAULTS)
}

export function resolveSettingsPaths(cwd: string): {
  userDir: string
  projectDir: string
  userPath: string
  projectPath: string
  localPath: string
} {
  const userDir = path.join(os.homedir(), getAppDirName())
  const projectDir = path.join(path.resolve(cwd), getAppDirName())
  return {
    userDir,
    projectDir,
    userPath: path.join(userDir, SETTINGS_FILE_NAME),
    projectPath: path.join(projectDir, SETTINGS_FILE_NAME),
    localPath: path.join(projectDir, LOCAL_SETTINGS_FILE_NAME),
  }
}

function fileMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function settingsMtimeKey(filePaths: readonly string[]): string {
  return filePaths.map(p => `${p}:${fileMtimeMs(p)}`).join('|')
}

function readSettingsFile(filePath: string): ParsedSettingsFile {
  const mtimeMs = fileMtimeMs(filePath)
  const cached = parseFileCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.parsed

  let parsed: ParsedSettingsFile
  if (mtimeMs === 0) {
    parsed = { settings: null }
  } else {
    try {
      const text = fs.readFileSync(filePath, 'utf-8')
      if (text.trim() === '') {
        parsed = { settings: {} }
      } else {
        const json = JSON.parse(text)
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          parsed = {
            settings: null,
            error: 'settings file must contain a JSON object',
          }
        } else {
          parsed = { settings: json as PartialAppConfig }
        }
      }
    } catch (err) {
      parsed = { settings: null, error: (err as Error).message }
    }
  }

  parseFileCache.set(filePath, { mtimeMs, parsed })
  return parsed
}

/** reset on settings write (see changeDetector → resetSettingsCache). */
export function resetSettingsCache(): void {
  parseFileCache.clear()
  resolvedCache.clear()
}

function mergeStringArray(
  current: readonly string[] | undefined,
  next: unknown[],
): string[] {
  const out = new Set(current ?? [])
  for (const value of next) {
    if (typeof value === 'string') out.add(value)
  }
  return [...out]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** True when a tier was explicitly configured (not merely a fallback clone). */
function tierExplicitlySet(
  config: AppConfig,
  tier: 'medium' | 'small',
): boolean {
  // Heuristic: after resolve, fallback clones share the same model id + baseURL
  // as their parent. We track explicit tiers on a WeakMap-less side channel via
  // comparing to large after each layer is imperfect; instead we stash flags.
  return Boolean((config as AppConfig & { _explicit?: Set<string> })._explicit?.has(tier))
}

function markExplicit(
  config: AppConfig,
  tier: 'medium' | 'small',
): void {
  const c = config as AppConfig & { _explicit?: Set<string> }
  if (!c._explicit) c._explicit = new Set()
  c._explicit.add(tier)
}

function applyLayer(config: AppConfig, layer: PartialAppConfig): void {
  const hasModels = isRecord(layer.models)
  if (hasModels) {
    const layerModels = layer.models as Record<string, unknown>
    if (isRecord(layerModels.medium)) markExplicit(config, 'medium')
    if (isRecord(layerModels.small)) markExplicit(config, 'small')

    // Only pass tiers that are being set this layer or were previously explicit,
    // so resolveModelProfiles can fall back medium/small → large.
    const modelsArg: Record<string, unknown> = {
      large: {
        ...profileToRecord(config.models.large),
        ...(isRecord(layerModels.large) ? layerModels.large : {}),
      },
    }
    if (isRecord(layerModels.medium) || tierExplicitlySet(config, 'medium')) {
      modelsArg.medium = {
        ...profileToRecord(config.models.medium),
        ...(isRecord(layerModels.medium) ? layerModels.medium : {}),
      }
    }
    if (isRecord(layerModels.small) || tierExplicitlySet(config, 'small')) {
      modelsArg.small = {
        ...profileToRecord(config.models.small),
        ...(isRecord(layerModels.small) ? layerModels.small : {}),
      }
    }

    config.models = resolveModelProfiles({ models: modelsArg })
  }

  if (layer.compaction && typeof layer.compaction === 'object') {
    Object.assign(config.compaction, layer.compaction)
  }

  if (layer.sessionMemory && typeof layer.sessionMemory === 'object') {
    Object.assign(config.sessionMemory, layer.sessionMemory)
  }

  if (layer.mcpServers && typeof layer.mcpServers === 'object') {
    config.mcpServers = {
      ...config.mcpServers,
      ...layer.mcpServers,
    }
  }

  if (layer.lspServers && typeof layer.lspServers === 'object') {
    config.lspServers = {
      ...config.lspServers,
      ...layer.lspServers,
    }
  }

  if (Array.isArray(layer.disabledTools)) {
    config.disabledTools = mergeStringArray(
      config.disabledTools,
      layer.disabledTools,
    )
  }
}

function resolveSettingsFromDisk(cwd: string): ResolvedSettings {
  const paths = resolveSettingsPaths(cwd)
  const config = cloneDefaults()
  const sources: SettingsSource[] = [
    { scope: 'user', path: paths.userPath, exists: false, applied: false },
    {
      scope: 'project',
      path: paths.projectPath,
      exists: false,
      applied: false,
    },
    { scope: 'local', path: paths.localPath, exists: false, applied: false },
  ]

  for (const source of sources) {
    source.exists = fileMtimeMs(source.path) > 0
    const { settings, error } = readSettingsFile(source.path)
    if (error) {
      source.error = error
      console.warn(`[settings] Failed to parse ${source.path}: ${error}`)
      continue
    }
    if (!settings) continue
    applyLayer(config, settings)
    source.applied = true
    console.log(
      `[settings] Loaded ${source.scope} settings from ${source.path}`,
    )
  }

  return {
    config,
    sources,
    ...paths,
  }
}

export function resolveSettings(cwd: string): ResolvedSettings {
  const cacheKey = path.resolve(cwd)
  const paths = resolveSettingsPaths(cwd)
  const mtimeKey = settingsMtimeKey([
    paths.userPath,
    paths.projectPath,
    paths.localPath,
  ])
  const cached = resolvedCache.get(cacheKey)
  if (cached && cached.mtimeKey === mtimeKey) return cached.result

  const result = resolveSettingsFromDisk(cwd)
  resolvedCache.set(cacheKey, { mtimeKey, result })
  return result
}

/**
 * Merge MCP servers from plugins plus settings files. Settings-level servers
 * win on name collision — a plugin shouldn't shadow user-configured servers.
 */
export function mergeMCPServers(
  pluginServers: Record<string, MCPServerConfig>,
  settingsServers: Record<string, MCPServerConfig>,
): Record<string, MCPServerConfig> {
  return { ...pluginServers, ...settingsServers }
}

/** Settings files + plugin MCP — used at runtime and by GET /settings. */
export async function resolveEffectiveSettings(
  cwd: string,
): Promise<EffectiveSettings> {
  const resolved = resolveSettings(cwd)
  const plugins = await loadPlugins(cwd)
  return {
    ...resolved,
    effectiveMcpServers: mergeMCPServers(
      plugins.mcpServers,
      resolved.config.mcpServers,
    ),
  }
}

function maskApiKey(key: string): string {
  return key.replace(/.(?=.{4})/g, '*')
}

function maskProfile<T extends { apiKey?: string }>(profile: T): T {
  if (!profile.apiKey) return profile
  return { ...profile, apiKey: maskApiKey(profile.apiKey) }
}

export function getSafeSettings(resolved: ResolvedSettings): AppConfig {
  const copy = structuredClone(resolved.config)
  copy.models = {
    large: maskProfile(copy.models.large),
    medium: maskProfile(copy.models.medium),
    small: maskProfile(copy.models.small),
  }
  return copy
}

/**
 * EditableSettingSource excludes read-only policy/flag sources.
 * In SSO mode user scope writes to the container home and is blocked.
 */
export function parseWritableScope(
  value: unknown,
  opts: { ssoMode: boolean },
): SettingsScope {
  const scope: SettingsScope =
    value === 'user' || value === 'local' || value === 'project'
      ? value
      : 'project'
  if (opts.ssoMode && scope === 'user') {
    throw new Error(
      'user scope is not writable in SSO mode; use project or local',
    )
  }
  return scope
}

function pathForScope(cwd: string, scope: SettingsScope): string {
  const paths = resolveSettingsPaths(cwd)
  if (scope === 'user') return paths.userPath
  if (scope === 'project') return paths.projectPath
  return paths.localPath
}

function readWritableSettings(filePath: string): Record<string, unknown> {
  const { settings, error } = readSettingsFile(filePath)
  if (error) throw new Error(`Failed to read ${filePath}: ${error}`)
  return settings ? structuredClone(settings) : {}
}

function writeSettingsFile(
  filePath: string,
  settings: Record<string, unknown>,
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + '\n')
  resetSettingsCache()
}

function mergePatch(
  target: Record<string, unknown>,
  patch: Partial<AppConfig>,
): Record<string, unknown> {
  const next = structuredClone(target)
  // Drop legacy top-level provider if present in on-disk settings.
  delete next.provider
  if (patch.models) {
    const models = isRecord(next.models) ? { ...next.models } : {}
    for (const tier of ['large', 'medium', 'small'] as const) {
      const tierPatch = (patch.models as ModelProfiles)[tier]
      if (!tierPatch) continue
      models[tier] = {
        ...((isRecord(models[tier]) ? models[tier] : {}) as Record<
          string,
          unknown
        >),
        ...profileToRecord(tierPatch),
      }
    }
    next.models = models
  }
  if (patch.compaction) {
    next.compaction = {
      ...((next.compaction as Record<string, unknown> | undefined) ?? {}),
      ...patch.compaction,
    }
  }
  if (patch.sessionMemory) {
    next.sessionMemory = {
      ...((next.sessionMemory as Record<string, unknown> | undefined) ?? {}),
      ...patch.sessionMemory,
    }
  }
  if (patch.mcpServers) {
    next.mcpServers = {
      ...((next.mcpServers as Record<string, unknown> | undefined) ?? {}),
      ...patch.mcpServers,
    }
  }
  if (patch.lspServers) {
    next.lspServers = {
      ...((next.lspServers as Record<string, unknown> | undefined) ?? {}),
      ...patch.lspServers,
    }
  }
  if (patch.disabledTools) {
    next.disabledTools = mergeStringArray(
      Array.isArray(next.disabledTools) ? (next.disabledTools as string[]) : [],
      patch.disabledTools,
    )
  }
  return next
}

export function patchSettings(
  cwd: string,
  scope: SettingsScope,
  patch: Partial<AppConfig>,
): ResolvedSettings {
  const filePath = pathForScope(cwd, scope)
  const existing = readWritableSettings(filePath)
  writeSettingsFile(filePath, mergePatch(existing, patch))
  return resolveSettings(cwd)
}

export function setMCPServer(
  cwd: string,
  scope: SettingsScope,
  name: string,
  config: MCPServerConfig | null,
): ResolvedSettings {
  const filePath = pathForScope(cwd, scope)
  const existing = readWritableSettings(filePath)
  const servers =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? { ...(existing.mcpServers as Record<string, MCPServerConfig>) }
      : {}
  if (config) servers[name] = config
  else delete servers[name]
  existing.mcpServers = servers
  writeSettingsFile(filePath, existing)
  return resolveSettings(cwd)
}
