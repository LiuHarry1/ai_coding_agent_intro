import React from 'react'
import { useWorkspaceIdeStore } from '../../stores/workspace-ide-store.js'
import { fileName } from '../../lib/utils.js'

/**
 * Top tab strip for the editor pane. Renders two kinds of tabs:
 *   - "file": normal editor tab (path is absolute)
 *   - "diff": git working-tree diff tab (path is relative to repo root)
 * Only one tab is active at a time, tracked by `activeKind` + the
 * corresponding `activeFile` / `activeDiff` in the store.
 */
export default function EditorTabs() {
  const openFiles = useWorkspaceIdeStore(s => s.openFiles)
  const openDiffs = useWorkspaceIdeStore(s => s.openDiffs)
  const activeFile = useWorkspaceIdeStore(s => s.activeFile)
  const activeDiff = useWorkspaceIdeStore(s => s.activeDiff)
  const activeKind = useWorkspaceIdeStore(s => s.activeKind)
  const setActiveFile = useWorkspaceIdeStore(s => s.setActiveFile)
  const setActiveDiff = useWorkspaceIdeStore(s => s.setActiveDiff)
  const closeFile = useWorkspaceIdeStore(s => s.closeFile)
  const closeDiff = useWorkspaceIdeStore(s => s.closeDiff)

  if (openFiles.length === 0 && openDiffs.length === 0) return null

  return (
    <div className='editor-tabs' role='tablist'>
      {openFiles.map(p => (
        <Tab
          key={`f:${p}`}
          path={p}
          kind='file'
          isActive={activeKind === 'file' && p === activeFile}
          onSelect={() => setActiveFile(p)}
          onClose={() => closeFile(p)}
        />
      ))}
      {openDiffs.map(p => (
        <Tab
          key={`d:${p}`}
          path={p}
          kind='diff'
          isActive={activeKind === 'diff' && p === activeDiff}
          onSelect={() => setActiveDiff(p)}
          onClose={() => closeDiff(p)}
        />
      ))}
    </div>
  )
}

function Tab({ path, kind, isActive, onSelect, onClose }) {
  // Only file tabs carry a dirty bit.
  const dirty = useWorkspaceIdeStore(s =>
    kind === 'file' ? Boolean(s.fileContents[path]?.dirty) : false,
  )

  return (
    <div
      role='tab'
      aria-selected={isActive}
      className={`editor-tab ${isActive ? 'active' : ''} ${dirty ? 'dirty' : ''} editor-tab--${kind}`}
      onClick={onSelect}
      title={kind === 'diff' ? `Diff · ${path}` : path}
    >
      <span className='editor-tab-name'>
        {kind === 'diff' && (
          <span className='editor-tab-kind' aria-hidden='true'>
            Δ
          </span>
        )}
        {dirty && (
          <span className='editor-tab-dot' aria-hidden='true'>
            ●
          </span>
        )}
        {fileName(path)}
      </span>
      <button
        className='editor-tab-close'
        onClick={e => {
          e.stopPropagation()
          onClose()
        }}
        title={dirty ? 'Close (unsaved changes)' : 'Close'}
      >
        <svg
          width='10'
          height='10'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2.5'
          strokeLinecap='round'
          strokeLinejoin='round'
        >
          <line x1='18' y1='6' x2='6' y2='18' />
          <line x1='6' y1='6' x2='18' y2='18' />
        </svg>
      </button>
    </div>
  )
}
