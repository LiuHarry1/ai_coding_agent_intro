import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AppConfig, LspServerConfig, MCPServerConfig } from './types.js'
import {
  DEFAULT_PROFILE,
  profileToRecord,
  resolveProfile,
} from './llm/index.js'
import { loadPlugins } from './plugins/index.js'
import {
  getAppDirName,
  LOCAL_SETTINGS_FILE_NAME,
  SETTINGS_FILE_NAME,
} from '../utils/app-dir.js'

export const DEFAULTS: AppConfig = {
  provider: { ...DEFAULT_PROFILE },
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
  provider: Record<string, unknown>
  compaction: Record<string, unknown>
  mcpServers: Record<string, MCPServerConfig>
  lspServers: Record<string, LspServerConfig>
  disabledTools: unknown[]
}>

type ParsedSettingsFile = {
  settings: PartialAppConfig | null
  error?: string
}

/** CC parity: path-keyed parse cache invalidated by resetSettingsCache(). */
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

/** CC parity: reset on settings write (see changeDetector → resetSettingsCache). */
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

function applyLayer(config: AppConfig, layer: PartialAppConfig): void {
  if (layer.provider && typeof layer.provider === 'object') {
    config.provider = resolveProfile({
      ...profileToRecord(config.provider),
      ...layer.provider,
    })
  }

  if (layer.compaction && typeof layer.compaction === 'object') {
    Object.assign(config.compaction, layer.compaction)
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

export function getSafeSettings(resolved: ResolvedSettings): AppConfig {
  const copy = structuredClone(resolved.config)
  if (copy.provider.apiKey) {
    copy.provider = {
      ...copy.provider,
      apiKey: copy.provider.apiKey.replace(/.(?=.{4})/g, '*'),
    }
  }
  return copy
}

/**
 * CC parity: EditableSettingSource excludes read-only policy/flag sources.
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
  if (patch.provider) {
    next.provider = {
      ...((next.provider as Record<string, unknown> | undefined) ?? {}),
      ...patch.provider,
    }
  }
  if (patch.compaction) {
    next.compaction = {
      ...((next.compaction as Record<string, unknown> | undefined) ?? {}),
      ...patch.compaction,
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
