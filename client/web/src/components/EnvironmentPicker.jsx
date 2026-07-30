import React, { useCallback, useEffect, useRef, useState } from 'react'
import { environmentsApi } from '../lib/api/environments.js'
import { useChatStore } from '../stores/chat-store.js'

/**
 * VS Code–style environment picker: list local + SSH hosts, connect, pick folder.
 */
export default function EnvironmentPicker({ onBound }) {
  const [open, setOpen] = useState(false)
  const [envs, setEnvs] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [browse, setBrowse] = useState(null) // { environmentId, dir, entries }
  const [manualHost, setManualHost] = useState('')
  const ref = useRef(null)
  const currentSessionId = useChatStore(s => s.currentSessionId)
  const setWorkspace = useChatStore(s => s.setWorkspace)
  const workspaceLabel = useChatStore(s => s.workspaceLabel)

  useEffect(() => {
    const handler = e => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  const loadEnvs = useCallback(async () => {
    setError(null)
    try {
      const data = await environmentsApi.list()
      setEnvs(data.environments || [])
    } catch (err) {
      setError(err.message || 'Failed to list environments')
    }
  }, [])

  const handleOpen = async e => {
    e.stopPropagation()
    const next = !open
    setOpen(next)
    setBrowse(null)
    if (next) await loadEnvs()
  }

  const connectAndBrowse = async env => {
    setBusy(true)
    setError(null)
    try {
      await environmentsApi.connect(env.id, env.defaultCwd)
      const data = await environmentsApi.listDir(env.id, env.defaultCwd)
      setBrowse({
        environmentId: env.id,
        displayName: env.displayName,
        dir: data.dir,
        entries: data.entries || [],
      })
    } catch (err) {
      setError(err.message || 'Connect failed')
    } finally {
      setBusy(false)
    }
  }

  const enterDir = async entry => {
    if (!browse || entry.type !== 'dir') return
    setBusy(true)
    setError(null)
    try {
      const data = await environmentsApi.listDir(
        browse.environmentId,
        entry.path,
      )
      setBrowse({
        ...browse,
        dir: data.dir,
        entries: data.entries || [],
      })
    } catch (err) {
      setError(err.message || 'List failed')
    } finally {
      setBusy(false)
    }
  }

  const bindCurrentDir = async () => {
    if (!browse) return
    setBusy(true)
    setError(null)
    try {
      const handle = {
        environmentId: browse.environmentId,
        cwd: browse.dir,
      }
      let label = `${browse.displayName}:${browse.dir}`
      if (currentSessionId) {
        const res = await environmentsApi.bindSessionWorkspace(
          currentSessionId,
          handle,
        )
        label = res.label || label
      }
      setWorkspace(browse.dir)
      useChatStore.setState({
        workspaceLabel: label,
        workspaceHandle: handle,
      })
      onBound?.(handle, label)
      setOpen(false)
    } catch (err) {
      setError(err.message || 'Bind failed')
    } finally {
      setBusy(false)
    }
  }

  const connectManual = async () => {
    const input = manualHost.trim()
    if (!input) return
    setBusy(true)
    setError(null)
    try {
      const env = await environmentsApi.resolve(input)
      await connectAndBrowse(env)
    } catch (err) {
      setError(err.message || 'Resolve failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='env-picker' ref={ref}>
      <button
        type='button'
        className={`env-picker-trigger ${open ? 'open' : ''}`}
        onClick={handleOpen}
        title='Connect to environment (local / SSH)'
      >
        <svg
          width='14'
          height='14'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
        >
          <rect x='2' y='3' width='20' height='8' rx='2' />
          <rect x='2' y='13' width='20' height='8' rx='2' />
          <line x1='6' y1='7' x2='6.01' y2='7' />
          <line x1='6' y1='17' x2='6.01' y2='17' />
        </svg>
        <span>Remote</span>
      </button>
      {open && (
        <div className='env-picker-dropdown'>
          <div className='env-picker-dropdown-header'>
            {browse
              ? `Open Folder — ${browse.displayName}`
              : 'Select environment'}
          </div>
          {error && <div className='env-picker-error'>{error}</div>}
          {busy && <div className='env-picker-busy'>Working…</div>}
          {!browse ? (
            <>
              <div className='env-picker-list'>
                {envs.map(env => (
                  <button
                    key={env.id}
                    type='button'
                    className='env-picker-item'
                    onClick={() => connectAndBrowse(env)}
                  >
                    <span className='env-picker-kind'>{env.kind}</span>
                    <span className='env-picker-name'>{env.displayName}</span>
                  </button>
                ))}
                {envs.length === 0 && !busy && (
                  <div className='env-picker-busy'>No environments found</div>
                )}
              </div>
              <div className='env-picker-manual'>
                <input
                  className='env-picker-input'
                  placeholder='user@host or Host alias'
                  value={manualHost}
                  onChange={e => setManualHost(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') connectManual()
                  }}
                />
                <button
                  type='button'
                  className='env-picker-go'
                  onClick={connectManual}
                >
                  Go
                </button>
              </div>
            </>
          ) : (
            <>
              <div className='env-picker-path'>{browse.dir}</div>
              <div className='env-picker-list'>
                {browse.entries
                  .filter(e => e.type === 'dir')
                  .map(entry => (
                    <button
                      key={entry.path}
                      type='button'
                      className='env-picker-item'
                      onClick={() => enterDir(entry)}
                    >
                      <span className='env-picker-name'>{entry.name}/</span>
                    </button>
                  ))}
              </div>
              <div className='env-picker-actions'>
                <button
                  type='button'
                  className='env-picker-go'
                  onClick={() => setBrowse(null)}
                >
                  Back
                </button>
                <button
                  type='button'
                  className='env-picker-go env-picker-go--primary'
                  onClick={bindCurrentDir}
                >
                  Open this folder
                </button>
              </div>
            </>
          )}
          {workspaceLabel && (
            <div className='env-picker-current'>Current: {workspaceLabel}</div>
          )}
        </div>
      )}
    </div>
  )
}
