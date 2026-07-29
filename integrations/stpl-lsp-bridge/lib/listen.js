import net from 'node:net'
import { log } from './log.js'

/**
 * @typedef {object} ListenResult
 * @property {net.Server} server
 * @property {number} port
 */

/**
 * Bind a TCP server on 127.0.0.1 only.
 * @param {number} port 0 = ephemeral
 * @returns {Promise<ListenResult>}
 */
export function listenLocal(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('failed to resolve listen address'))
        return
      }
      log(`listening on 127.0.0.1:${address.port}`)
      resolve({ server, port: address.port })
    })
  })
}

/**
 * Accept the first inbound connection, then stop accepting.
 * @param {net.Server} server
 * @param {number} timeoutMs
 * @returns {Promise<net.Socket>}
 */
export function acceptOne(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    let settled = false

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      server.removeListener('connection', onConnection)
      server.removeListener('error', onError)
    }

    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const succeed = (socket) => {
      if (settled) {
        socket.destroy()
        return
      }
      settled = true
      cleanup()
      // Reject further connections: host External IDE path is single-client.
      server.close()
      resolve(socket)
    }

    const onConnection = (socket) => {
      const remote = `${socket.remoteAddress}:${socket.remotePort}`
      log(`accepted connection from ${remote}`)
      succeed(socket)
    }

    const onError = (err) => {
      fail(err)
    }

    timer = setTimeout(() => {
      fail(
        new Error(
          `accept timed out after ${timeoutMs}ms waiting for STPL LS to connect`,
        ),
      )
    }, timeoutMs)

    server.on('connection', onConnection)
    server.on('error', onError)
  })
}
