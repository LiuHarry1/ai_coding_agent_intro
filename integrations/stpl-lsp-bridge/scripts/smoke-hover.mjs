#!/usr/bin/env node
/**
 * Manual smoke test: spawn the bridge over stdio, send initialize + hover.
 *
 * Usage (wait-for-connect mode with a mock or real STPL LS):
 *   STPL_START_MODE=wait-for-connect STPL_LSP_PORT=50000 \
 *     node scripts/smoke-hover.mjs [path/to/file.spec]
 *
 * For a dry run without a live host IDE, use scripts/mock-stpl-ls.mjs after smoke starts:
 *   STPL_START_MODE=wait-for-connect STPL_LSP_PORT=50000 node scripts/smoke-hover.mjs
 *   # other terminal:
 *   node scripts/mock-stpl-ls.mjs 50000
 */

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const bridgeEntry = resolve(__dirname, '../index.js')
const filePath = resolve(process.argv[2] || resolve(__dirname, 'fixtures/sample.spec'))
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 90_000)

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
  return Buffer.concat([header, body])
}

function createFramedReader(onMessage) {
  let buffer = Buffer.alloc(0)
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = buffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        throw new Error(`bad LSP header: ${header}`)
      }
      const length = Number(match[1])
      const total = headerEnd + 4 + length
      if (buffer.length < total) return
      const body = buffer.subarray(headerEnd + 4, total).toString('utf8')
      buffer = buffer.subarray(total)
      onMessage(JSON.parse(body))
    }
  }
}

async function main() {
  if (!existsSync(bridgeEntry)) {
    throw new Error(`bridge not found: ${bridgeEntry}`)
  }

  const content = existsSync(filePath)
    ? readFileSync(filePath, 'utf8')
    : '// sample.spec fixture\nFlow MyFlow {\n}\n'
  const uri = pathToFileURL(filePath).href
  const root = dirname(filePath)
  const rootUri = pathToFileURL(root).href

  console.error(`[smoke] spawning bridge: ${bridgeEntry}`)
  console.error(`[smoke] file: ${filePath}`)

  const child = spawn(process.execPath, [bridgeEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    windowsHide: true,
  })

  child.stderr.on('data', (d) => process.stderr.write(d))

  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  const pending = new Map()
  let nextId = 1

  const onStdout = createFramedReader((msg) => {
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(JSON.stringify(msg.error)))
      else res(msg.result)
      return
    }
    if (msg.method) {
      console.error(`[smoke] notification: ${msg.method}`)
    }
  })
  child.stdout.on('data', onStdout)

  const sendNotification = (method, params) => {
    child.stdin.write(encode({ jsonrpc: '2.0', method, params }))
  }
  const sendRequest = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`request timeout: ${method}`))
        }
      }, timeoutMs)
    })

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code) => resolve(code))
  })

  try {
    const initResult = await sendRequest('initialize', {
      processId: process.pid,
      rootPath: root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(root) }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
      },
    })
    console.error(
      `[smoke] initialize ok, capabilities keys: ${Object.keys(initResult?.capabilities || {}).join(', ') || '(none)'}`,
    )
    sendNotification('initialized', {})

    sendNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'stpl',
        version: 1,
        text: content,
      },
    })

    const hover = await sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    })
    console.error('[smoke] hover result:')
    console.error(JSON.stringify(hover, null, 2))

    try {
      await sendRequest('shutdown', null)
    } catch {
      // some servers ignore
    }
    sendNotification('exit', undefined)
    child.stdin.end()

    const code = await Promise.race([
      exitPromise,
      new Promise((r) => setTimeout(() => r(-1), 5000)),
    ])
    console.error(`[smoke] bridge exited: ${code}`)
    if (hover == null) {
      console.error('[smoke] WARN: hover returned null (server may lack capability or need a real symbol)')
    } else {
      console.error('[smoke] PASS')
    }
  } catch (err) {
    console.error(`[smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`)
    try {
      child.kill('SIGTERM')
    } catch {
      // ignore
    }
    process.exit(1)
  }
}

main()
