import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useChatStore } from '../stores/chat-store.js'
import { useWorkspaceIdeStore } from '../stores/workspace-ide-store.js'
import { workspaceApi } from '../lib/api/workspace.js'
import { isDesktop, pickWorkspaceDir } from '../lib/desktop.js'
import { authEnabled, getUser, logout, remoteEnabled } from '../lib/auth.js'
import SessionSwitcher from './SessionSwitcher.jsx'
import BaizeLogo from './BaizeLogo.jsx'
import WorkspacePanel from './WorkspacePanel.jsx'
import EnvironmentPicker from './EnvironmentPicker.jsx'

export default function Header() {
  // SSO mode: the workspace is pinned server-side to the logged-in user, so
  // the switcher/browser is hidden and shown read-only instead.
  const locked = authEnabled()
  const showRemote = remoteEnabled()
  const user = locked ? getUser() : null

  const workspace = useChatStore(s => s.workspace)
  const setWorkspace = useChatStore(s => s.setWorkspace)
  const toggleWorkspaceIde = useWorkspaceIdeStore(s => s.toggle)
  const workspaceIdeOpen = useWorkspaceIdeStore(s => s.open)
  const toggleTheme = useChatStore(s => s.toggleTheme)
  const theme = useChatStore(s => s.theme)
  const clearSession = useChatStore(s => s.clearSession)

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [dropdownData, setDropdownData] = useState(null)
  /** When non-null, the dropdown renders an inline "new folder" input row. */
  const [newFolderName, setNewFolderName] = useState(null)
  const [newFolderError, setNewFolderError] = useState(null)
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false)
  const dropdownRef = useRef(null)

  useEffect(() => {
    workspaceApi
      .getRoot()
      .then(d => setWorkspace(d.workspace))
      .catch(() => setWorkspace('.'))
  }, [setWorkspace])

  useEffect(() => {
    const handler = e => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  const loadDirectory = useCallback(
    async dir => {
      try {
        const data = await workspaceApi.listDir(dir)
        setDropdownData(data)
        setWorkspace(data.dir)
        setDropdownOpen(true)
        setNewFolderName(null)
        setNewFolderError(null)
      } catch {
        setDropdownData(null)
      }
    },
    [setWorkspace],
  )

  const handleCreateFolder = async () => {
    const name = (newFolderName || '').trim()
    if (!name || /[\\/]/.test(name) || name === '.' || name === '..') {
      setNewFolderError('Invalid name')
      return
    }
    const target = `${dropdownData.dir.replace(/\/$/, '')}/${name}`
    try {
      await workspaceApi.createFolder(target)
      // Reload the current dir so the new folder shows up, then auto-pick it.
      await loadDirectory(dropdownData.dir)
      setWorkspace(target)
      setDropdownOpen(false)
    } catch (err) {
      setNewFolderError(err.message || 'Create failed')
    }
  }

  const handleBrowse = e => {
    e.stopPropagation()
    if (dropdownOpen) setDropdownOpen(false)
    else loadDirectory(workspace || '.')
  }

  const handlePickFolder = async e => {
    e.stopPropagation()
    setDropdownOpen(false)
    const dir = await pickWorkspaceDir()
    if (dir) setWorkspace(dir)
  }

  const handleKeyDown = e => {
    if (e.key === 'Enter') {
      e.preventDefault()
      loadDirectory(workspace)
    }
  }

  return (
    <header className='header'>
      <div className='header-left'>
        <button
          className={`icon-btn workspace-toggle ${workspaceIdeOpen ? 'active' : ''}`}
          onClick={toggleWorkspaceIde}
          title={workspaceIdeOpen ? 'Hide workspace' : 'Show workspace'}
        >
          <svg
            width='16'
            height='16'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' />
          </svg>
        </button>
        <div className='logo'>
          <BaizeLogo size='sm' />
          <span className='logo-text'>BaiX Agent</span>
        </div>
        <SessionSwitcher />
        {showRemote && <EnvironmentPicker />}
      </div>

      {workspaceIdeOpen ? (
        /* When the IDE is open, the cwd is shown in the workspace header. */
        <div className='header-spacer' />
      ) : locked ? (
        <div className='workspace-bar workspace-bar--locked'>
          <label className='workspace-label'>
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' />
            </svg>
          </label>
          <span
            className='workspace-input workspace-input--readonly'
            title={workspace}
          >
            {workspace}
          </span>
        </div>
      ) : (
        <div
          className={`workspace-bar ${isDesktop() ? 'workspace-bar--desktop' : ''}`}
          ref={dropdownRef}
        >
          <label className='workspace-label' htmlFor='workspace-input'>
            <svg
              width='14'
              height='14'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' />
            </svg>
          </label>
          <input
            id='workspace-input'
            className='workspace-input'
            value={workspace}
            onChange={e => setWorkspace(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck='false'
            autoComplete='off'
            placeholder='loading...'
          />
          {isDesktop() && (
            <button
              className='workspace-pick-btn'
              onClick={handlePickFolder}
              title='Choose folder'
            >
              <svg
                width='12'
                height='12'
                viewBox='0 0 24 24'
                fill='none'
                stroke='currentColor'
                strokeWidth='2.5'
                strokeLinecap='round'
                strokeLinejoin='round'
              >
                <path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' />
                <line x1='12' y1='11' x2='12' y2='17' />
                <line x1='9' y1='14' x2='15' y2='14' />
              </svg>
            </button>
          )}
          <button
            className={`workspace-browse-btn ${dropdownOpen ? 'open' : ''}`}
            onClick={handleBrowse}
            title='Browse directories'
          >
            <svg
              width='12'
              height='12'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2.5'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <polyline points='6 9 12 15 18 9' />
            </svg>
          </button>

          {dropdownOpen && dropdownData && (
            <div className='workspace-dropdown open'>
              <div className='ws-dropdown-header'>
                {dropdownData.parent !== dropdownData.dir && (
                  <button
                    className='ws-parent-btn'
                    onClick={e => {
                      e.stopPropagation()
                      loadDirectory(dropdownData.parent)
                    }}
                  >
                    ..
                  </button>
                )}
                <span className='ws-path' title={dropdownData.dir}>
                  {dropdownData.dir}
                </span>
                <button
                  className='ws-new-folder-btn'
                  onClick={e => {
                    e.stopPropagation()
                    setNewFolderName('')
                    setNewFolderError(null)
                  }}
                  title='Create new folder here (use as new workspace)'
                >
                  + folder
                </button>
              </div>

              {newFolderName !== null && (
                <div
                  className={`ws-entry ws-entry--new ${newFolderError ? 'ws-entry--error' : ''}`}
                >
                  <span className='ws-entry-icon dir'>&#128193;</span>
                  <input
                    autoFocus
                    className='ws-new-folder-input'
                    value={newFolderName}
                    placeholder='new folder name'
                    onChange={e => {
                      setNewFolderName(e.target.value)
                      setNewFolderError(null)
                    }}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        handleCreateFolder()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setNewFolderName(null)
                        setNewFolderError(null)
                      }
                    }}
                  />
                  {newFolderError && (
                    <span
                      className='ws-new-folder-error'
                      title={newFolderError}
                    >
                      {newFolderError}
                    </span>
                  )}
                </div>
              )}

              {dropdownData.entries.filter(e => e.isDir).length === 0 &&
              newFolderName === null ? (
                <div className='ws-empty'>No subdirectories</div>
              ) : (
                dropdownData.entries
                  .filter(e => e.isDir)
                  .map(entry => (
                    <div
                      className='ws-entry'
                      key={entry.path}
                      onClick={() => loadDirectory(entry.path)}
                    >
                      <span className='ws-entry-icon dir'>&#128193;</span>
                      <span className='ws-entry-name'>{entry.name}</span>
                      <button
                        className='ws-entry-select'
                        onClick={e => {
                          e.stopPropagation()
                          setWorkspace(entry.path)
                          setDropdownOpen(false)
                        }}
                      >
                        select
                      </button>
                    </div>
                  ))
              )}
            </div>
          )}
        </div>
      )}

      <div className='header-right'>
        {locked && user && (
          <span className='auth-user' title={user.email}>
            {user.username || user.email}
          </span>
        )}
        <button
          className='icon-btn'
          onClick={() => setWorkspacePanelOpen(true)}
          title='Workspace extensions (agents, skills, plugins)'
        >
          <svg
            width='16'
            height='16'
            viewBox='0 0 24 24'
            fill='none'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
          >
            <path d='M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z' />
            <circle cx='8.5' cy='14.5' r='1.5' />
            <circle cx='15.5' cy='14.5' r='1.5' />
          </svg>
        </button>
        <button className='icon-btn' onClick={toggleTheme} title='Toggle theme'>
          {theme === 'dark' ? (
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <circle cx='12' cy='12' r='5' />
              <line x1='12' y1='1' x2='12' y2='3' />
              <line x1='12' y1='21' x2='12' y2='23' />
              <line x1='4.22' y1='4.22' x2='5.64' y2='5.64' />
              <line x1='18.36' y1='18.36' x2='19.78' y2='19.78' />
              <line x1='1' y1='12' x2='3' y2='12' />
              <line x1='21' y1='12' x2='23' y2='12' />
              <line x1='4.22' y1='19.78' x2='5.64' y2='18.36' />
              <line x1='18.36' y1='5.64' x2='19.78' y2='4.22' />
            </svg>
          ) : (
            <svg
              width='16'
              height='16'
              viewBox='0 0 24 24'
              fill='none'
              stroke='currentColor'
              strokeWidth='2'
              strokeLinecap='round'
              strokeLinejoin='round'
            >
              <path d='M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z' />
            </svg>
          )}
        </button>
        <button className='btn-clear' onClick={clearSession}>
          Clear
        </button>
        {locked && (
          <button className='btn-clear' onClick={logout} title='Sign out'>
            Logout
          </button>
        )}
      </div>
      <WorkspacePanel
        open={workspacePanelOpen}
        workspace={workspace}
        onClose={() => setWorkspacePanelOpen(false)}
      />
    </header>
  )
}
