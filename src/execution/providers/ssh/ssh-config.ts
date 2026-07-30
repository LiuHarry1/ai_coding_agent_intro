import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export type ParsedSshHost = {
  /** Config Host alias or synthesized id */
  alias: string
  hostName: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
  /** Optional from our settings overlay */
  startDirectory?: string
}

/**
 * Minimal ~/.ssh/config parser — Host / HostName / User / Port / IdentityFile / ProxyJump.
 * Enough for VS Code–style host pickers; not a full OpenSSH config implementation.
 */
export function parseSshConfigFile(content: string): ParsedSshHost[] {
  const hosts: ParsedSshHost[] = []
  let current: ParsedSshHost | null = null

  const flush = () => {
    if (current && current.alias && !current.alias.includes('*')) {
      if (!current.hostName) current.hostName = current.alias
      hosts.push(current)
    }
    current = null
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^(\w+)\s+(.+)$/i.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim().replace(/^"|"$/g, '')

    if (key === 'host') {
      flush()
      // Only take the first token (ignore multi-pattern Host lines for listing)
      const alias = value.split(/\s+/)[0]
      current = { alias, hostName: '' }
      continue
    }
    if (!current) continue
    if (key === 'hostname') current.hostName = value
    else if (key === 'user') current.user = value
    else if (key === 'port') current.port = Number(value) || undefined
    else if (key === 'identityfile') {
      current.identityFile = expandHome(value)
    } else if (key === 'proxyjump') current.proxyJump = value
  }
  flush()
  return hosts
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2))
  }
  if (p.startsWith('~')) {
    // ~otheruser — leave as-is for ssh
    return p
  }
  return p
}

export function loadSystemSshConfig(
  configPath = path.join(os.homedir(), '.ssh', 'config'),
): ParsedSshHost[] {
  try {
    if (!fs.existsSync(configPath)) return []
    return parseSshConfigFile(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return []
  }
}

/** Settings overlay: environments.ssh[] */
export type SshSettingsEntry = {
  id?: string
  name?: string
  sshHost: string
  sshUser?: string
  sshPort?: number
  sshIdentityFile?: string
  proxyJump?: string
  startDirectory?: string
}

export function mergeSshHosts(
  fromConfig: ParsedSshHost[],
  fromSettings: SshSettingsEntry[],
): ParsedSshHost[] {
  const byAlias = new Map<string, ParsedSshHost>()
  for (const h of fromConfig) byAlias.set(h.alias, { ...h })
  for (const s of fromSettings) {
    const alias = s.id || s.name || s.sshHost
    const prev = byAlias.get(alias)
    byAlias.set(alias, {
      alias,
      hostName: s.sshHost || prev?.hostName || alias,
      user: s.sshUser ?? prev?.user,
      port: s.sshPort ?? prev?.port,
      identityFile: s.sshIdentityFile
        ? expandHome(s.sshIdentityFile)
        : prev?.identityFile,
      proxyJump: s.proxyJump ?? prev?.proxyJump,
      startDirectory: s.startDirectory ?? prev?.startDirectory,
    })
  }
  return [...byAlias.values()]
}

/** Build `ssh` CLI argv prefix (without remote command). */
export function buildSshArgs(host: ParsedSshHost, extra: string[] = []): string[] {
  const args: string[] = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15']
  if (host.port) args.push('-p', String(host.port))
  if (host.identityFile) args.push('-i', host.identityFile)
  if (host.proxyJump) args.push('-J', host.proxyJump)
  args.push(...extra)
  const dest = host.user ? `${host.user}@${host.hostName}` : host.hostName
  args.push(dest)
  return args
}

export function environmentIdForAlias(alias: string): string {
  return `ssh:${alias}`
}
