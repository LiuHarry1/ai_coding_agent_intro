import { create } from 'zustand'
import { workspaceApi } from '../lib/api/workspace.js'
import { fileName } from '../lib/utils.js'

const STORAGE_KEY_WIDTH = 'coding_agent_ide_width'
const STORAGE_KEY_TREE_WIDTH = 'coding_agent_ide_tree_width'
const STORAGE_KEY_SHOW_HIDDEN = 'coding_agent_ide_show_hidden'
const DEFAULT_TREE_WIDTH = 260

function initialShowHidden() {
  return localStorage.getItem(STORAGE_KEY_SHOW_HIDDEN) === '1'
}

function initialWidth() {
  const saved = parseInt(localStorage.getItem(STORAGE_KEY_WIDTH) || '0', 10)
  if (saved && saved > 200) return saved
  return Math.round(
    (typeof window !== 'undefined' ? window.innerWidth : 1400) * 0.6,
  )
}

function initialTreeWidth() {
  const saved = parseInt(
    localStorage.getItem(STORAGE_KEY_TREE_WIDTH) || '0',
    10,
  )
  if (saved && saved >= 120) return saved
  return DEFAULT_TREE_WIDTH
}

/**
 * State for the left-side Workspace IDE panel: visibility, splitter width,
 * file tree expansion + cache, editor tabs, and per-file content cache.
 *
 * Lives in its own zustand store rather than the chat store because none
 * of this state participates in message streaming and the two concerns
 * have no shared mutations beyond the workspace cwd (which still lives
 * on the chat store).
 */
const DEFAULT_CHANGES = {
  loading: false,
  error: null,
  isGitRepo: true,
  branch: null,
  entries: [],
  totals: { files: 0, insertions: 0, deletions: 0 },
  lastFetchedAt: 0,
}

function parentDir(absPath) {
  const norm = absPath.replace(/\/$/, '')
  const i = norm.lastIndexOf('/')
  return i > 0 ? norm.slice(0, i) : norm
}

/** True when `p` is `prefix` itself or a descendant of `prefix`. */
function isUnderPath(p, prefix) {
  const base = prefix.replace(/\/$/, '')
  return p === base || p.startsWith(base + '/')
}

export const useWorkspaceIdeStore = create((set, get) => ({
  // ── Workspace root ───────────────────────────────────
  /**
   * Absolute path of the directory the IDE is browsing. Set externally by
   * whoever owns "what workspace are we working in?" — in this app that's
   * the chat feature, but the IDE doesn't care: it only reads `rootPath`
   * here. This breaks the reverse dependency on chat-store.
   */
  rootPath: null,
  setRootPath: p => {
    if (get().rootPath === p) return
    set({
      rootPath: p,
      // Drop git state so the new repo isn't shown with stale changes.
      changes: { ...DEFAULT_CHANGES },
      diffs: {},
      openDiffs: [],
      activeDiff: null,
      activeView: 'explorer',
      activeKind: get().activeFile ? 'file' : null,
    })
  },

  // ── Visibility / layout ───────────────────────────────
  open: false,
  /** Width in pixels — persisted in localStorage. */
  width: initialWidth(),
  /** File tree column width when editor is open — persisted in localStorage. */
  treeWidth: initialTreeWidth(),

  toggle: () => set(s => ({ open: !s.open })),

  setTreeWidth: w => {
    const ideW = get().width
    const minW = 120
    const maxW = Math.max(minW + 120, ideW - 200)
    const clamped = Math.max(minW, Math.min(maxW, Math.round(w)))
    localStorage.setItem(STORAGE_KEY_TREE_WIDTH, String(clamped))
    set({ treeWidth: clamped })
  },

  setWidth: w => {
    const minW = 360
    const maxW = Math.max(
      minW + 200,
      (typeof window !== 'undefined' ? window.innerWidth : 1400) - 360,
    )
    const clamped = Math.max(minW, Math.min(maxW, Math.round(w)))
    localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped))
    set({ width: clamped })
  },

  // ── File tree ────────────────────────────────────────
  /** When true, list dotfiles/dotdirs in addition to `.ai-agent`. */
  showHiddenFiles: initialShowHidden(),
  /** Absolute paths of directories the user has expanded. */
  expandedDirs: new Set(),
  /** listDir results keyed by absolute path. */
  dirCache: {},

  toggleShowHiddenFiles: async () => {
    const next = !get().showHiddenFiles
    localStorage.setItem(STORAGE_KEY_SHOW_HIDDEN, next ? '1' : '0')
    set({ showHiddenFiles: next, dirCache: {} })
    const paths = Array.from(get().expandedDirs)
    await Promise.all(paths.map(p => get().loadDir(p)))
  },
  toggleDir: dirPath => {
    set(s => {
      const next = new Set(s.expandedDirs)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return { expandedDirs: next }
    })
    if (!get().dirCache[dirPath] && get().expandedDirs.has(dirPath)) {
      get().loadDir(dirPath)
    }
  },

  /** Expand a directory without toggling — used to auto-expand the root. */
  expandDir: dirPath => {
    set(s => {
      if (s.expandedDirs.has(dirPath)) return s
      const next = new Set(s.expandedDirs)
      next.add(dirPath)
      return { expandedDirs: next }
    })
    if (!get().dirCache[dirPath]) get().loadDir(dirPath)
  },

  loadDir: async dirPath => {
    try {
      const data = await workspaceApi.listDir(dirPath, get().showHiddenFiles)
      set(s => ({ dirCache: { ...s.dirCache, [dirPath]: data } }))
    } catch (e) {
      console.error('[workspace-ide] listDir failed:', e)
    }
  },

  /**
   * Re-fetch every currently expanded directory in parallel. Useful after
   * the agent writes new files — the tree is otherwise served from the
   * stale `dirCache` snapshot taken on first expand.
   */
  refreshTree: async () => {
    const paths = Array.from(get().expandedDirs)
    await Promise.all(paths.map(p => get().loadDir(p)))
  },

  /**
   * Collapse every directory back to the root. The root itself is left
   * collapsed too — the user can re-expand it with one click and see the
   * fresh tree.
   */
  collapseAll: () => set({ expandedDirs: new Set() }),

  // ── Inline create (new file / new folder) ────────────
  /**
   * When the user clicks "New File" / "New Folder", we render an inline
   * input row inside `parentDir`. `kind` tells the row what to do on
   * commit. `error` is set after a failed commit so the row can show it.
   *   { parentDir, kind: 'file' | 'folder', error?: string } | null
   */
  pendingNew: null,

  beginCreate: (parentDir, kind) => {
    // Make sure the target dir is expanded so the inline row is visible.
    if (!get().expandedDirs.has(parentDir)) get().expandDir(parentDir)
    set({ pendingNew: { parentDir, kind, error: null } })
  },

  cancelCreate: () => set({ pendingNew: null }),

  commitCreate: async rawName => {
    const pending = get().pendingNew
    if (!pending) return
    const name = (rawName || '').trim()
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
      set({ pendingNew: { ...pending, error: 'Invalid name' } })
      return
    }
    const fullPath = pending.parentDir.replace(/\/$/, '') + '/' + name
    try {
      if (pending.kind === 'folder') {
        await workspaceApi.createFolder(fullPath)
      } else {
        await workspaceApi.createFile(fullPath, '')
      }
      set({ pendingNew: null })
      await get().loadDir(pending.parentDir)
      if (pending.kind === 'file') {
        get().openFile(fullPath)
      } else {
        get().expandDir(fullPath)
      }
    } catch (e) {
      set({ pendingNew: { ...pending, error: e.message || 'Create failed' } })
    }
  },

  /**
   * Delete a file or folder from disk (with confirmation). Refuses to
   * delete the workspace root. Closes editor/diff tabs under the deleted
   * path and refreshes the parent directory listing.
   */
  deleteEntry: async ({ path: targetPath, isDir }) => {
    const root = get().rootPath
    if (!targetPath || !root || targetPath === root) return

    const name = fileName(targetPath) || targetPath
    const label = isDir
      ? `folder "${name}" and everything inside it`
      : `file "${name}"`

    const affectedFiles = get().openFiles.filter(p =>
      isDir ? isUnderPath(p, targetPath) : p === targetPath,
    )
    if (affectedFiles.some(p => get().fileContents[p]?.dirty)) {
      // eslint-disable-next-line no-alert
      if (
        !window.confirm('Some open files have unsaved changes. Delete anyway?')
      ) {
        return
      }
    }

    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return

    try {
      await workspaceApi.removeEntry(targetPath)

      for (const p of [...affectedFiles]) get().closeFile(p, { force: true })

      const rootNorm = root.replace(/\/$/, '')
      if (isDir && targetPath.startsWith(rootNorm + '/')) {
        const relPrefix = targetPath.slice(rootNorm.length + 1)
        for (const rel of [...get().openDiffs]) {
          if (isUnderPath(rel, relPrefix)) get().closeDiff(rel)
        }
      } else if (!isDir && targetPath.startsWith(rootNorm + '/')) {
        const rel = targetPath.slice(rootNorm.length + 1)
        if (get().openDiffs.includes(rel)) get().closeDiff(rel)
      }

      set(s => {
        const dirCache = { ...s.dirCache }
        const expandedDirs = new Set(s.expandedDirs)
        for (const key of Object.keys(dirCache)) {
          if (isUnderPath(key, targetPath)) delete dirCache[key]
        }
        for (const d of expandedDirs) {
          if (isUnderPath(d, targetPath)) expandedDirs.delete(d)
        }
        return { dirCache, expandedDirs }
      })

      await get().loadDir(parentDir(targetPath))
      if (get().changes.lastFetchedAt) get().refreshChanges()
    } catch (e) {
      // eslint-disable-next-line no-alert
      window.alert(e.message || 'Delete failed')
    }
  },

  // ── Upload (binary) ──────────────────────────────────
  /**
   * Transient per-directory upload state, keyed by absolute dir path:
   *   { pct: number, error?: string } | undefined
   * FileTree renders an inline progress row from this, mirroring how
   * `pendingNew` drives the inline "new file" row.
   */
  uploadState: {},

  uploadToDir: async (dir, files) => {
    const list = Array.from(files || [])
    if (!dir || list.length === 0) return
    if (!get().expandedDirs.has(dir)) get().expandDir(dir)

    set(s => ({ uploadState: { ...s.uploadState, [dir]: { pct: 0 } } }))
    const setPct = pct =>
      set(s => ({ uploadState: { ...s.uploadState, [dir]: { pct } } }))

    try {
      await workspaceApi.uploadFiles(dir, list, setPct)
      await get().loadDir(dir)
      // Clear the progress row shortly after completion.
      set(s => {
        const next = { ...s.uploadState }
        delete next[dir]
        return { uploadState: next }
      })
    } catch (e) {
      set(s => ({
        uploadState: {
          ...s.uploadState,
          [dir]: { pct: 0, error: e.message || 'Upload failed' },
        },
      }))
    }
  },

  dismissUpload: dir =>
    set(s => {
      const next = { ...s.uploadState }
      delete next[dir]
      return { uploadState: next }
    }),

  // ── Side-panel view (Explorer / Changes) ─────────────
  activeView: 'explorer',
  setActiveView: view => {
    set({ activeView: view })
    if (view === 'changes' && !get().changes.lastFetchedAt) {
      get().refreshChanges()
    }
  },

  // ── Git changes (working tree vs HEAD) ────────────────
  changes: { ...DEFAULT_CHANGES },

  refreshChanges: async () => {
    const root = get().rootPath
    if (!root) return
    set(s => ({ changes: { ...s.changes, loading: true, error: null } }))
    try {
      const data = await workspaceApi.gitStatus()
      set({
        changes: {
          loading: false,
          error: null,
          isGitRepo: data.isGitRepo,
          branch: data.branch,
          entries: data.entries,
          totals: data.totals,
          lastFetchedAt: Date.now(),
        },
      })
      // Refresh any open diff tabs whose underlying file may have moved.
      const openDiffs = get().openDiffs
      for (const p of openDiffs) get()._loadDiff(p)
    } catch (e) {
      set(s => ({
        changes: {
          ...s.changes,
          loading: false,
          error: e.message || String(e),
        },
      }))
    }
  },

  // ── Editor tabs + content cache ──────────────────────
  /** Absolute paths of files currently open as tabs. */
  openFiles: [],
  /** Path of the active file tab. */
  activeFile: null,
  /** Relative paths of currently open diff tabs (git working-tree vs HEAD). */
  openDiffs: [],
  /** Relative path of the active diff tab. */
  activeDiff: null,
  /**
   * Which tab kind is currently focused. `null` only when there are
   * neither file nor diff tabs open. EditorView and EditorTabs read this
   * to decide which active state to honor.
   */
  activeKind: null,
  /** path -> { loading, error, oldContent, newContent, status, isBinary, truncated }. */
  diffs: {},
  /**
   * path -> {
   *   content, size, truncated, isBinary, mtimeMs,
   *   loading?, error?,
   *   editing?: bool, draft?: string, dirty?: bool, saveError?: string,
   * }
   */
  fileContents: {},

  openFile: async filePath => {
    set(s => ({
      openFiles: s.openFiles.includes(filePath)
        ? s.openFiles
        : [...s.openFiles, filePath],
      activeFile: filePath,
      activeKind: 'file',
    }))
    if (get().fileContents[filePath]) return

    set(s => ({
      fileContents: { ...s.fileContents, [filePath]: { loading: true } },
    }))
    try {
      const data = await workspaceApi.getFile(filePath)
      // Always seed `draft` with the loaded content so the editor is
      // immediately writable for non-binary, non-truncated files. `dirty`
      // stays false until the user actually changes something.
      set(s => ({
        fileContents: {
          ...s.fileContents,
          [filePath]: {
            ...data,
            loading: false,
            draft: data.content ?? '',
            dirty: false,
          },
        },
      }))
    } catch (e) {
      set(s => ({
        fileContents: {
          ...s.fileContents,
          [filePath]: { loading: false, error: e.message },
        },
      }))
    }
  },

  closeFile: (filePath, { force = false } = {}) => {
    const cur = get().fileContents[filePath]
    if (!force && cur?.dirty) {
      // eslint-disable-next-line no-alert
      const ok = window.confirm(
        `"${fileName(filePath)}" has unsaved changes. Discard them?`,
      )
      if (!ok) return
    }
    set(s => {
      const openFiles = s.openFiles.filter(p => p !== filePath)
      let activeFile = s.activeFile
      let activeKind = s.activeKind
      if (s.activeFile === filePath) {
        const idx = s.openFiles.indexOf(filePath)
        activeFile = openFiles[idx] ?? openFiles[idx - 1] ?? null
        if (!activeFile) {
          // No more file tabs — fall back to a diff tab if one is open.
          activeKind = s.activeDiff ? 'diff' : s.openDiffs[0] ? 'diff' : null
        }
      }
      // Drop the cached draft for the closed file so re-opening reloads
      // fresh content. Keep the rest of `fileContents[path]` to make
      // re-opening near-instant — `openFile` early-returns when it sees
      // a cached entry, but we need to delete the entry entirely so it
      // re-fetches and re-seeds `draft` with the latest disk content.
      const next = { ...s.fileContents }
      delete next[filePath]
      return { openFiles, activeFile, activeKind, fileContents: next }
    })
  },

  setActiveFile: filePath => set({ activeFile: filePath, activeKind: 'file' }),

  // ── Diff tabs ────────────────────────────────────────
  openDiff: relPath => {
    set(s => ({
      openDiffs: s.openDiffs.includes(relPath)
        ? s.openDiffs
        : [...s.openDiffs, relPath],
      activeDiff: relPath,
      activeKind: 'diff',
    }))
    if (!get().diffs[relPath]) get()._loadDiff(relPath)
  },

  closeDiff: relPath => {
    set(s => {
      const openDiffs = s.openDiffs.filter(p => p !== relPath)
      let activeDiff = s.activeDiff
      let activeKind = s.activeKind
      if (s.activeDiff === relPath) {
        const idx = s.openDiffs.indexOf(relPath)
        activeDiff = openDiffs[idx] ?? openDiffs[idx - 1] ?? null
        if (!activeDiff) {
          activeKind = s.activeFile ? 'file' : null
        }
      }
      const nextDiffs = { ...s.diffs }
      delete nextDiffs[relPath]
      return { openDiffs, activeDiff, activeKind, diffs: nextDiffs }
    })
  },

  setActiveDiff: relPath => set({ activeDiff: relPath, activeKind: 'diff' }),

  _loadDiff: async relPath => {
    set(s => ({
      diffs: {
        ...s.diffs,
        [relPath]: { ...(s.diffs[relPath] || {}), loading: true, error: null },
      },
    }))
    try {
      const data = await workspaceApi.gitDiff(relPath)
      set(s => ({
        diffs: {
          ...s.diffs,
          [relPath]: { ...data, loading: false, error: null },
        },
      }))
    } catch (e) {
      set(s => ({
        diffs: {
          ...s.diffs,
          [relPath]: {
            ...(s.diffs[relPath] || {}),
            loading: false,
            error: e.message || String(e),
          },
        },
      }))
    }
  },

  // ── Editing ──────────────────────────────────────────
  setDraft: (filePath, content) => {
    set(s => {
      const cur = s.fileContents[filePath]
      if (!cur) return s
      return {
        fileContents: {
          ...s.fileContents,
          [filePath]: {
            ...cur,
            draft: content,
            dirty: content !== (cur.content ?? ''),
            saveError: null,
          },
        },
      }
    })
  },

  saveActiveFile: async () => {
    const filePath = get().activeFile
    if (!filePath) return
    const cur = get().fileContents[filePath]
    if (!cur || !cur.dirty) return
    try {
      const data = await workspaceApi.saveFile(filePath, cur.draft, cur.mtimeMs)
      set(s => ({
        fileContents: {
          ...s.fileContents,
          [filePath]: {
            ...data,
            loading: false,
            draft: data.content,
            dirty: false,
          },
        },
      }))
    } catch (e) {
      set(s => ({
        fileContents: {
          ...s.fileContents,
          [filePath]: {
            ...s.fileContents[filePath],
            saveError: e.message || 'Save failed',
          },
        },
      }))
    }
  },
}))
