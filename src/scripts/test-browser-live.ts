/**
 * Conformance suite against the isolated backend (a real Chrome we launch).
 *
 * Uses a throwaway user-data-dir so it never touches the profile the agent
 * keeps under ~/.ai-agent/browser.
 *
 * Run: npx tsx src/scripts/test-browser-live.ts
 * Add --headed to watch it happen.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createIsolatedBackend } from '../browser/backends/isolated.js'
import {
  runBrowserToolSuite,
  startFixtureServer,
} from './browser-tool-suite.js'

const HEADED = process.argv.includes('--headed')

async function main() {
  const server = await startFixtureServer()
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-live-'))

  try {
    await runBrowserToolSuite({
      label: 'isolated',
      baseUrl: server.url,
      sessionId: 'browser-live-test',
      showSnapshot: true,
      backendFactory: () =>
        createIsolatedBackend({
          userDataDir: profile,
          headless: !HEADED,
          viewport: { width: 1280, height: 800 },
        }),
    })
    console.log('\nall isolated-backend tests passed')
  } finally {
    await server.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
