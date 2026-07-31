/**
 * Regression: workspace root must be "inside" itself for Worker assertInWorkspace.
 * Run: npx tsx src/scripts/test-worker-in-workspace.ts
 */
import assert from 'node:assert/strict'
import * as path from 'path'
import { WorkerExecutionBackend } from '../execution/worker-execution-backend.js'
import type { RuntimePort } from '../execution/types.js'

const noopRuntime = {
  workspace: { environmentId: 'local', cwd: process.cwd() },
  send() {},
  onMessage() {
    return () => {}
  },
  interrupt() {},
  async close() {},
  async health() {
    return 'ok' as const
  },
} as RuntimePort

const cwd = path.resolve(process.cwd())
const backend = new WorkerExecutionBackend(
  'local',
  noopRuntime,
  'local',
  cwd,
)

backend.assertInWorkspace(cwd, cwd, 'read')
backend.assertInWorkspace(cwd, path.join(cwd, 'src'), 'read')

assert.throws(
  () =>
    backend.assertInWorkspace(
      cwd,
      path.resolve(cwd, '..', 'outside-sibling'),
      'read',
    ),
  /outside the workspace/,
)

// posix style: root equals target
const posix = new WorkerExecutionBackend(
  'remote-test',
  noopRuntime,
  'posix',
  '/home/u/proj',
)
posix.assertInWorkspace('/home/u/proj', '/home/u/proj', 'read')
posix.assertInWorkspace('/home/u/proj', '/home/u/proj/src', 'read')
assert.throws(
  () => posix.assertInWorkspace('/home/u/proj', '/home/other', 'read'),
  /outside the workspace/,
)

console.log('ok worker in-workspace (root + child + outside)')
