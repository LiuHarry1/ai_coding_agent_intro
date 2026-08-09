/**
 * Per-user agent HOME (ALS) — dual-user isolation, fail-closed, settings dedupe.
 *   conda activate llm_ft && npx tsx src/scripts/test-agent-home.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  getAgentHome,
  getShellHome,
  runWithAgentHome,
} from '../utils/agent-home.js'
import { getAppDirName, getUserAppDir } from '../utils/app-dir.js'
import { getAutoMemPath } from '../services/auto-memory/paths.js'
import { prepareShellSpawn } from '../core/shell/spawn-shell.js'
import {
  parseWritableScope,
  resetSettingsCache,
  resolveSettings,
} from '../core/settings-manager.js'
import { canAccessSession, listSessions } from '../server/session.js'
import type { Session } from '../core/types.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const prevAuth = process.env.AUTH_ENABLED
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-'))

try {
  // ── AUTH off: OS home ──────────────────────────────────────────────────
  delete process.env.AUTH_ENABLED
  assert(
    getAgentHome() === os.homedir(),
    'AUTH off: getAgentHome should be os.homedir()',
  )
  assert(
    getUserAppDir() === path.join(os.homedir(), getAppDirName()),
    'AUTH off: getUserAppDir under OS home',
  )
  console.log('ok: AUTH off uses OS home')

  // ── AUTH on + no ALS: fail-closed ──────────────────────────────────────
  process.env.AUTH_ENABLED = 'true'
  let threw = false
  try {
    getAgentHome()
  } catch (e) {
    threw = true
    assert(
      (e as Error).message.includes('no agent home'),
      'fail-closed error should mention missing context',
    )
  }
  assert(threw, 'AUTH on without ALS must throw')
  console.log('ok: AUTH on without ALS fails closed')

  // ── Dual-user isolation ────────────────────────────────────────────────
  const alice = path.join(tmpRoot, 'alice')
  const bob = path.join(tmpRoot, 'bob')
  fs.mkdirSync(alice, { recursive: true })
  fs.mkdirSync(bob, { recursive: true })

  const aliceApp = runWithAgentHome(alice, () => getUserAppDir())
  const bobApp = runWithAgentHome(bob, () => getUserAppDir())
  assert(
    aliceApp === path.join(alice, getAppDirName()),
    `alice app=${aliceApp}`,
  )
  assert(bobApp === path.join(bob, getAppDirName()), `bob app=${bobApp}`)
  assert(aliceApp !== bobApp, 'users must not share app dir')

  const aliceMem = runWithAgentHome(alice, () =>
    getAutoMemPath({ cwd: alice }),
  )
  const bobMem = runWithAgentHome(bob, () => getAutoMemPath({ cwd: bob }))
  assert(aliceMem.startsWith(aliceApp), 'alice memory under alice app')
  assert(bobMem.startsWith(bobApp), 'bob memory under bob app')
  assert(aliceMem !== bobMem, 'memory paths must not cross')

  const aliceHomeEnv = runWithAgentHome(alice, () => {
    const prepared = prepareShellSpawn({
      shell: 'bash',
      userCommand: 'true',
    })
    return prepared.env.HOME
  })
  const bobHomeEnv = runWithAgentHome(bob, () => {
    const prepared = prepareShellSpawn({
      shell: 'bash',
      userCommand: 'true',
    })
    return prepared.env.HOME
  })
  assert(aliceHomeEnv === path.resolve(alice), `alice HOME=${aliceHomeEnv}`)
  assert(bobHomeEnv === path.resolve(bob), `bob HOME=${bobHomeEnv}`)

  // Concurrent ALS: nested / sequential stores do not leak
  const seen: string[] = []
  await Promise.all([
    runWithAgentHome(alice, async () => {
      await new Promise(r => setTimeout(r, 20))
      seen.push(getAgentHome())
    }),
    runWithAgentHome(bob, async () => {
      await new Promise(r => setTimeout(r, 5))
      seen.push(getAgentHome())
    }),
  ])
  assert(
    seen.includes(path.resolve(alice)) && seen.includes(path.resolve(bob)),
    `concurrent ALS leaked or missing: ${seen.join(',')}`,
  )
  console.log('ok: dual-user app-dir / memory / bash HOME isolated')

  // ── Settings: same path → single user source; SSO user writable ────────
  resetSettingsCache()
  fs.mkdirSync(path.join(alice, '.ai-agent'), { recursive: true })
  fs.writeFileSync(
    path.join(alice, '.ai-agent', 'settings.json'),
    JSON.stringify({
      autoMemoryEnabled: true,
      autoMemoryDirectory: path.join(alice, 'mem-custom'),
      disabledTools: ['web_fetch'],
    }) + '\n',
  )
  const resolved = runWithAgentHome(alice, () => resolveSettings(alice))
  assert(
    resolved.userPath === resolved.projectPath,
    'SSO cwd=home → userPath === projectPath',
  )
  const fileSources = resolved.sources.filter(
    s => s.scope === 'user' || s.scope === 'project',
  )
  assert(
    fileSources.length === 1 && fileSources[0]!.scope === 'user',
    `expected single user source, got ${fileSources.map(s => s.scope).join(',')}`,
  )
  assert(
    fileSources[0]!.applied,
    'collapsed user source should be applied',
  )
  assert(
    resolved.config.autoMemoryDirectory === path.join(alice, 'mem-custom'),
    'user-scope autoMemory.directory must not be stripped',
  )
  assert(
    parseWritableScope('user', { ssoMode: true }) === 'user',
    'SSO may write user scope',
  )
  console.log('ok: settings path collapse + SSO user writable')

  // ── getShellHome worker fallback (AUTH + pinned env HOME, no ALS) ─────
  const prevHome = process.env.HOME
  process.env.HOME = bob
  assert(
    getShellHome() === path.resolve(bob),
    'getShellHome falls back to pinned process.env.HOME',
  )
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  console.log('ok: getShellHome worker env fallback')

  // ── Super list ≠ owner HOME (ACL still request-scoped) ─────────────────
  // Session store is global; canAccessSession lets super view any owner.
  const fakeAliceSession = {
    id: 's-alice',
    ownerEmail: 'alice@example.com',
  } as Session
  assert(
    canAccessSession(fakeAliceSession, 'super@example.com', 'super'),
    'super may view another user session',
  )
  assert(
    !canAccessSession(fakeAliceSession, 'bob@example.com', 'user'),
    'peer user must not view alice session',
  )
  // listSessions(undefined) is the super "view all" path — just ensure callable
  const all = listSessions(undefined)
  assert(Array.isArray(all), 'listSessions(undefined) returns array')
  console.log('ok: super session ACL unchanged (view_all path)')

  console.log('\nAll agent-home checks passed.')
} finally {
  if (prevAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = prevAuth
  resetSettingsCache()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
