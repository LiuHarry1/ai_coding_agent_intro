/**
 * Quick unit checks for core/sandbox.ts (run via tsx).
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  assertAccessible,
  assertAccessibleResolved,
  createSandboxPolicy,
  resolveSandboxMode,
} from '../core/sandbox.js'

function expectThrow(fn: () => void, label: string) {
  try {
    fn()
    throw new Error(`EXPECTED_THROW: ${label}`)
  } catch (e) {
    if ((e as Error).message.startsWith('EXPECTED_THROW')) throw e
  }
}

const prevMode = process.env.SANDBOX_MODE
const prevAuth = process.env.AUTH_ENABLED

try {
  process.env.SANDBOX_MODE = 'off'
  process.env.AUTH_ENABLED = ''
  if (resolveSandboxMode() !== 'off') throw new Error('mode off failed')

  process.env.SANDBOX_MODE = 'strict'
  if (resolveSandboxMode() !== 'strict') throw new Error('mode strict failed')

  process.env.SANDBOX_MODE = ''
  process.env.AUTH_ENABLED = 'true'
  if (resolveSandboxMode() !== 'strict') throw new Error('auth implies strict')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'))
  const inside = path.join(root, 'a.txt')
  const outside = path.join(root, '..', 'outside-sibling.txt')
  fs.writeFileSync(inside, 'ok')

  process.env.SANDBOX_MODE = 'strict'
  const policy = createSandboxPolicy(root)

  assertAccessible(inside, policy, 'read')
  assertAccessible(inside, policy, 'write')
  expectThrow(
    () => assertAccessible(outside, policy, 'read'),
    'strict read outside',
  )
  expectThrow(
    () => assertAccessible(outside, policy, 'write'),
    'strict write outside',
  )

  process.env.SANDBOX_MODE = 'off'
  const loose = createSandboxPolicy(root)
  assertAccessible(outside, loose, 'read')
  expectThrow(
    () => assertAccessible(outside, loose, 'write'),
    'off write outside',
  )

  // Symlink escape
  process.env.SANDBOX_MODE = 'strict'
  const strict = createSandboxPolicy(root)
  const link = path.join(root, 'escape-link')
  const targetOutside = path.join(os.tmpdir(), `sbx-target-${Date.now()}.txt`)
  fs.writeFileSync(targetOutside, 'secret')
  try {
    fs.symlinkSync(targetOutside, link)
    expectThrow(
      () => assertAccessibleResolved(link, strict, 'read'),
      'symlink realpath',
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') {
      console.log('skip symlink test (EPERM on this platform)')
    } else {
      throw e
    }
  } finally {
    try {
      fs.unlinkSync(link)
    } catch {}
    try {
      fs.unlinkSync(targetOutside)
    } catch {}
  }

  console.log('sandbox tests OK')
} finally {
  if (prevMode === undefined) delete process.env.SANDBOX_MODE
  else process.env.SANDBOX_MODE = prevMode
  if (prevAuth === undefined) delete process.env.AUTH_ENABLED
  else process.env.AUTH_ENABLED = prevAuth
}
