/**
 * Live, browser-driven Coding Agent Web UI E2E.
 *
 * This test spends real model tokens and is therefore opt-in:
 *   $env:RUN_CODING_TOOLS_E2E = '1'
 *   $env:CODING_TOOLS_E2E_PROMPT = 'Use coding tools to ...'
 *   npx tsx src/scripts/test-coding-tools-ui-e2e.ts
 *
 * Start the services first (in separate terminals):
 *   npm start
 *   npm run dev:web
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { findChrome } from '../browser/chrome-path.js'

const REPLAY_SESSION_ID =
  process.env.CODING_TOOLS_E2E_REPLAY_SESSION?.trim() ?? ''
const ENABLED =
  process.env.RUN_CODING_TOOLS_E2E === '1' || Boolean(REPLAY_SESSION_ID)
const UI_URL = process.env.CODING_TOOLS_UI_URL ?? 'http://localhost:5173'
const AGENT_URL =
  process.env.CODING_TOOLS_AGENT_URL ?? 'http://localhost:4567'
const PROMPT = process.env.CODING_TOOLS_E2E_PROMPT?.trim() ?? ''
const TIMEOUT_MS = parsePositiveInt(
  process.env.CODING_TOOLS_E2E_TIMEOUT_MS,
  5 * 60_000,
)
const HEADED = process.env.CODING_TOOLS_E2E_HEADED === '1'
const ARTIFACT_DIR =
  process.env.CODING_TOOLS_E2E_ARTIFACT_DIR ??
  path.join(os.tmpdir(), 'coding-tools-ui-e2e')
const EXPECTED_TOOLS = (process.env.CODING_TOOLS_E2E_EXPECTED_TOOLS ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const EXPECTED_CARDS = (process.env.CODING_TOOLS_E2E_EXPECTED_CARDS ?? '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received "${value}"`)
  }
  return parsed
}

function endpoint(base: string, pathname: string): string {
  return new URL(pathname.replace(/^\//, ''), `${base.replace(/\/+$/, '')}/`)
    .href
}

async function requireReachable(
  label: string,
  url: string,
  expectHtml = false,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  } catch (error) {
    throw new Error(
      `${label} is not reachable at ${url}. Start it before running this test.`,
      { cause: error },
    )
  }
  assert.ok(response.ok, `${label} returned HTTP ${response.status} at ${url}`)
  if (expectHtml) {
    const contentType = response.headers.get('content-type') ?? ''
    assert.match(
      contentType,
      /text\/html/i,
      `${label} did not return HTML at ${url}`,
    )
  }
}

function joinWorkspacePath(root: string, child: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${child}`
}

async function api<T>(
  page: Page,
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  return page.evaluate(
    async ({ requestUrl, requestInit }) => {
      const response = await fetch(requestUrl, {
        method: requestInit?.method,
        headers:
          requestInit?.body === undefined
            ? undefined
            : { 'Content-Type': 'application/json' },
        body:
          requestInit?.body === undefined
            ? undefined
            : JSON.stringify(requestInit.body),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(
          `${requestInit?.method ?? 'GET'} ${requestUrl}: HTTP ${response.status} ${text}`,
        )
      }
      return text ? JSON.parse(text) : null
    },
    { requestUrl: url, requestInit: init },
  ) as Promise<T>
}

async function useTemporaryWorkspace(
  page: Page,
): Promise<{ name: string; workspace: string }> {
  const { workspace: root } = await api<{ workspace: string }>(
    page,
    endpoint(UI_URL, 'workspace'),
  )
  assert.ok(root, 'GET /workspace did not return a workspace root')

  const name = `coding-tools-ui-e2e-${Date.now()}-${process.pid}`
  const workspace = joinWorkspacePath(root, name)
  await api(page, endpoint(UI_URL, 'workspace/mkdir'), {
    method: 'POST',
    body: { path: workspace },
  })

  const chip = page.locator('.workspace-chip').first()
  await chip.click()
  const entry = page.locator('.workspace-dropdown .ws-entry', {
    hasText: name,
  })
  await entry.waitFor({ state: 'visible' })
  await entry.click()
  await page.locator('.workspace-dropdown .ws-open-btn').click()
  await page.waitForFunction(
    expected =>
      document.querySelector('.workspace-chip')?.getAttribute('title') ===
      expected,
    workspace,
  )

  return { name, workspace }
}

async function createFreshSession(page: Page): Promise<string> {
  const oldSessionId = await page.evaluate(() =>
    localStorage.getItem('coding_agent_session_id'),
  )
  await page.locator('.session-icon-btn').click()
  await page.getByRole('button', { name: 'New session' }).click()
  await page.waitForFunction(
    previous => {
      const current = localStorage.getItem('coding_agent_session_id')
      return Boolean(current && current !== previous)
    },
    oldSessionId,
  )
  const sessionId = await page.evaluate(() =>
    localStorage.getItem('coding_agent_session_id'),
  )
  assert.ok(sessionId, 'New session did not persist its id')
  return sessionId
}

async function toolCardSummaries(page: Page): Promise<string[]> {
  return page
    .locator(
      '.tool-row > .tool-row-header, .file-change-card > .file-change-header, .file-change-stub > .file-change-stub-row',
    )
    .evaluateAll(nodes =>
      nodes
        .map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    )
}

async function removeTemporaryWorkspace(
  page: Page,
  workspace: string,
): Promise<void> {
  await api(
    page,
    `${endpoint(UI_URL, 'workspace/entry')}?path=${encodeURIComponent(workspace)}`,
    { method: 'DELETE' },
  )
}

async function run(): Promise<void> {
  if (!ENABLED) {
    console.log(
      'skip coding-tools UI E2E (set RUN_CODING_TOOLS_E2E=1 to run the paid live-model test)',
    )
    return
  }

  if (!REPLAY_SESSION_ID) {
    assert.ok(
      PROMPT,
      'CODING_TOOLS_E2E_PROMPT is required and must instruct the real model to use at least one coding tool',
    )
  }
  await Promise.all([
    requireReachable('Coding Agent backend', endpoint(AGENT_URL, 'health')),
    requireReachable('Vite Web UI', UI_URL, true),
    requireReachable('Vite-to-agent proxy', endpoint(UI_URL, 'health')),
  ])

  const executablePath =
    process.env.CODING_TOOLS_E2E_CHROME_PATH ?? findChrome()
  assert.ok(
    executablePath,
    'System Chrome was not found. Set CODING_TOOLS_E2E_CHROME_PATH or CHROME_PATH.',
  )
  assert.ok(
    fs.existsSync(executablePath),
    `Chrome executable does not exist: ${executablePath}`,
  )

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  const browser = await chromium.launch({
    executablePath,
    headless: !HEADED,
  })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  })
  await context.tracing.start({ screenshots: true, snapshots: true })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const browserErrors: string[] = []
  const chatSseChunks: string[] = []
  const chatSseCaptures: Promise<void>[] = []
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('response', response => {
    if (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/chat'
    ) {
      chatSseCaptures.push(
        response
          .text()
          .then(text => {
            chatSseChunks.push(text)
          })
          .catch(error => {
            browserErrors.push(`Could not capture /chat SSE: ${String(error)}`)
          }),
      )
    }
  })

  let temporaryWorkspace: string | undefined
  let sessionId: string | undefined
  let passed = false
  try {
    await page.goto(UI_URL, { waitUntil: 'domcontentloaded' })
    await page.locator('.input-textarea').waitFor({ state: 'visible' })

    if (REPLAY_SESSION_ID) {
      sessionId = REPLAY_SESSION_ID
      await page.evaluate(id => {
        localStorage.setItem('coding_agent_session_id', id)
      }, sessionId)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('.input-textarea').waitFor({ state: 'visible' })
      await page.waitForFunction(
        expected => localStorage.getItem('coding_agent_session_id') === expected,
        sessionId,
      )
      await page.locator('.messages[aria-busy="true"]').waitFor({
        state: 'detached',
        timeout: 30_000,
      }).catch(() => {})
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            '.tool-row > .tool-row-header, .file-change-card > .file-change-header, .file-change-stub > .file-change-stub-row',
          ).length > 0,
        undefined,
        { timeout: 30_000 },
      )

      const cards = await toolCardSummaries(page)
      assert.ok(cards.length > 0, 'The replayed session has no coding tool cards')
      for (const expected of EXPECTED_CARDS) {
        assert.ok(
          cards.some(card =>
            card.toLowerCase().includes(expected.toLowerCase()),
          ),
          `Replayed session is missing tool card "${expected}"`,
        )
      }
      const reactErrors = browserErrors.filter(error =>
        /cannot contain a nested|hydration error|expected static flag was missing/i.test(
          error,
        ),
      )
      assert.deepEqual(
        reactErrors,
        [],
        'Replayed tool cards emitted React rendering errors',
      )
      passed = true
      console.log(`replayed tool cards: ${cards.join(' | ')}`)
      console.log('ok coding-tools Web UI session replay')
      return
    }

    const temporary = await useTemporaryWorkspace(page)
    temporaryWorkspace = temporary.workspace
    console.log(`temporary workspace: ${temporary.workspace}`)

    sessionId = await createFreshSession(page)
    console.log(`session: ${sessionId}`)

    const composer = page.locator('.input-textarea')
    await composer.fill(PROMPT)
    await page.locator('.composer-btn--send').click()
    await page.locator('.msg-user').filter({ hasText: PROMPT }).waitFor()

    // Completion restores the send button. Interaction prompts deliberately
    // keep a cancel button visible and therefore time out with a screenshot.
    await page
      .locator('.composer-btn--send')
      .waitFor({ state: 'visible', timeout: TIMEOUT_MS })
    await page.locator('.msg-assistant').last().waitFor({ state: 'visible' })

    const cards = await toolCardSummaries(page)
    assert.ok(
      cards.length > 0,
      'The model completed without rendering a coding tool card; use a prompt that requires tools',
    )
    for (const expected of EXPECTED_CARDS) {
      assert.ok(
        cards.some(card =>
          card.toLowerCase().includes(expected.toLowerCase()),
        ),
        `Expected tool card "${expected}", rendered: ${cards.join(' | ')}`,
      )
    }
    console.log(`tool cards: ${cards.join(' | ')}`)

    await Promise.all(chatSseCaptures)
    const chatSse = chatSseChunks.join('\n')
    assert.match(chatSse, /"type"\s*:\s*"tool_call"/)
    assert.match(chatSse, /"type"\s*:\s*"tool_result"/)
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, `${sessionId}-chat.sse.log`),
      chatSse,
    )

    const transcript = await api<{ messages: unknown[] }>(
      page,
      endpoint(UI_URL, `sessions/${sessionId}/messages`),
    )
    const transcriptText = JSON.stringify(transcript)
    for (const expected of EXPECTED_TOOLS) {
      assert.match(
        transcriptText,
        new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        `Session transcript is missing "${expected}"`,
      )
    }
    fs.writeFileSync(
      path.join(ARTIFACT_DIR, `${sessionId}-messages.json`),
      JSON.stringify(transcript, null, 2),
    )

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.input-textarea').waitFor({ state: 'visible' })
    await page.waitForFunction(
      expected => localStorage.getItem('coding_agent_session_id') === expected,
      sessionId,
    )
    await page.locator('.msg-user').filter({ hasText: PROMPT }).waitFor()
    await page.locator('.messages[aria-busy="true"]').waitFor({
      state: 'detached',
      timeout: 30_000,
    }).catch(() => {})

    const replayedCards = await toolCardSummaries(page)
    assert.equal(
      replayedCards.length,
      cards.length,
      'Tool-card count changed after session replay',
    )
    for (const expected of EXPECTED_CARDS) {
      assert.ok(
        replayedCards.some(card =>
          card.toLowerCase().includes(expected.toLowerCase()),
        ),
        `Replayed session is missing tool card "${expected}"`,
      )
    }
    assert.ok(
      (await page.locator('.msg-assistant').count()) > 0,
      'Assistant transcript was not replayed after refresh',
    )
    console.log(`replayed tool cards: ${replayedCards.join(' | ')}`)

    if (browserErrors.length > 0) {
      console.warn(`browser console errors (${browserErrors.length}):`)
      for (const error of browserErrors) console.warn(`  ${error}`)
    }
    const reactErrors = browserErrors.filter(error =>
      /cannot contain a nested|hydration error|expected static flag was missing/i.test(
        error,
      ),
    )
    assert.deepEqual(
      reactErrors,
      [],
      'Tool cards emitted React rendering errors',
    )
    passed = true
    console.log('ok coding-tools Web UI tool cards and session replay')
  } catch (error) {
    const screenshotPath = path.join(
      ARTIFACT_DIR,
      `failure-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
    )
    await page
      .screenshot({ path: screenshotPath, fullPage: true })
      .catch(() => {})
    console.error(`failure screenshot: ${screenshotPath}`)
    throw error
  } finally {
    if (passed && temporaryWorkspace) {
      await removeTemporaryWorkspace(page, temporaryWorkspace).catch(error => {
        console.warn(
          `warning: could not remove temporary workspace ${temporaryWorkspace}: ${String(error)}`,
        )
      })
    } else if (temporaryWorkspace) {
      console.error(
        `temporary workspace retained for failure investigation: ${temporaryWorkspace}`,
      )
    }
    const tracePath = path.join(
      ARTIFACT_DIR,
      `${sessionId ?? 'no-session'}-trace.zip`,
    )
    await context.tracing.stop({ path: tracePath })
    console.log(`browser trace: ${tracePath}`)
    await context.close()
    await browser.close()
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
