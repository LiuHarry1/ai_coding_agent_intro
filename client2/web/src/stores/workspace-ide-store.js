import { create } from "zustand";
import { workspaceApi } from "../lib/api/workspace.js";

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
  // ── Workspace root ───────────────────────────────────
  /**
   * Absolute path of the directory the IDE is browsing. Set externally by
   * whoever owns "what workspace are we working in?" — in this app that's
   * the chat feature, but the IDE doesn't care: it only reads `rootPath`
   * here. This breaks the reverse dependency on chat-store.
   */
  rootPath: null,
  setRootPath: (p) => set({ rootPath: p }),

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
      const data = await workspaceApi.listDir(dirPath);
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
    if (!get().expandedDirs.has(parentDir)) get().expandDir(parentDir);
    set({ pendingNew: { parentDir, kind, error: null } });
  },

  cancelCreate: () => set({ pendingNew: null }),

  commitCreate: async (rawName) => {
    const pending = get().pendingNew;
    if (!pending) return;
    const name = (rawName || "").trim();
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
      set({ pendingNew: { ...pending, error: "Invalid name" } });
      return;
    }
    const fullPath = pending.parentDir.replace(/\/$/, "") + "/" + name;
    try {
      if (pending.kind === "folder") {
        await workspaceApi.createFolder(fullPath);
      } else {
        await workspaceApi.createFile(fullPath, "");
      }
      set({ pendingNew: null });
      await get().loadDir(pending.parentDir);
      if (pending.kind === "file") {
        get().openFile(fullPath);
      } else {
        get().expandDir(fullPath);
      }
    } catch (e) {
      set({ pendingNew: { ...pending, error: e.message || "Create failed" } });
    }
  },

  // ── Editor tabs + content cache ──────────────────────
  /** Absolute paths of files currently open as tabs. */
  openFiles: [],
  /** Path of the active tab, or null when nothing is open. */
  activeFile: null,
  /**
   * path -> {
   *   content, size, truncated, isBinary, mtimeMs,
   *   loading?, error?,
   *   editing?: bool, draft?: string, dirty?: bool, saveError?: string,
   * }
   */
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
      const data = await workspaceApi.getFile(filePath);
      // Always seed `draft` with the loaded content so the editor is
      // immediately writable for non-binary, non-truncated files. `dirty`
      // stays false until the user actually changes something.
      set((s) => ({
        fileContents: {
          ...s.fileContents,
          [filePath]: {
            ...data,
            loading: false,
            draft: data.content ?? "",
            dirty: false,
          },
        },
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
    const cur = get().fileContents[filePath];
    if (cur?.dirty) {
      // eslint-disable-next-line no-alert
      const ok = window.confirm(
        `"${filePath.split("/").pop()}" has unsaved changes. Discard them?`
      );
      if (!ok) return;
    }
    set((s) => {
      const openFiles = s.openFiles.filter((p) => p !== filePath);
      let activeFile = s.activeFile;
      if (s.activeFile === filePath) {
        const idx = s.openFiles.indexOf(filePath);
        activeFile = openFiles[idx] ?? openFiles[idx - 1] ?? null;
      }
      // Drop the cached draft for the closed file so re-opening reloads
      // fresh content. Keep the rest of `fileContents[path]` to make
      // re-opening near-instant — `openFile` early-returns when it sees
      // a cached entry, but we need to delete the entry entirely so it
      // re-fetches and re-seeds `draft` with the latest disk content.
      const next = { ...s.fileContents };
      delete next[filePath];
      return { openFiles, activeFile, fileContents: next };
    });
  },

  setActiveFile: (filePath) => set({ activeFile: filePath }),

  // ── Editing ──────────────────────────────────────────
  setDraft: (filePath, content) => {
    set((s) => {
      const cur = s.fileContents[filePath];
      if (!cur) return s;
      return {
        fileContents: {
          ...s.fileContents,
          [filePath]: {
            ...cur,
            draft: content,
            dirty: content !== (cur.content ?? ""),
            saveError: null,
          },
        },
      };
    });
  },

  saveActiveFile: async () => {
    const filePath = get().activeFile;
    if (!filePath) return;
    const cur = get().fileContents[filePath];
    if (!cur || !cur.dirty) return;
    try {
      const data = await workspaceApi.saveFile(filePath, cur.draft, cur.mtimeMs);
      set((s) => ({
        fileContents: {
          ...s.fileContents,
          [filePath]: { ...data, loading: false, draft: data.content, dirty: false },
        },
      }));
    } catch (e) {
      set((s) => ({
        fileContents: {
          ...s.fileContents,
          [filePath]: { ...s.fileContents[filePath], saveError: e.message || "Save failed" },
        },
      }));
    }
  },
}));
