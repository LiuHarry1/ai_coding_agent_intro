import { create } from "zustand";
import { api } from "../lib/api.js";

const STORAGE_KEY_WIDTH = "coding_agent_ide_width";

function initialWidth() {
  const saved = parseInt(localStorage.getItem(STORAGE_KEY_WIDTH) || "0", 10);
  if (saved && saved > 200) return saved;
  return Math.round((typeof window !== "undefined" ? window.innerWidth : 1400) * 0.6);
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
export const useWorkspaceIdeStore = create((set, get) => ({
  // ── Visibility / layout ───────────────────────────────
  open: false,
  /** Width in pixels — persisted in localStorage. */
  width: initialWidth(),

  toggle: () => set((s) => ({ open: !s.open })),

  setWidth: (w) => {
    const minW = 360;
    const maxW = Math.max(
      minW + 200,
      (typeof window !== "undefined" ? window.innerWidth : 1400) - 360
    );
    const clamped = Math.max(minW, Math.min(maxW, Math.round(w)));
    localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
    set({ width: clamped });
  },

  // ── File tree ────────────────────────────────────────
  /** Absolute paths of directories the user has expanded. */
  expandedDirs: new Set(),
  /** listDir results keyed by absolute path. */
  dirCache: {},

  toggleDir: (dirPath) => {
    set((s) => {
      const next = new Set(s.expandedDirs);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return { expandedDirs: next };
    });
    if (!get().dirCache[dirPath] && get().expandedDirs.has(dirPath)) {
      get().loadDir(dirPath);
    }
  },

  /** Expand a directory without toggling — used to auto-expand the root. */
  expandDir: (dirPath) => {
    set((s) => {
      if (s.expandedDirs.has(dirPath)) return s;
      const next = new Set(s.expandedDirs);
      next.add(dirPath);
      return { expandedDirs: next };
    });
    if (!get().dirCache[dirPath]) get().loadDir(dirPath);
  },

  loadDir: async (dirPath) => {
    try {
      const data = await api.listDir(dirPath);
      set((s) => ({ dirCache: { ...s.dirCache, [dirPath]: data } }));
    } catch (e) {
      console.error("[workspace-ide] listDir failed:", e);
    }
  },

  /**
   * Re-fetch every currently expanded directory in parallel. Useful after
   * the agent writes new files — the tree is otherwise served from the
   * stale `dirCache` snapshot taken on first expand.
   */
  refreshTree: async () => {
    const paths = Array.from(get().expandedDirs);
    await Promise.all(paths.map((p) => get().loadDir(p)));
  },

  /**
   * Collapse every directory back to the root. The root itself is left
   * collapsed too — the user can re-expand it with one click and see the
   * fresh tree.
   */
  collapseAll: () => set({ expandedDirs: new Set() }),

  // ── Editor tabs + content cache ──────────────────────
  /** Absolute paths of files currently open as tabs. */
  openFiles: [],
  /** Path of the active tab, or null when nothing is open. */
  activeFile: null,
  /** path -> { content, size, truncated, isBinary, loading?, error? } */
  fileContents: {},

  openFile: async (filePath) => {
    set((s) => ({
      openFiles: s.openFiles.includes(filePath) ? s.openFiles : [...s.openFiles, filePath],
      activeFile: filePath,
    }));
    if (get().fileContents[filePath]) return;

    set((s) => ({
      fileContents: { ...s.fileContents, [filePath]: { loading: true } },
    }));
    try {
      const data = await api.getFile(filePath);
      set((s) => ({
        fileContents: { ...s.fileContents, [filePath]: { ...data, loading: false } },
      }));
    } catch (e) {
      set((s) => ({
        fileContents: {
          ...s.fileContents,
          [filePath]: { loading: false, error: e.message },
        },
      }));
    }
  },

  closeFile: (filePath) => {
    set((s) => {
      const openFiles = s.openFiles.filter((p) => p !== filePath);
      let activeFile = s.activeFile;
      if (s.activeFile === filePath) {
        const idx = s.openFiles.indexOf(filePath);
        activeFile = openFiles[idx] ?? openFiles[idx - 1] ?? null;
      }
      return { openFiles, activeFile };
    });
  },

  setActiveFile: (filePath) => set({ activeFile: filePath }),
}));
