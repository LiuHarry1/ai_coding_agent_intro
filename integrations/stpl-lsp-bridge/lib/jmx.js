import { spawn } from 'node:child_process'
import { basename, extname } from 'node:path'
import { log } from './log.js'

/**
 * Invoke SmarTest StpllsJmxOperations helper.
 *
 * Expected helper CLI (from SmarTest docs):
 *   java StpllsJmxOperations.java <pid> start|stop <port>
 *
 * If helper is a .js/.cmd/.bat/.sh/.exe (or has no .java extension), run it
 * directly as: <helper> <pid> start|stop <port>
 *
 * @param {object} opts
 * @param {string} opts.java
 * @param {string} opts.helper
 * @param {string} opts.pid
 * @param {'start' | 'stop'} opts.action
 * @param {number} opts.port
 * @returns {Promise<void>}
 */
export function jmxInvoke({ java, helper, pid, action, port }) {
  const { command, args } = buildCommand({ java, helper, pid, action, port })
  log(`jmx ${action}: ${command} ${args.join(' ')}`)

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    })

    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log(`jmx stdout: ${text}`)
    })
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      const trimmed = text.trim()
      if (trimmed) log(`jmx stderr: ${trimmed}`, 'warn')
    })
    child.on('error', (err) => {
      reject(
        new Error(
          `failed to spawn JMX helper (${command}): ${err.message}`,
        ),
      )
    })
    child.on('exit', (code) => {
      if (code === 0) {
        log(`jmx ${action} succeeded`)
        resolve()
        return
      }
      reject(
        new Error(
          `JMX helper exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
        ),
      )
    })
  })
}

/**
 * @param {object} opts
 * @param {string} opts.java
 * @param {string} opts.helper
 * @param {string} opts.pid
 * @param {'start' | 'stop'} opts.action
 * @param {number} opts.port
 */
function buildCommand({ java, helper, pid, action, port }) {
  const ext = extname(helper).toLowerCase()
  const portStr = String(port)
  if (ext === '.java' || basename(helper).endsWith('.java')) {
    return {
      command: java,
      args: [helper, pid, action, portStr],
    }
  }
  // Wrapper script / binary
  return {
    command: helper,
    args: [pid, action, portStr],
  }
}
