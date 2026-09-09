/**
 * Index and search Playwright AI-snapshot YAML. No browser needed.
 */

export interface RefMeta {
  ref: string
  role: string
  name: string
}

const REF_LINE =
  /^\s*- (\S+)(?: "((?:\\.|[^"\\])*)")?.*\[ref=([^\]]+)\]/

export function parseRefMeta(yaml: string): RefMeta[] {
  const out: RefMeta[] = []
  if (!yaml) return out
  for (const line of yaml.split('\n')) {
    const m = REF_LINE.exec(line)
    if (!m) continue
    out.push({
      role: m[1],
      name: (m[2] ?? '').replace(/\\"/g, '"'),
      ref: m[3],
    })
  }
  return out
}

export function namesOverlap(a: string, b: string): boolean {
  const left = a.replace(/\s+/g, ' ').trim().toLowerCase()
  const right = b.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!left || !right) return false
  return left === right || left.includes(right) || right.includes(left)
}

const HINT_ROLES =
  'button|link|textbox|checkbox|radio|combobox|listbox|menuitem|option|slider|switch|tab'

/**
 * Cursor `parseExpectedDescription`: pull role/name out of the model's
 * `element` hint so a stale ref can be rematched on the live snapshot.
 */
export function parseExpectedDescription(description?: string): {
  role: string | null
  name: string | null
} {
  const raw = description?.replace(/\s+/g, ' ').trim()
  if (!raw) return { role: null, name: null }

  const lower = raw.toLowerCase()
  let role: string | null = null
  const roleMatch =
    lower.match(/role=["']?([^"',)]+)/) ??
    lower.match(new RegExp(`^(${HINT_ROLES})\\b`))
  if (roleMatch?.[1]) role = roleMatch[1].trim()

  let name: string | null = null
  const named =
    raw.match(/(?:aria-label|text|name)=["']?([^"']+)["']?/) ??
    raw.match(/["']([^"']+)["']/)
  if (named?.[1]) name = named[1].trim()
  if (!name) {
    name = raw
      .replace(new RegExp(`^(${HINT_ROLES})\\b`, 'i'), '')
      .replace(/\brole=["']?[^"',)]+/, '')
      .trim()
  }
  return { role, name: name || null }
}

/** Cursor `attemptRefRecovery` scoring. Threshold is 50. */
export function scoreRefMatch(
  candidate: RefMeta,
  expected: { role?: string | null; name?: string | null },
): { score: number; nameScore: number } {
  let score = 0
  let nameScore = 0
  const role = expected.role?.trim().toLowerCase()
  if (role && candidate.role.toLowerCase() === role) score += 50

  const expectedName = expected.name?.replace(/\s+/g, ' ').trim()
  const actual = candidate.name.replace(/\s+/g, ' ').trim()
  if (expectedName && actual) {
    const e = expectedName.toLowerCase()
    const a = actual.toLowerCase()
    if (a === e) nameScore = 50
    else if (namesOverlap(actual, expectedName)) nameScore = 50
    else if (a.includes(e) || e.includes(a)) nameScore = 25
    score += nameScore
  }
  return { score, nameScore }
}

/**
 * Pick a different snapshot ref whose role/name match the stale target.
 * Cursor requires score >= 50; if a name was given, also require a name hit.
 */
export function pickRecoveredRef(
  candidates: RefMeta[],
  opts: {
    oldRef: string
    role?: string | null
    name?: string | null
  },
): string | undefined {
  let best: RefMeta | undefined
  let bestScore = 0
  for (const candidate of candidates) {
    if (candidate.ref === opts.oldRef) continue
    const { score, nameScore } = scoreRefMatch(candidate, opts)
    if (opts.name && nameScore < 25) continue
    if (score < 50 || score <= bestScore) continue
    bestScore = score
    best = candidate
  }
  return best?.ref
}

/**
 * Cursor `assertDescriptionMatches` (cursor-browser-automation):
 * 1. If the hint contains "button", the live node must be a button
 *    (tag/role/description). ExtJS `table "Save"` is not a button — pass
 *    element: "Save", not "Save button".
 * 2. Strip `button|link|input|checkbox|radio`, split on whitespace, keep
 *    tokens longer than 2 chars, succeed if **any** token appears in the
 *    accessible name (`.some()`, not `.every()`).
 */
export function elementMatchesHint(
  described: { role: string; name: string; tag?: string },
  hint: string,
): boolean {
  const h = hint.replace(/\s+/g, ' ').trim()
  if (!h) return true
  const expectedLower = h.toLowerCase()
  const actualRole = described.role.replace(/\s+/g, ' ').trim().toLowerCase()
  const actualTag = (described.tag ?? '').toLowerCase()
  const actualText = described.name.replace(/\s+/g, ' ').trim().toLowerCase()
  const actualDescription = `${actualRole} "${actualText}"`

  const expectedMentionsButton = expectedLower.includes('button')
  const actualIsButton =
    actualTag === 'button' ||
    actualRole === 'button' ||
    actualDescription.includes('button')
  if (expectedMentionsButton && !actualIsButton) return false

  const expectedWords = expectedLower
    .replace(/button|link|input|checkbox|radio/g, '')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2)
  if (expectedWords.length > 0 && actualText) {
    return expectedWords.some(word => actualText.includes(word))
  }
  return true
}

export function filterSnapshotLines(yaml: string, query: string): string {
  const q = query.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!q || !yaml) return ''
  return yaml
    .split('\n')
    .filter(line => line.toLowerCase().includes(q))
    .join('\n')
}

/**
 * Line-level diff of two snapshots. Added/removed only; context is the
 * matching ref lines so the model can still click.
 */
export function snapshotDiff(previous: string, next: string): string {
  const prev = new Set(previous.split('\n').filter(Boolean))
  const cur = next.split('\n').filter(Boolean)
  const added: string[] = []
  const removed: string[] = []
  const curSet = new Set(cur)
  for (const line of cur) {
    if (!prev.has(line)) added.push(line)
  }
  for (const line of previous.split('\n').filter(Boolean)) {
    if (!curSet.has(line)) removed.push(line)
  }
  if (added.length === 0 && removed.length === 0) {
    return 'No snapshot changes since the last capture.'
  }
  const parts: string[] = []
  if (removed.length) {
    parts.push(`Removed (${removed.length}):\n${removed.slice(0, 80).join('\n')}`)
  }
  if (added.length) {
    parts.push(`Added (${added.length}):\n${added.slice(0, 80).join('\n')}`)
  }
  return parts.join('\n\n')
}
