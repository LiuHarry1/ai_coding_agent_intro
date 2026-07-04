import * as fs from 'fs'
import * as path from 'path'
import type { AppConfig } from './types.js'
import {
  DEFAULT_PROFILE,
  resolveProfile,
  profileToRecord,
} from './llm/index.js'
import { getUserConfigPath, CONFIG_FILE_NAME } from '../utils/app-dir.js'

const DEFAULTS: AppConfig = {
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
  disabledTools: [],
}

type ConfigKey = keyof AppConfig
type ConfigListener = () => void

export class ConfigManager {
  #config: AppConfig = structuredClone(DEFAULTS)
  #userConfigPath: string
  #listeners = new Map<string, Set<ConfigListener>>()

  constructor(userConfigDir?: string) {
    this.#userConfigPath =
      userConfigDir != null
        ? path.join(userConfigDir, CONFIG_FILE_NAME)
        : getUserConfigPath()
  }

  /** Load user config from disk and merge over defaults. */
  load(): void {
    this.#config = structuredClone(DEFAULTS)

    if (!fs.existsSync(this.#userConfigPath)) {
      console.log(
        `[config] No user config at ${this.#userConfigPath}, using defaults.`,
      )
      return
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.#userConfigPath, 'utf-8'))
      if (raw.provider) {
        this.#config.provider = resolveProfile({
          ...profileToRecord(DEFAULT_PROFILE),
          ...(raw.provider as object),
        })
      }
      if (raw.compaction) {
        const deprecated = [
          'threshold',
          'keepRecent',
          'minMessages',
          'tokenThreshold',
          'microCompactThreshold',
          'tailTokenBudget',
          'model',
        ].filter(k => k in raw.compaction)
        if (deprecated.length > 0) {
          console.warn(
            `[config] compaction.${deprecated.join('/')} is deprecated. ` +
              `Use contextWindow / microCompactKeepRecent / maxFilesToRestore / fileBudget instead. Ignored.`,
          )
          for (const k of deprecated) delete raw.compaction[k]
        }
        Object.assign(this.#config.compaction, raw.compaction)
      }
      if (raw.mcpServers && typeof raw.mcpServers === 'object') {
        this.#config.mcpServers = raw.mcpServers
      }
      if (Array.isArray(raw.disabledTools)) {
        this.#config.disabledTools = raw.disabledTools.filter(
          (x: unknown) => typeof x === 'string',
        )
      }
      console.log(`[config] Loaded user config from ${this.#userConfigPath}`)
    } catch (err: any) {
      console.warn(
        `[config] Failed to parse ${this.#userConfigPath}: ${err.message}`,
      )
    }
  }

  get<K extends ConfigKey>(key: K): AppConfig[K] {
    return this.#config[key]
  }

  getAll(): AppConfig {
    return structuredClone(this.#config)
  }

  /** Returns config safe to send to the client (apiKey masked). */
  getSafe(): AppConfig {
    const copy = this.getAll()
    if (copy.provider.apiKey) {
      copy.provider = {
        ...copy.provider,
        apiKey: copy.provider.apiKey.replace(/.(?=.{4})/g, '*'),
      }
    }
    return copy
  }

  set<K extends ConfigKey>(key: K, value: AppConfig[K]): void {
    if (key === 'provider') {
      this.#config.provider = resolveProfile(value as object)
    } else {
      this.#config[key] = value
    }
    this.#persist()
    this.#notify(key)
  }

  /** Partially update a section (e.g. only change baseURL in provider). */
  patch<K extends ConfigKey>(key: K, partial: Partial<AppConfig[K]>): void {
    if (key === 'provider') {
      this.#config.provider = resolveProfile({
        ...profileToRecord(this.#config.provider),
        ...(partial as object),
      })
    } else if (
      typeof this.#config[key] === 'object' &&
      !Array.isArray(this.#config[key])
    ) {
      Object.assign(this.#config[key] as Record<string, unknown>, partial)
    } else {
      this.#config[key] = partial as AppConfig[K]
    }
    this.#persist()
    this.#notify(key)
  }

  onChange(key: string, fn: ConfigListener): () => void {
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set())
    this.#listeners.get(key)!.add(fn)
    return () => this.#listeners.get(key)?.delete(fn)
  }

  get configPath(): string {
    return this.#userConfigPath
  }

  // ── Private ──

  #persist(): void {
    const dir = path.dirname(this.#userConfigPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    // Only write fields that differ from defaults
    const delta: Record<string, unknown> = {}
    if (
      JSON.stringify(this.#config.provider) !==
      JSON.stringify(DEFAULTS.provider)
    ) {
      delta.provider = this.#config.provider
    }
    if (
      JSON.stringify(this.#config.compaction) !==
      JSON.stringify(DEFAULTS.compaction)
    ) {
      delta.compaction = this.#config.compaction
    }
    if (Object.keys(this.#config.mcpServers).length > 0) {
      delta.mcpServers = this.#config.mcpServers
    }
    const defaultDisabled = DEFAULTS.disabledTools ?? []
    if (
      JSON.stringify(this.#config.disabledTools ?? []) !==
      JSON.stringify(defaultDisabled)
    ) {
      delta.disabledTools = this.#config.disabledTools
    }
    fs.writeFileSync(
      this.#userConfigPath,
      JSON.stringify(delta, null, 2) + '\n',
    )
  }

  #notify(key: string): void {
    for (const fn of this.#listeners.get(key) ?? []) {
      try {
        fn()
      } catch {}
    }
  }
}

export const configManager = new ConfigManager()
