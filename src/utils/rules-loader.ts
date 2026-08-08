import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { normalizeGitPath } from '../core/platform.js'
import { getAppDirName, getUserAppDir } from './app-dir.js'
import {
  getExtensionDir,
  getManagedDir,
  getManagedMemoryEntryPaths,
} from './managed-path.js'

/**
 * Instructions loader (CC memory + rules, with managed policy layer).
 *
 *   {managed}/AGENTS.md (+ {managed}/.ai-agent/rules/)  — policy (first)
 *   ~/.ai-agent/AGENTS.md (+ rules/)                    — user
 *   AGENTS.md | {appDir}/AGENTS.md | {appDir}/rules/      — project
 *   AGENTS.local.md                                       — local (highest among project)
 *
 * Walk cwd → git root; closer files load later (higher model priority).
 */

/** Single entry file per directory (repo root or nested package). */
const ENTRY_FILENAMES = ['AGENTS.md']
const LOCAL_ENTRY_FILENAMES = ['AGENTS.local.md']

const MAX_SINGLE_FILE_BYTES = 40 * 1024
const MAX_RULES_BYTES = 40 * 1024

function findGitRoot(dir: string): string | null {
  try {
    const raw = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return normalizeGitPath(raw)
  } catch {
    return null
  }
}

function findRuleFile(dir: string, names: string[]): string | null {
  for (const name of names) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

interface RuleSource {
  dir: string
  label: string
  content: string
}

function readRuleFile(absPath: string): string | null {
  try {
    const raw = fs.readFileSync(absPath, 'utf-8').trim()
    if (raw.length === 0) return null
    if (Buffer.byteLength(raw, 'utf-8') > MAX_SINGLE_FILE_BYTES) {
      return (
        raw.slice(0, MAX_SINGLE_FILE_BYTES) +
        '\n\n[...truncated — single rule file exceeded per-file cap]'
      )
    }
    return raw
  } catch {
    return null
  }
}

/** One-level .md files under a rules directory, sorted by name. */
function collectRulesDir(
  projectDir: string,
  rulesDir: string,
  labelPrefix: string,
): RuleSource[] {
  const out: RuleSource[] = []
  if (!fs.existsSync(rulesDir) || !fs.statSync(rulesDir).isDirectory()) {
    return out
  }
  let entries: string[]
  try {
    entries = fs.readdirSync(rulesDir).sort()
  } catch {
    return out
  }
  for (const name of entries) {
    if (!/\.md$/i.test(name)) continue
    const abs = path.join(rulesDir, name)
    try {
      if (!fs.statSync(abs).isFile()) continue
    } catch {
      continue
    }
    const content = readRuleFile(abs)
    if (content !== null) {
      out.push({
        dir: projectDir,
        label: `${labelPrefix}/${name}`,
        content,
      })
    }
  }
  return out
}

function collectAppDirRules(projectDir: string): RuleSource[] {
  const appDir = getAppDirName()
  const out: RuleSource[] = []

  // App-dir AGENTS.md → {appDir}/AGENTS.md
  const nested = findRuleFile(path.join(projectDir, appDir), ENTRY_FILENAMES)
  if (nested) {
    const content = readRuleFile(nested)
    if (content !== null) {
      out.push({
        dir: projectDir,
        label: `${appDir}/${path.basename(nested)}`,
        content,
      })
    }
  }

  // Topic rules under {appDir}/rules/
  out.push(
    ...collectRulesDir(
      projectDir,
      path.join(projectDir, appDir, 'rules'),
      `${appDir}/rules`,
    ),
  )

  // Local overrides (same directory, higher priority when reversed later)
  const localNested = findRuleFile(
    path.join(projectDir, appDir),
    LOCAL_ENTRY_FILENAMES,
  )
  if (localNested) {
    const content = readRuleFile(localNested)
    if (content !== null) {
      out.push({
        dir: projectDir,
        label: `${appDir}/${path.basename(localNested)}`,
        content,
      })
    }
  }

  return out
}

function formatRuleSources(
  sources: RuleSource[],
  scopeLabel: string,
): string {
  if (sources.length === 0) return ''
  return sources
    .map(s =>
      sources.length === 1
        ? s.content
        : `<!-- from ${scopeLabel}:${s.label} -->\n${s.content}`,
    )
    .join('\n\n')
}

/**
 * Managed / policy rules — CC `getMemoryPath('Managed')` + `getManagedClaudeRulesDir`.
 * Root entry: `{managed}/AGENTS.md`, else `{managed}/CLAUDE.md` (CC name).
 */
export function loadManagedRules(): string {
  const sources: RuleSource[] = []
  const managedRoot = getManagedDir()
  for (const entryPath of getManagedMemoryEntryPaths()) {
    if (fs.existsSync(entryPath) && fs.statSync(entryPath).isFile()) {
      const content = readRuleFile(entryPath)
      if (content !== null) {
        sources.push({
          dir: managedRoot,
          label: path.basename(entryPath),
          content,
        })
      }
      break
    }
  }
  const rulesDir = getExtensionDir('managed', 'rules')
  sources.push(...collectRulesDir(managedRoot, rulesDir, 'rules'))
  return formatRuleSources(sources, 'managed')
}

/** User-scope rules: ~/.ai-agent/AGENTS.md + ~/.ai-agent/rules/*.md */
export function loadUserRules(): string {
  const userDir = getUserAppDir()
  const sources: RuleSource[] = []
  const entry = findRuleFile(userDir, ENTRY_FILENAMES)
  if (entry) {
    const content = readRuleFile(entry)
    if (content !== null) {
      sources.push({ dir: userDir, label: path.basename(entry), content })
    }
  }
  sources.push(
    ...collectRulesDir(userDir, path.join(userDir, 'rules'), 'rules'),
  )
  return formatRuleSources(sources, 'user')
}

/**
 * Load project agent instructions for `cwd`.
 * Prefer colocating under `{appDir}/AGENTS.md`; root `AGENTS.md` also works
 * (agents.md standard / monorepo packages). Includes AGENTS.local.md.
 */
export function loadProjectRules(cwd: string): string {
  const absDir = path.resolve(cwd)
  const ceiling = findGitRoot(absDir) || path.parse(absDir).root

  const sources: RuleSource[] = []
  let cur = absDir

  while (true) {
    const single = findRuleFile(cur, ENTRY_FILENAMES)
    if (single) {
      const content = readRuleFile(single)
      if (content !== null) {
        sources.push({ dir: cur, label: path.basename(single), content })
      }
    }
    sources.push(...collectAppDirRules(cur))

    const local = findRuleFile(cur, LOCAL_ENTRY_FILENAMES)
    if (local) {
      const content = readRuleFile(local)
      if (content !== null) {
        sources.push({ dir: cur, label: path.basename(local), content })
      }
    }

    if (cur === ceiling || cur === path.dirname(cur)) break
    cur = path.dirname(cur)
  }

  if (sources.length === 0) return ''

  sources.reverse()

  let combined = sources
    .map(s => {
      if (sources.length === 1) return s.content
      const relDir = path.relative(path.resolve(cwd), s.dir) || '.'
      const header = relDir === '.' ? s.label : `${relDir}/${s.label}`
      return `<!-- from ${header} -->\n${s.content}`
    })
    .join('\n\n')

  if (Buffer.byteLength(combined, 'utf-8') > MAX_RULES_BYTES) {
    combined =
      combined.slice(0, MAX_RULES_BYTES) +
      '\n\n[...truncated — combined rules exceeded cap]'
  }

  return combined
}

/** Managed → user → project/local (closer project overrides among itself). */
export function loadAllAgentRules(cwd: string): string {
  const parts = [
    loadManagedRules(),
    loadUserRules(),
    loadProjectRules(cwd),
  ].filter(s => s.trim())
  if (parts.length === 0) return ''
  let combined = parts.join('\n\n')
  if (Buffer.byteLength(combined, 'utf-8') > MAX_RULES_BYTES) {
    combined =
      combined.slice(0, MAX_RULES_BYTES) +
      '\n\n[...truncated — combined rules exceeded cap]'
  }
  return combined
}

export function hasRulesFile(cwd: string): boolean {
  const abs = path.resolve(cwd)
  if (findRuleFile(abs, ENTRY_FILENAMES) !== null) return true
  return collectAppDirRules(abs).length > 0
}
