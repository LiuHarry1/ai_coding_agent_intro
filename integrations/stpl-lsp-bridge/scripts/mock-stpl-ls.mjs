#!/usr/bin/env node
/**
 * Tiny mock STPL LS: connects to 127.0.0.1:<port> and speaks minimal LSP.
 * Used to validate the bridge pipe without a live host IDE.
 *
 *   node scripts/mock-stpl-ls.mjs <port>
 */

import net from 'node:net'

const port = Number(process.argv[2] || 0)
if (!port) {
  console.error('usage: node mock-stpl-ls.mjs <port>')
  process.exit(1)
}

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body,
  ])
}

function attachReader(socket, onMessage) {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = buffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) return
      const length = Number(match[1])
      const total = headerEnd + 4 + length
      if (buffer.length < total) return
      const body = buffer.subarray(headerEnd + 4, total).toString('utf8')
      buffer = buffer.subarray(total)
      onMessage(JSON.parse(body))
    }
  })
}

const socket = net.connect({ host: '127.0.0.1', port }, () => {
  console.error(`[mock-stpl-ls] connected to 127.0.0.1:${port}`)
})

attachReader(socket, (msg) => {
  console.error(`[mock-stpl-ls] ← ${msg.method || `id=${msg.id}`}`)
  if (msg.method === 'initialize') {
    socket.write(
      encode({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          capabilities: {
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            textDocumentSync: 1,
          },
        },
      }),
    )
    return
  }
  if (msg.method === 'initialized') return
  if (msg.method === 'textDocument/didOpen') {
    const uri = msg.params?.textDocument?.uri
    socket.write(
      encode({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 5 },
              },
              severity: 1,
              message: 'mock STPL diagnostic',
              source: 'mock-stpl',
            },
          ],
        },
      }),
    )
    return
  }
  if (msg.method === 'textDocument/hover') {
    socket.write(
      encode({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          contents: {
            kind: 'markdown',
            value: '**mock STPL hover**\n\nBridge pipe is working.',
          },
        },
      }),
    )
    return
  }
  if (msg.method === 'shutdown') {
    socket.write(encode({ jsonrpc: '2.0', id: msg.id, result: null }))
    return
  }
  if (msg.method === 'exit') {
    socket.end()
    process.exit(0)
  }
  if (msg.id != null) {
    socket.write(
      encode({
        jsonrpc: '2.0',
        id: msg.id,
        result: null,
      }),
    )
  }
})

socket.on('error', (err) => {
  console.error(`[mock-stpl-ls] error: ${err.message}`)
  process.exit(1)
})
