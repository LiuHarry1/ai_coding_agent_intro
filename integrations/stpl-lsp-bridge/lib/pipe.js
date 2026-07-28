import { log } from './log.js'

/**
 * Bidirectional byte pipe: process stdin ↔ socket ↔ process stdout.
 * Does not interpret LSP framing.
 *
 * @param {import('node:net').Socket} socket
 * @param {object} [opts]
 * @param {boolean} [opts.debug]
 * @returns {Promise<{ reason: string }>}
 */
export function pipeStdioToSocket(socket, opts = {}) {
  const debug = Boolean(opts.debug)
  const stdin = process.stdin
  const stdout = process.stdout

  stdin.pause()
  stdin.setEncoding(null)
  socket.setEncoding(null)
  socket.setKeepAlive(true, 30_000)
  socket.setNoDelay(true)

  return new Promise((resolve) => {
    let settled = false
    const finish = (reason) => {
      if (settled) return
      settled = true
      log(`pipe closed: ${reason}`)
      try {
        stdin.removeAllListeners()
        socket.removeAllListeners()
      } catch {
        // ignore
      }
      try {
        if (!socket.destroyed) socket.destroy()
      } catch {
        // ignore
      }
      resolve({ reason })
    }

    stdin.on('data', (chunk) => {
      if (debug) log(`stdin→socket ${chunk.length} bytes`)
      if (!socket.writable) return
      const ok = socket.write(chunk)
      if (!ok) stdin.pause()
    })
    socket.on('drain', () => stdin.resume())

    socket.on('data', (chunk) => {
      if (debug) log(`socket→stdout ${chunk.length} bytes`)
      if (!stdout.writable) return
      const ok = stdout.write(chunk)
      if (!ok) socket.pause()
    })
    stdout.on('drain', () => socket.resume())

    stdin.on('end', () => finish('stdin EOF'))
    stdin.on('close', () => finish('stdin close'))
    stdin.on('error', (err) => finish(`stdin error: ${err.message}`))

    socket.on('end', () => finish('socket end'))
    socket.on('close', () => finish('socket close'))
    socket.on('error', (err) => finish(`socket error: ${err.message}`))

    stdin.resume()
    log('pipe started (stdio ↔ socket)')
  })
}
