/**
 * Managed (policy) paths.
 *
 * Layout (Linux default):
 *
 *   /etc/ai-agent/
 *     managed-settings.json
 *     managed-settings.d/
 *     AGENTS.md | CLAUDE.md
 *     .ai-agent/
 *       skills/ commands/ agents/ rules/
 *
 * Never under user HOME / getUserAppDir().
 */
import { join } from 'path'
import {
  getAppDirName,
  getProjectAppDir,
  getUserAppDir,
  getUserSubdir,
  type AppSubdir,
} from './app-dir.js'

/** Filename for the base managed settings file. */
export const MANAGED_SETTINGS_FILE_NAME = 'managed-settings.json'

/** Drop-in directory basename. */
export const MANAGED_SETTINGS_DROPIN_DIRNAME = 'managed-settings.d'

/** Preferred managed memory filename. */
export const MANAGED_AGENTS_MD_FILE_NAME = 'AGENTS.md'

/** Alternate managed memory filename — also accepted as an alias. */
export const MANAGED_CLAUDE_MD_FILE_NAME = 'CLAUDE.md'

/** Subdirs under `{managed}/.ai-agent/`. */
export type ManagedAppSubdir = AppSubdir | 'rules'

/** Disk scopes for extension directories. */
export type ExtensionDirSource = 'managed' | 'user' | 'project'

let cachedManagedDir: string | undefined

/**
 * Override for tests: we always honor AI_AGENT_MANAGED_DIR.
 */
export function getManagedDir(): string {
  const override = process.env.AI_AGENT_MANAGED_DIR?.trim()
  if (override) return override

  if (cachedManagedDir !== undefined) return cachedManagedDir

  switch (process.platform) {
    case 'darwin':
      cachedManagedDir = '/Library/Application Support/AiAgent'
      break
    case 'win32':
      cachedManagedDir = 'C:\\Program Files\\AiAgent'
      break
    default:
      cachedManagedDir = '/etc/ai-agent'
      break
  }
  return cachedManagedDir
}

/** Absolute path to managed-settings.json */
export function getManagedSettingsPath(): string {
  return join(getManagedDir(), MANAGED_SETTINGS_FILE_NAME)
}

/** Absolute path to managed-settings.d/ */
export function getManagedSettingsDropInDir(): string {
  return join(getManagedDir(), MANAGED_SETTINGS_DROPIN_DIRNAME)
}

/**
 * Managed app dir — `join(getManagedDir(), getAppDirName())`,
 * e.g. `/etc/ai-agent/.ai-agent`.
 */
export function getManagedAppDir(): string {
  return join(getManagedDir(), getAppDirName())
}

/** Absolute path to `{managed}/.ai-agent/<kind>`. */
export function getManagedSubdir(kind: ManagedAppSubdir): string {
  return join(getManagedAppDir(), kind)
}

/** Absolute path to the managed rules directory. */
export function getManagedRulesDir(): string {
  return getManagedSubdir('rules')
}

/** Preferred managed memory path (`AGENTS.md`). */
export function getManagedAgentsMdPath(): string {
  return join(getManagedDir(), MANAGED_AGENTS_MD_FILE_NAME)
}

/**
 * Candidate managed memory files in load order (first existing wins).
 * We prefer `AGENTS.md`, then `CLAUDE.md`.
 */
export function getManagedMemoryEntryPaths(): string[] {
  const root = getManagedDir()
  return [
    join(root, MANAGED_AGENTS_MD_FILE_NAME),
    join(root, MANAGED_CLAUDE_MD_FILE_NAME),
  ]
}

/**
 * Resolver for extension directories (skills / agents / commands / rules).
 *
 * - managed → `{managedDir}/.ai-agent/<kind>`
 * - user → `~/.ai-agent/<kind>` (rules: `~/.ai-agent/rules`)
 * - project → `<projectRoot>/.ai-agent/<kind>` (`projectRoot` = workspace ancestor)
 */
export function getExtensionDir(
  source: ExtensionDirSource,
  kind: ManagedAppSubdir,
  projectRoot?: string,
): string {
  switch (source) {
    case 'managed':
      return getManagedSubdir(kind)
    case 'user':
      if (kind === 'rules') return join(getUserAppDir(), 'rules')
      return getUserSubdir(kind)
    case 'project': {
      if (!projectRoot?.trim()) {
        throw new Error('getExtensionDir(project) requires projectRoot')
      }
      return join(getProjectAppDir(projectRoot), kind)
    }
  }
}

/**
 * Honors `CLAUDE_CODE_DISABLE_POLICY_SKILLS` to skip managed skills discovery.
 */
export function isPolicySkillsDisabled(): boolean {
  const v = process.env.CLAUDE_CODE_DISABLE_POLICY_SKILLS
  if (v === undefined || v === '') return false
  const lower = v.trim().toLowerCase()
  return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on'
}

/** Test helper — clear memo when AI_AGENT_MANAGED_DIR changes between cases. */
export function _resetManagedDirCacheForTest(): void {
  cachedManagedDir = undefined
}
