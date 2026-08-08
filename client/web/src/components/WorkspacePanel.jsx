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

/** Aligns with Claude Code LspServerState + Workspace badge language. */
const LSP_STATUS_BADGE = {
  running: { className: 'ws-badge--active', label: 'running' },
  starting: { className: 'ws-badge--active', label: 'starting' },
  stopping: { className: 'ws-badge--shadow', label: 'stopping' },
  stopped: { className: 'ws-badge--shadow', label: 'stopped' },
  error: { className: 'ws-badge--error', label: 'error' },
}

const AGENT_SOURCE_ORDER = [
  'managed',
  'project',
  'user',
  'plugin',
  'built-in',
]
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
    return groupBySource(
      all,
      'source',
      AGENT_SOURCE_ORDER,
      AGENT_SOURCE_LABELS,
    )
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
          <li key={`${skill.name}:${skill.filePath || skill.source}`} className='ws-panel-item'>
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
            <p className='ws-panel-item-meta'>
              tools {tools.length}
            </p>
            {tools.length > 0 && (
              <div className='ws-mcp-tools'>
                {tools.map(t => (
                  <code key={t} className='ws-mcp-tool' title={`${s.name}_${t}`}>
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
        No LSP servers configured. Add{' '}
        <code>lspServers</code> to <code>.ai-agent/settings.json</code>.
        Servers start lazily when a matching file is opened or LSPTool runs.
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
                <p className='ws-panel-item-desc-short ws-mcp-error'>{s.error}</p>
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
              {activeCount} agents · {skillCount} skills · {pluginCount} plugins
              {' '}· {mcpToolCount} mcp tools · {lspRunningCount} lsp running
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
              className='btn-clear'
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
