import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { agentApi } from '../lib/api/agent.js'
import { setKnownMcpServers } from '../lib/tool-kind.js'

const TABS = [
  { id: 'agents', label: 'Subagents' },
  { id: 'skills', label: 'Skills' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'mcp', label: 'MCP' },
  { id: 'lsp', label: 'LSP' },
]

const MCP_STATUS_BADGE = {
  connected: { className: 'ws-badge--active', label: 'connected' },
  error: { className: 'ws-badge--error', label: 'error' },
  disconnected: { className: 'ws-badge--shadow', label: 'disconnected' },
}

/** LSP server state + Workspace badge language. */
const LSP_STATUS_BADGE = {
  running: { className: 'ws-badge--active', label: 'running' },
  starting: { className: 'ws-badge--active', label: 'starting' },
  stopping: { className: 'ws-badge--shadow', label: 'stopping' },
  stopped: { className: 'ws-badge--shadow', label: 'stopped' },
  error: { className: 'ws-badge--error', label: 'error' },
}

const AGENT_SOURCE_ORDER = ['managed', 'project', 'user', 'plugin', 'built-in']
const AGENT_SOURCE_LABELS = {
  managed: 'Managed',
  project: 'Project',
  user: 'User',
  plugin: 'Plugin',
  'built-in': 'Built-in',
}

const SKILL_SOURCE_ORDER = ['managed', 'project', 'user', 'plugin']
const SKILL_SOURCE_LABELS = {
  managed: 'Managed',
  project: 'Project',
  user: 'User',
  plugin: 'Plugin',
}

function fileName(p) {
  if (!p) return ''
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

function pluginNameFromPath(filePath) {
  if (!filePath) return null
  const m = filePath.replace(/\\/g, '/').match(/\/plugins\/([^/]+)\//)
  return m ? m[1] : null
}

function groupBySource(items, sourceKey, order, labels) {
  const map = new Map()
  for (const item of items) {
    const key = item[sourceKey] || 'built-in'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return order
    .filter(s => map.has(s))
    .map(s => ({
      source: s,
      label: labels[s] || s,
      items: [...map.get(s)].sort((a, b) => {
        const an = a.agentType || a.name || ''
        const bn = b.agentType || b.name || ''
        return an.localeCompare(bn)
      }),
    }))
}

function AgentsTab({ data }) {
  const grouped = useMemo(() => {
    const all = data?.all ?? data?.agents ?? []
    return groupBySource(all, 'source', AGENT_SOURCE_ORDER, AGENT_SOURCE_LABELS)
  }, [data])

  if (grouped.length === 0) {
    return <p className='ws-panel-empty'>No subagents found.</p>
  }

  return grouped.map(group => (
    <section key={group.source} className='ws-panel-group'>
      <h3 className='ws-panel-group-title'>{group.label}</h3>
      <ul className='ws-panel-list'>
        {group.items.map(agent => {
          const shadowed = Boolean(agent.overriddenBy)
          const plugin = pluginNameFromPath(agent.filePath)
          return (
            <li
              key={`${agent.agentType}:${agent.filePath || agent.source}`}
              className={`ws-panel-item ${shadowed ? 'ws-panel-item--muted' : ''}`}
            >
              <div className='ws-panel-item-row'>
                <code className='ws-panel-item-name'>{agent.agentType}</code>
                {!shadowed && (
                  <span className='ws-badge ws-badge--active'>active</span>
                )}
                {shadowed && (
                  <span
                    className='ws-badge ws-badge--shadow'
                    title={`Overridden by ${agent.overriddenBy}`}
                  >
                    shadowed
                  </span>
                )}
              </div>
              {(agent.filePath || plugin) && (
                <p className='ws-panel-item-meta' title={agent.filePath || ''}>
                  {plugin ? `${plugin} · ` : ''}
                  {fileName(agent.filePath) || plugin}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  ))
}

function SkillsTab({ data }) {
  const grouped = useMemo(() => {
    const skills = data?.skills ?? []
    return groupBySource(
      skills,
      'source',
      SKILL_SOURCE_ORDER,
      SKILL_SOURCE_LABELS,
    )
  }, [data])

  if (grouped.length === 0) {
    return <p className='ws-panel-empty'>No skills found.</p>
  }

  return grouped.map(group => (
    <section key={group.source} className='ws-panel-group'>
      <h3 className='ws-panel-group-title'>{group.label}</h3>
      <ul className='ws-panel-list'>
        {group.items.map(skill => (
          <li
            key={`${skill.name}:${skill.filePath || skill.source}`}
            className='ws-panel-item'
          >
            <div className='ws-panel-item-row'>
              <code className='ws-panel-item-name'>{skill.name}</code>
              {skill.active ? (
                <span className='ws-badge ws-badge--active'>active</span>
              ) : (
                <span className='ws-badge ws-badge--shadow'>conditional</span>
              )}
              <span className='ws-badge ws-badge--type'>{skill.context}</span>
            </div>
            {skill.baseDir && (
              <p className='ws-panel-item-meta' title={skill.baseDir}>
                {fileName(skill.baseDir)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  ))
}

function PluginsTab({ data }) {
  const plugins = data?.plugins ?? []

  if (plugins.length === 0) {
    return <p className='ws-panel-empty'>No plugins installed.</p>
  }

  return (
    <ul className='ws-panel-list'>
      {plugins.map(p => (
        <li key={p.name} className='ws-panel-item'>
          <div className='ws-panel-item-row'>
            <code className='ws-panel-item-name'>{p.name}</code>
            <span className='ws-badge ws-badge--type'>{p.scope}</span>
            {p.version && (
              <span className='ws-badge ws-badge--shadow'>v{p.version}</span>
            )}
          </div>
          <p className='ws-panel-item-meta'>
            agents {p.agents} · commands {p.commands} · skills {p.skills} · mcp{' '}
            {p.mcp}
          </p>
          {p.description && (
            <p className='ws-panel-item-desc-short'>{p.description}</p>
          )}
        </li>
      ))}
    </ul>
  )
}

const MARKETPLACE_STATE_LABELS = {
  available: 'Available',
  installed: 'Installed',
  updateAvailable: 'Update available',
  conflict: 'Local conflict',
}

export function MarketplaceCatalog({ workspace, onInstalled }) {
  const [providers, setProviders] = useState([])
  const [providerId, setProviderId] = useState('')
  const [kind, setKind] = useState('skill')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [page, setPage] = useState(1)
  const [catalog, setCatalog] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [installing, setInstalling] = useState(null)
  const [uninstalling, setUninstalling] = useState(null)
  const [previewing, setPreviewing] = useState(null)
  const [bundlePreview, setBundlePreview] = useState(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const provider = providers.find(item => item.id === providerId)
  const needsLogin =
    Boolean(provider) &&
    provider.auth !== 'none' &&
    provider.authenticated !== true

  const refreshProviders = useCallback(async () => {
    const response = await agentApi.getMarketplaceProviders(workspace)
    const next = response.providers ?? []
    setProviders(next)
    setProviderId(current =>
      next.some(item => item.id === current) ? current : next[0]?.id || '',
    )
    return next
  }, [workspace])

  useEffect(() => {
    setLoading(true)
    setError(null)
    refreshProviders()
      .catch(e => setError(e.message || 'Failed to load marketplaces'))
      .finally(() => setLoading(false))
  }, [refreshProviders])

  useEffect(() => {
    if (!provider) return
    const capability =
      kind === 'skill' ? 'skills' : kind === 'agent' ? 'agents' : 'bundles'
    const allowed = provider.capabilities.includes(capability)
    if (!allowed) {
      setKind(
        provider.capabilities.includes('skills')
          ? 'skill'
          : provider.capabilities.includes('agents')
            ? 'agent'
            : 'bundle',
      )
    }
  }, [provider, kind])

  const loadCatalog = useCallback(async () => {
    if (!providerId || needsLogin) {
      setCatalog(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await agentApi.getMarketplaceCatalog(providerId, {
        kind,
        q: submittedQuery,
        page,
        perPage: 12,
        workspace,
      })
      setCatalog(response)
    } catch (e) {
      setError(e.message || 'Failed to load marketplace')
      setCatalog(null)
    } finally {
      setLoading(false)
    }
  }, [providerId, needsLogin, kind, submittedQuery, page, workspace])

  useEffect(() => {
    loadCatalog()
  }, [loadCatalog])

  const login = async event => {
    event.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await agentApi.marketplaceLogin(
        providerId,
        { username, password },
        workspace,
      )
      setPassword('')
      await refreshProviders()
    } catch (e) {
      setError(e.message || 'Marketplace login failed')
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    setLoading(true)
    setError(null)
    try {
      await agentApi.marketplaceLogout(providerId, workspace)
      await refreshProviders()
      setCatalog(null)
    } catch (e) {
      setError(e.message || 'Marketplace logout failed')
    } finally {
      setLoading(false)
    }
  }

  const install = async (item, options = {}) => {
    setInstalling(item.externalId)
    setError(null)
    try {
      if (item.kind === 'skill') {
        const env = await agentApi
          .getMarketplaceEnvSchema(providerId, item.externalId, workspace)
          .catch(() => ({ variables: [] }))
        if (env.variables?.length) {
          const names = env.variables
            .map(variable => variable.name || variable.key)
            .filter(Boolean)
          const proceed = window.confirm(
            `This skill expects environment variables${
              names.length ? `: ${names.join(', ')}` : ''
            }. Install without storing secrets?`,
          )
          if (!proceed) return
        }
      }
      await agentApi.installMarketplaceItem(
        providerId,
        item,
        workspace,
        options,
      )
      if (item.kind === 'bundle') setBundlePreview(null)
      await Promise.all([loadCatalog(), onInstalled?.()])
    } catch (e) {
      setError(e.message || 'Marketplace install failed')
    } finally {
      setInstalling(null)
    }
  }

  const previewBundle = async item => {
    setPreviewing(item.externalId)
    setError(null)
    try {
      const response = await agentApi.previewMarketplaceBundle(
        providerId,
        item,
        workspace,
      )
      setBundlePreview({ item, ...response.preview })
    } catch (e) {
      setError(e.message || 'AI Bundle preview failed')
    } finally {
      setPreviewing(null)
    }
  }

  const installBundle = () => {
    if (bundlePreview.requiresConfirmation) {
      const conflicts = bundlePreview.files.filter(
        file => file.state === 'conflict' || file.state === 'modified',
      ).length
      const confirmed = window.confirm(
        `${conflicts} existing workspace file(s) will be replaced with the BaiX versions from this bundle. The current files will be backed up and restored if you uninstall the bundle. Continue?`,
      )
      if (!confirmed) return
    }
    install(bundlePreview.item, {
      confirmConflicts: bundlePreview.requiresConfirmation,
    })
  }

  const uninstall = async item => {
    const confirmed = window.confirm(
      `Uninstall ${item.kind} "${item.name}" from this workspace?`,
    )
    if (!confirmed) return
    setUninstalling(item.externalId)
    setError(null)
    try {
      await agentApi.uninstallMarketplaceItem(providerId, item, workspace)
      await Promise.all([loadCatalog(), onInstalled?.()])
    } catch (e) {
      setError(e.message || 'Marketplace uninstall failed')
    } finally {
      setUninstalling(null)
    }
  }

  if (!loading && providers.length === 0) {
    return (
      <p className='ws-panel-empty'>
        No marketplace providers configured in trusted settings.
      </p>
    )
  }

  return (
    <div className='ws-marketplace'>
      <div className='ws-marketplace-toolbar'>
        <label>
          <span>Source</span>
          <select
            value={providerId}
            onChange={event => {
              setProviderId(event.target.value)
              setPage(1)
            }}
          >
            {providers.map(item => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div
          className='ws-marketplace-kinds'
          role='group'
          aria-label='Resource type'
        >
          {provider?.capabilities.includes('skills') && (
            <button
              type='button'
              className={kind === 'skill' ? 'is-active' : ''}
              onClick={() => {
                setKind('skill')
                setPage(1)
              }}
            >
              Skills
            </button>
          )}
          {provider?.capabilities.includes('agents') && (
            <button
              type='button'
              className={kind === 'agent' ? 'is-active' : ''}
              onClick={() => {
                setKind('agent')
                setPage(1)
              }}
            >
              Agents
            </button>
          )}
          {provider?.capabilities.includes('bundles') && (
            <button
              type='button'
              className={kind === 'bundle' ? 'is-active' : ''}
              onClick={() => {
                setKind('bundle')
                setPage(1)
              }}
            >
              AI Bundles
            </button>
          )}
        </div>
        {provider?.authenticated && provider.auth !== 'none' && (
          <button
            type='button'
            className='ws-text-btn is-danger'
            onClick={logout}
          >
            Sign out
          </button>
        )}
      </div>

      {error && <div className='ws-panel-error'>{error}</div>}

      {needsLogin ? (
        <form className='ws-marketplace-login' onSubmit={login}>
          <p>Sign in to {provider.label} to browse and install resources.</p>
          <input
            required
            autoComplete='username'
            placeholder='Username'
            value={username}
            onChange={event => setUsername(event.target.value)}
          />
          <input
            required
            type='password'
            autoComplete='current-password'
            placeholder='Password'
            value={password}
            onChange={event => setPassword(event.target.value)}
          />
          <button type='submit' disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      ) : (
        <>
          <form
            className='ws-marketplace-search'
            onSubmit={event => {
              event.preventDefault()
              setSubmittedQuery(query.trim())
              setPage(1)
            }}
          >
            <input
              placeholder={`Search ${
                kind === 'skill'
                  ? 'skills'
                  : kind === 'agent'
                    ? 'agents'
                    : 'AI bundles'
              }…`}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            <button type='submit'>Search</button>
          </form>

          {loading && <p className='ws-panel-empty'>Loading marketplace…</p>}
          {!loading && catalog?.items?.length === 0 && (
            <p className='ws-panel-empty'>No matching resources.</p>
          )}
          {!loading && catalog?.items?.length > 0 && (
            <ul className='ws-panel-list ws-marketplace-list'>
              {catalog.items.map(item => {
                const owned =
                  item.installState === 'installed' ||
                  item.installState === 'updateAvailable'
                const busy =
                  installing === item.externalId ||
                  uninstalling === item.externalId ||
                  previewing === item.externalId
                return (
                  <li
                    key={`${item.kind}:${item.externalId}`}
                    className='ws-panel-item ws-marketplace-card'
                  >
                    <div className='ws-panel-item-row'>
                      <code className='ws-panel-item-name'>{item.name}</code>
                      <span
                        className={`ws-badge ${
                          item.installState === 'installed'
                            ? 'ws-badge--active'
                            : item.installState === 'conflict'
                              ? 'ws-badge--error'
                              : 'ws-badge--shadow'
                        }`}
                      >
                        {MARKETPLACE_STATE_LABELS[item.installState] ||
                          'Available'}
                      </span>
                      {item.version && (
                        <span className='ws-badge ws-badge--type'>
                          v{item.version}
                        </span>
                      )}
                      {item.platformType && (
                        <span className='ws-badge ws-badge--shadow'>
                          {item.platformType}
                        </span>
                      )}
                    </div>
                    {(item.author ||
                      item.category ||
                      item.downloads != null) && (
                      <p className='ws-panel-item-meta'>
                        {[item.author, item.category]
                          .filter(Boolean)
                          .join(' · ')}
                        {item.downloads != null
                          ? `${item.author || item.category ? ' · ' : ''}${item.downloads} installs`
                          : ''}
                      </p>
                    )}
                    {item.description && (
                      <p className='ws-panel-item-desc-short'>
                        {item.description}
                      </p>
                    )}
                    <div className='ws-marketplace-actions'>
                      {item.installState !== 'installed' && (
                        <button
                          type='button'
                          className='ws-marketplace-install'
                          disabled={busy || item.installState === 'conflict'}
                          onClick={() =>
                            item.kind === 'bundle'
                              ? previewBundle(item)
                              : install(item)
                          }
                        >
                          {previewing === item.externalId
                            ? 'Preparing…'
                            : installing === item.externalId
                              ? 'Installing…'
                              : item.installState === 'updateAvailable'
                                ? item.kind === 'bundle'
                                  ? 'Review update'
                                  : 'Update'
                                : item.installState === 'conflict'
                                  ? 'Local conflict'
                                  : item.kind === 'bundle'
                                    ? 'Preview'
                                    : 'Download'}
                        </button>
                      )}
                      {owned && (
                        <button
                          type='button'
                          className='ws-marketplace-uninstall'
                          disabled={busy}
                          onClick={() => uninstall(item)}
                        >
                          {uninstalling === item.externalId
                            ? 'Uninstalling…'
                            : 'Uninstall'}
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {bundlePreview && (
            <div
              className='ws-bundle-preview-backdrop'
              role='presentation'
              onClick={() => setBundlePreview(null)}
            >
              <section
                className='ws-bundle-preview'
                role='dialog'
                aria-modal='true'
                aria-labelledby='ws-bundle-preview-title'
                onClick={event => event.stopPropagation()}
              >
                <div className='ws-bundle-preview-head'>
                  <div>
                    <h3 id='ws-bundle-preview-title'>
                      {bundlePreview.item.name}
                    </h3>
                    <p>
                      {bundlePreview.files.length} files
                      {bundlePreview.platformType
                        ? ` · ${bundlePreview.platformType}`
                        : ''}
                    </p>
                  </div>
                  <button
                    type='button'
                    aria-label='Close bundle preview'
                    onClick={() => setBundlePreview(null)}
                  >
                    ×
                  </button>
                </div>
                {bundlePreview.warnings?.map((warning, index) => (
                  <div className='ws-bundle-warning' key={index}>
                    {warning}
                  </div>
                ))}
                <div className='ws-bundle-files'>
                  {bundlePreview.files.slice(0, 40).map(file => (
                    <div
                      className='ws-bundle-file'
                      key={`${file.sourcePath}:${file.targetPath || ''}`}
                    >
                      <div className='ws-bundle-file-paths'>
                        <code title={file.sourcePath}>{file.sourcePath}</code>
                        {file.targetPath &&
                          file.targetPath !== file.sourcePath && (
                            <code
                              className='ws-bundle-file-target'
                              title={file.targetPath}
                            >
                              → {file.targetPath}
                            </code>
                          )}
                      </div>
                      <span className={`ws-bundle-file-state is-${file.state}`}>
                        {file.state === 'archiveOnly'
                          ? 'archive only'
                          : file.state}
                      </span>
                    </div>
                  ))}
                  {bundlePreview.files.length > 40 && (
                    <p className='ws-panel-empty'>
                      + {bundlePreview.files.length - 40} more files
                    </p>
                  )}
                </div>
                <div className='ws-bundle-preview-actions'>
                  <button type='button' onClick={() => setBundlePreview(null)}>
                    Cancel
                  </button>
                  <button
                    type='button'
                    className='ws-marketplace-install'
                    disabled={
                      !bundlePreview.canInstall ||
                      installing === bundlePreview.item.externalId
                    }
                    onClick={installBundle}
                  >
                    {installing === bundlePreview.item.externalId
                      ? 'Installing…'
                      : bundlePreview.item.installState === 'updateAvailable'
                        ? 'Update bundle'
                        : bundlePreview.requiresConfirmation
                          ? 'Confirm & install'
                          : 'Install bundle'}
                  </button>
                </div>
              </section>
            </div>
          )}

          {catalog && (
            <div className='ws-marketplace-pagination'>
              <span className='ws-marketplace-result-count'>
                {catalog.total != null
                  ? `${catalog.total.toLocaleString()} results`
                  : `${catalog.items?.length ?? 0} shown`}
              </span>
              <button
                type='button'
                aria-label='Previous page'
                disabled={page <= 1 || loading}
                onClick={() => setPage(value => Math.max(1, value - 1))}
              >
                ←
              </button>
              <span className='ws-marketplace-page'>Page {page}</span>
              <button
                type='button'
                aria-label='Next page'
                disabled={
                  loading ||
                  !catalog.items?.length ||
                  catalog.items.length < catalog.perPage ||
                  (catalog.total != null &&
                    page * catalog.perPage >= catalog.total)
                }
                onClick={() => setPage(value => value + 1)}
              >
                →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function McpTab({ data }) {
  const servers = data?.servers ?? []

  if (servers.length === 0) {
    return (
      <p className='ws-panel-empty'>
        No MCP servers configured. Add one via settings (mcpServers).
      </p>
    )
  }

  return (
    <ul className='ws-panel-list'>
      {servers.map(s => {
        const badge =
          MCP_STATUS_BADGE[s.status] ?? MCP_STATUS_BADGE.disconnected
        const tools = s.tools ?? []
        return (
          <li key={s.name} className='ws-panel-item'>
            <div className='ws-panel-item-row'>
              <code className='ws-panel-item-name'>{s.name}</code>
              <span
                className={`ws-badge ${badge.className}`}
                title={s.error || undefined}
              >
                {badge.label}
              </span>
            </div>
            <p className='ws-panel-item-meta'>tools {tools.length}</p>
            {tools.length > 0 && (
              <div className='ws-mcp-tools'>
                {tools.map(t => (
                  <code
                    key={t}
                    className='ws-mcp-tool'
                    title={`${s.name}_${t}`}
                  >
                    {t}
                  </code>
                ))}
              </div>
            )}
            {s.status === 'error' && s.error && (
              <p className='ws-panel-item-desc-short ws-mcp-error'>{s.error}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function LspTab({ data }) {
  const servers = data?.servers ?? []
  if (servers.length === 0) {
    return (
      <p className='ws-panel-empty'>
        No LSP servers configured. Add <code>lspServers</code> to{' '}
        <code>.ai-agent/settings.json</code>. Servers start lazily when a
        matching file is opened or LSPTool runs.
      </p>
    )
  }

  const running = servers.filter(s => s.state === 'running').length

  return (
    <>
      <p className='ws-panel-sub ws-lsp-summary'>
        {running} running · {servers.length} configured
      </p>
      <ul className='ws-panel-list'>
        {servers.map(s => {
          const badge = LSP_STATUS_BADGE[s.state] ?? LSP_STATUS_BADGE.stopped
          const cmd = [s.command, ...(s.args || [])].join(' ')
          const langs = (s.languages || []).join(', ')
          const exts = (s.extensions || []).join(' ')
          return (
            <li key={s.name} className='ws-panel-item'>
              <div className='ws-panel-item-row'>
                <code className='ws-panel-item-name'>{s.name}</code>
                <span
                  className={`ws-badge ${badge.className}`}
                  title={s.error || undefined}
                >
                  {badge.label}
                </span>
              </div>
              {cmd && (
                <p className='ws-panel-item-meta' title={cmd}>
                  {cmd}
                </p>
              )}
              {(langs || exts) && (
                <p className='ws-panel-item-meta'>
                  {langs ? `langs ${langs}` : ''}
                  {langs && exts ? ' · ' : ''}
                  {exts ? `ext ${exts}` : ''}
                </p>
              )}
              {s.state === 'error' && s.error && (
                <p className='ws-panel-item-desc-short ws-mcp-error'>
                  {s.error}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

function Warnings({ errors }) {
  if (!errors?.length) return null
  return (
    <section className='ws-panel-warnings'>
      <h3 className='ws-panel-group-title'>Load warnings</h3>
      <ul className='ws-panel-warn-list'>
        {errors.map((e, i) => (
          <li key={i}>
            <span className='ws-panel-warn-path'>{e.filePath || e.source}</span>
            <span className='ws-panel-warn-msg'>{e.error || e.message}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function WorkspacePanel({ open, workspace, onClose }) {
  const [tab, setTab] = useState('agents')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [agentsData, setAgentsData] = useState(null)
  const [skillsData, setSkillsData] = useState(null)
  const [pluginsData, setPluginsData] = useState(null)
  const [mcpData, setMcpData] = useState(null)
  const [lspData, setLspData] = useState(null)

  const load = useCallback(async () => {
    if (!open) return
    setLoading(true)
    setError(null)
    const ws = workspace || undefined
    try {
      const [agents, skills, plugins, mcp, lsp] = await Promise.all([
        agentApi.getAgents(ws),
        agentApi.getSkills(ws),
        agentApi.getPlugins(ws),
        // MCP servers may be slow/broken to connect; don't fail the whole
        // panel over them.
        agentApi.getMcp(ws).catch(() => null),
        agentApi.getLsp(ws).catch(() => null),
      ])
      setAgentsData(agents)
      setSkillsData(skills)
      setPluginsData(plugins)
      setMcpData(mcp)
      setLspData(lsp)
      if (mcp?.servers) {
        setKnownMcpServers(mcp.servers.map(s => s.name).filter(Boolean))
      }
    } catch (e) {
      setError(e.message || 'Failed to load workspace extensions')
      setAgentsData(null)
      setSkillsData(null)
      setPluginsData(null)
      setMcpData(null)
      setLspData(null)
    } finally {
      setLoading(false)
    }
  }, [open, workspace])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!open) return
    const onKey = e => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const activeCount = agentsData?.agents?.length ?? 0
  const skillCount = skillsData?.skills?.length ?? 0
  const pluginCount = pluginsData?.plugins?.length ?? 0
  const mcpToolCount = (mcpData?.servers ?? []).reduce(
    (n, s) => n + (s.tools?.length ?? 0),
    0,
  )
  const lspRunningCount =
    lspData?.runningCount ??
    (lspData?.servers ?? []).filter(s => s.state === 'running').length

  const allErrors = useMemo(
    () => [
      ...(agentsData?.errors ?? []),
      ...(skillsData?.errors ?? []),
      ...(pluginsData?.errors ?? []),
    ],
    [agentsData, skillsData, pluginsData],
  )

  if (!open) return null

  return (
    <div
      className='ws-panel-modal'
      role='dialog'
      aria-modal='true'
      aria-labelledby='ws-panel-title'
      onClick={onClose}
    >
      <div className='ws-panel' onClick={e => e.stopPropagation()}>
        <div className='ws-panel-head'>
          <div>
            <h2 id='ws-panel-title' className='ws-panel-title'>
              Workspace
            </h2>
            <p className='ws-panel-sub'>
              {activeCount} agents · {skillCount} skills · {pluginCount} plugins{' '}
              · {mcpToolCount} mcp tools · {lspRunningCount} lsp running
              {agentsData?.workspace ? (
                <>
                  {' '}
                  ·{' '}
                  <span className='ws-panel-cwd' title={agentsData.workspace}>
                    {agentsData.workspace}
                  </span>
                </>
              ) : null}
            </p>
          </div>
          <div className='ws-panel-actions'>
            <button
              type='button'
              className='ws-text-btn'
              onClick={load}
              disabled={loading}
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button
              type='button'
              className='icon-btn ws-panel-close'
              onClick={onClose}
              title='Close'
              aria-label='Close'
            >
              ×
            </button>
          </div>
        </div>

        <div className='ws-panel-tabs' role='tablist'>
          {TABS.map(t => (
            <button
              key={t.id}
              type='button'
              role='tab'
              aria-selected={tab === t.id}
              className={`ws-panel-tab ${tab === t.id ? 'ws-panel-tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className='ws-panel-body' role='tabpanel'>
          {error && <div className='ws-panel-error'>{error}</div>}

          {!error && tab === 'agents' && <AgentsTab data={agentsData} />}
          {!error && tab === 'skills' && <SkillsTab data={skillsData} />}
          {!error && tab === 'plugins' && <PluginsTab data={pluginsData} />}
          {!error && tab === 'mcp' && <McpTab data={mcpData} />}
          {!error && tab === 'lsp' && <LspTab data={lspData} />}

          <Warnings errors={allErrors} />
        </div>
      </div>
    </div>
  )
}
