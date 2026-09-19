/**
 * Normalize the `memory:` frontmatter key into a MemoryPolicy.
 *
 * Two surfaces collapse into one internal shape:
 *   - `memory: project`                      — CC short form (subagent parity)
 *   - `memory: { mode, scope, vocabulary }`  — extended form (primary + subagent)
 *
 * The object form defaults to `mode: private`, because `shared` is already the
 * behavior you get by omitting the key entirely.
 */
import type {
  AgentMemoryScope,
  MemoryPolicy,
  MemoryPolicyMode,
  MemoryVocabulary,
} from '../../core/types.js'

const SCOPES: readonly AgentMemoryScope[] = ['user', 'project', 'local']
const MODES: readonly MemoryPolicyMode[] = ['shared', 'private']
const VOCABULARIES: readonly MemoryVocabulary[] = ['coding', 'external']

const DEFAULT_SCOPE: AgentMemoryScope = 'project'
const DEFAULT_VOCABULARY: MemoryVocabulary = 'coding'

export function parseAgentMemoryScope(
  raw: unknown,
): AgentMemoryScope | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase()
  return SCOPES.find(s => s === v)
}

function parseMode(raw: unknown): MemoryPolicyMode | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase()
  return MODES.find(m => m === v)
}

function parseVocabulary(raw: unknown): MemoryVocabulary | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim().toLowerCase()
  return VOCABULARIES.find(x => x === v)
}

export type MemoryPolicyParseResult = {
  policy?: MemoryPolicy
  /** CC short-form scope, set only for a private policy. */
  scope?: AgentMemoryScope
  warnings: string[]
}

/**
 * Parse `memory:` for one agent. Returns no policy (and a warning) when the
 * value is present but unusable, so a typo never silently downgrades to shared.
 */
export function parseMemoryPolicy(raw: unknown): MemoryPolicyParseResult {
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { warnings }

  if (typeof raw === 'string') {
    const scope = parseAgentMemoryScope(raw)
    if (!scope) {
      warnings.push(
        `invalid memory '${raw}'. Valid: user, project, local, or an object with mode/scope/vocabulary`,
      )
      return { warnings }
    }
    return {
      policy: { mode: 'private', scope, vocabulary: DEFAULT_VOCABULARY },
      scope,
      warnings,
    }
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(
      `invalid memory value; expected a scope string or an object with mode/scope/vocabulary`,
    )
    return { warnings }
  }

  const fm = raw as Record<string, unknown>

  const mode = fm.mode === undefined ? 'private' : parseMode(fm.mode)
  if (!mode) {
    warnings.push(
      `invalid memory.mode '${String(fm.mode)}'. Valid: shared, private`,
    )
    return { warnings }
  }

  let scope = DEFAULT_SCOPE
  if (fm.scope !== undefined) {
    const parsed = parseAgentMemoryScope(fm.scope)
    if (!parsed) {
      warnings.push(
        `invalid memory.scope '${String(fm.scope)}'. Valid: user, project, local`,
      )
      return { warnings }
    }
    scope = parsed
  }

  let vocabulary = DEFAULT_VOCABULARY
  if (fm.vocabulary !== undefined) {
    const parsed = parseVocabulary(fm.vocabulary)
    if (!parsed) {
      warnings.push(
        `invalid memory.vocabulary '${String(fm.vocabulary)}'. Valid: coding, external`,
      )
      return { warnings }
    }
    vocabulary = parsed
  }

  const policy: MemoryPolicy = { mode, scope, vocabulary }
  return {
    policy,
    ...(mode === 'private' ? { scope } : {}),
    warnings,
  }
}
