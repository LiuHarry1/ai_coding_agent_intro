import React, { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { useChatStore } from "../stores/chat-store.js";
import ModePicker from "./ModePicker.jsx";
import { agentApi } from "../lib/api/agent.js";
import { workspaceApi } from "../lib/api/workspace.js";
import {
  extractCompletionToken,
  extractSearchToken,
  formatAtMentionReplacement,
  applyFileSuggestion,
  toWorkspaceRelative,
  insertTextAtCursor,
} from "../lib/at-mention.js";

const MAX_IMAGES = 5;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function extractDroppedFiles(dataTransfer) {
  const files = [];
  if (!dataTransfer?.items) return files;
  for (const item of dataTransfer.items) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

function extractImages(dataTransfer) {
  return extractDroppedFiles(dataTransfer).filter((f) =>
    ACCEPTED_TYPES.includes(f.type),
  );
}

function isImageFile(file) {
  return ACCEPTED_TYPES.includes(file.type);
}

/** Returns partial name after `/`, or null when not in slash-pick mode. */
function getSlashFilter(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  if (rest.includes(" ") || rest.includes("\n")) return null;
  return rest.toLowerCase();
}

const INITIAL_VISIBLE = 5;

/** Group flat matches into sections: Skills, Commands, Built-in. */
function groupEntries(matches) {
  const skills = matches.filter((e) => e.kind === "skill");
  const commands = matches.filter((e) => e.kind === "command");
  const builtins = matches.filter((e) => e.kind === "built-in");
  const groups = [];
  if (skills.length > 0) groups.push({ label: "Skills", items: skills });
  if (commands.length > 0) groups.push({ label: "Commands", items: commands });
  if (builtins.length > 0) groups.push({ label: "Built-in", items: builtins });
  return groups;
}

const MODE_PLACEHOLDERS = {
  agent: "Describe your task… @file",
  ask: "Ask about your codebase…",
  plan: "Plan your implementation…",
};

export default function InputArea() {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const workspace = useChatStore((s) => s.workspace);
  const agentMode = useChatStore((s) => s.agentMode);
  const cycleAgentMode = useChatStore((s) => s.cycleAgentMode);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const [images, setImages] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [inputValue, setInputValue] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [slashEntries, setSlashEntries] = useState([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [expandedSections, setExpandedSections] = useState(new Set());
  const [atSuggestions, setAtSuggestions] = useState([]);
  const [atIndex, setAtIndex] = useState(0);
  const [uploadingDrop, setUploadingDrop] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await agentApi.getSlashCommands(workspace || undefined);
        if (!cancelled && Array.isArray(data.entries)) {
          setSlashEntries(data.entries);
        }
      } catch {
        if (!cancelled) setSlashEntries([]);
      }
    })();
    return () => { cancelled = true; };
  }, [workspace]);

  const syncCursor = useCallback(() => {
    const el = textareaRef.current;
    if (el) setCursorPos(el.selectionStart ?? 0);
  }, []);

  const slashFilter = useMemo(() => getSlashFilter(inputValue), [inputValue]);

  const slashMatches = useMemo(() => {
    if (slashFilter === null) return [];
    return slashEntries.filter((e) =>
      e.name.toLowerCase().startsWith(slashFilter),
    );
  }, [slashEntries, slashFilter]);

  const showSlashMenu = slashFilter !== null && slashMatches.length > 0;

  const atToken = useMemo(() => {
    if (showSlashMenu) return null;
    return extractCompletionToken(inputValue, cursorPos, true);
  }, [inputValue, cursorPos, showSlashMenu]);

  const showAtMenu =
    atToken?.token.startsWith("@") && atSuggestions.length > 0 && !showSlashMenu;

  const slashGroups = useMemo(() => groupEntries(slashMatches), [slashMatches]);

  const flatVisible = useMemo(() => {
    const flat = [];
    for (const g of slashGroups) {
      const expanded = expandedSections.has(g.label);
      const shown = expanded ? g.items : g.items.slice(0, INITIAL_VISIBLE);
      for (const item of shown) flat.push(item);
    }
    return flat;
  }, [slashGroups, expandedSections]);

  useEffect(() => {
    setSlashIndex(0);
    setExpandedSections(new Set());
  }, [slashFilter, slashMatches.length]);

  useEffect(() => {
    setAtIndex(0);
  }, [atToken?.token, atSuggestions.length]);

  // Clear stale suggestions when workspace changes.
  useEffect(() => {
    setAtSuggestions([]);
  }, [workspace]);

  // Debounced @ file search (CC useTypeahead debouncedFetchFileSuggestions)
  useEffect(() => {
    if (!atToken?.token.startsWith("@") || showSlashMenu || !workspace) {
      setAtSuggestions([]);
      return undefined;
    }
    const searchToken = extractSearchToken(atToken);
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await workspaceApi.searchFiles(searchToken, workspace);
        if (!cancelled && Array.isArray(data.entries)) {
          setAtSuggestions(data.entries);
        }
      } catch {
        if (!cancelled) setAtSuggestions([]);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [atToken, showSlashMenu, workspace]);

  const addImageFiles = useCallback(async (files) => {
    const remaining = MAX_IMAGES - images.length;
    const toProcess = files.slice(0, remaining);
    const dataUrls = await Promise.all(toProcess.map(fileToDataURL));
    setImages((prev) => [...prev, ...dataUrls].slice(0, MAX_IMAGES));
  }, [images.length]);

  const removeImage = useCallback((idx) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleInput = useCallback((e) => {
    setInputValue(e.target.value);
    setCursorPos(e.target.selectionStart ?? 0);
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, []);

  const applySlashSelection = useCallback((entry) => {
    const el = textareaRef.current;
    if (!el) return;
    const hint = entry.argumentHint ? ` ${entry.argumentHint}` : " ";
    const next = `/${entry.name}${hint}`;
    el.value = next;
    setInputValue(next);
    el.focus();
    const pos = `/${entry.name} `.length;
    el.setSelectionRange(pos, pos);
    setCursorPos(pos);
    handleInput({ target: el });
  }, [handleInput]);

  const applyAtSelection = useCallback(
    (entry) => {
      const el = textareaRef.current;
      if (!el || !atToken) return;
      const hasAtPrefix = atToken.token.startsWith("@");
      const needsQuotes = entry.path.includes(" ");
      const replacementValue = formatAtMentionReplacement(entry.path, {
        hasAtPrefix,
        needsQuotes,
        isQuoted: atToken.isQuoted,
        isDir: entry.isDir,
      });
      const { newInput, newCursorPos } = applyFileSuggestion(
        replacementValue,
        inputValue,
        atToken.token,
        atToken.startPos,
      );
      el.value = newInput;
      setInputValue(newInput);
      el.setSelectionRange(newCursorPos, newCursorPos);
      setCursorPos(newCursorPos);
      el.focus();
      if (!entry.isDir) setAtSuggestions([]);
      handleInput({ target: el });
    },
    [atToken, inputValue, handleInput],
  );

  const insertAtMentions = useCallback(
    (relativePaths) => {
      const el = textareaRef.current;
      if (!el || relativePaths.length === 0) return;
      const mentions = relativePaths
        .filter(Boolean)
        .map((p) => (p.includes(" ") ? `@"${p}" ` : `@${p} `))
        .join("");
      insertTextAtCursor(el, mentions, setInputValue);
      setCursorPos(el.selectionStart ?? 0);
      handleInput({ target: el });
    },
    [handleInput],
  );

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const text = el.value.trim();
    if ((!text && images.length === 0) || isStreaming) return;
    el.value = "";
    setInputValue("");
    setCursorPos(0);
    el.style.height = "auto";
    sendMessage(text || "(image)", images);
    setImages([]);
    setAtSuggestions([]);
  }, [sendMessage, isStreaming, images]);

  const handleKeyDown = useCallback(
    (e) => {
      if (showSlashMenu) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % flatVisible.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => (i - 1 + flatVisible.length) % flatVisible.length);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          applySlashSelection(flatVisible[slashIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          return;
        }
      }

      if (showAtMenu) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtIndex((i) => (i + 1) % atSuggestions.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtIndex((i) => (i - 1 + atSuggestions.length) % atSuggestions.length);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          applyAtSelection(atSuggestions[atIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtSuggestions([]);
          return;
        }
      }

      if (e.key === "Tab" && e.shiftKey && !showSlashMenu && !showAtMenu) {
        e.preventDefault();
        cycleAgentMode();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [
      showSlashMenu,
      flatVisible,
      slashIndex,
      applySlashSelection,
      showAtMenu,
      atSuggestions,
      atIndex,
      applyAtSelection,
      handleSend,
      cycleAgentMode,
    ],
  );

  const handlePaste = useCallback((e) => {
    const files = extractImages(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      addImageFiles(files);
    }
  }, [addImageFiles]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    async (e) => {
      e.preventDefault();
      setDragOver(false);
      const allFiles = extractDroppedFiles(e.dataTransfer);
      const imageFiles = allFiles.filter(isImageFile);
      const otherFiles = allFiles.filter((f) => !isImageFile(f));

      if (imageFiles.length > 0) addImageFiles(imageFiles);

      if (otherFiles.length === 0) return;
      if (!workspace) return;

      setUploadingDrop(true);
      try {
        const result = await workspaceApi.uploadFiles(workspace, otherFiles);
        const paths = (result.uploaded ?? []).map((u) =>
          toWorkspaceRelative(u.path, workspace),
        );
        insertAtMentions(paths);
      } catch (err) {
        console.error("Drop upload failed:", err);
      } finally {
        setUploadingDrop(false);
      }
    },
    [addImageFiles, workspace, insertAtMentions],
  );

  const handleFileChange = useCallback((e) => {
    const files = [...e.target.files].filter((f) => ACCEPTED_TYPES.includes(f.type));
    if (files.length > 0) addImageFiles(files);
    e.target.value = "";
  }, [addImageFiles]);

  return (
    <div
      className={`input-area ${dragOver ? "input-area--dragover" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {showSlashMenu && (
        <div className="slash-menu" role="listbox">
          {slashGroups.map((group) => {
            const expanded = expandedSections.has(group.label);
            const shown = expanded ? group.items : group.items.slice(0, INITIAL_VISIBLE);
            const hiddenCount = group.items.length - shown.length;
            return (
              <div key={group.label} className="slash-menu__group">
                <div className="slash-menu__section">{group.label}</div>
                {shown.map((entry) => {
                  const flatIdx = flatVisible.indexOf(entry);
                  return (
                    <button
                      key={entry.name}
                      type="button"
                      role="option"
                      aria-selected={flatIdx === slashIndex}
                      className={`slash-menu__item${flatIdx === slashIndex ? " slash-menu__item--active" : ""}`}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        applySlashSelection(entry);
                      }}
                    >
                      <div className="slash-menu__row-top">
                        <span className="slash-menu__name">/{entry.name}</span>
                        {entry.argumentHint && (
                          <span className="slash-menu__hint">{entry.argumentHint}</span>
                        )}
                        {entry.context === "fork" && (
                          <span className="slash-menu__badge">fork</span>
                        )}
                      </div>
                      <div className="slash-menu__desc">{entry.description}</div>
                    </button>
                  );
                })}
                {hiddenCount > 0 && (
                  <button
                    type="button"
                    className="slash-menu__show-more"
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      setExpandedSections((prev) => new Set([...prev, group.label]));
                    }}
                  >
                    Show {hiddenCount} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {showAtMenu && (
        <div className="slash-menu at-menu" role="listbox" aria-label="File suggestions">
          <div className="slash-menu__section">Files</div>
          {atSuggestions.map((entry, idx) => (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-selected={idx === atIndex}
              className={`slash-menu__item${idx === atIndex ? " slash-menu__item--active" : ""}`}
              onMouseDown={(ev) => {
                ev.preventDefault();
                applyAtSelection(entry);
              }}
            >
              <div className="slash-menu__row-top">
                <span className="slash-menu__name">
                  @{entry.path}{entry.isDir ? "/" : ""}
                </span>
                {entry.isDir && (
                  <span className="slash-menu__badge">dir</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      <div className={`input-wrapper input-wrapper--${agentMode} ${images.length > 0 ? "has-images" : ""}`}>
        {images.length > 0 && (
          <div className="image-preview-bar">
            {images.map((src, i) => (
              <div key={i} className="image-preview-item">
                <img src={src} alt={`Attachment ${i + 1}`} onClick={() => setLightbox(src)} />
                <button className="image-preview-remove" onClick={() => removeImage(i)} title="Remove">&times;</button>
              </div>
            ))}
          </div>
        )}
        <div className="input-row">
          <ModePicker />
          <button
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
            type="button"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
          <textarea
            ref={textareaRef}
            className="input-textarea"
            rows="1"
            placeholder={MODE_PLACEHOLDERS[agentMode] ?? MODE_PLACEHOLDERS.agent}
            title="Enter to send · Shift+Tab switch mode · Shift+Enter newline"
            value={inputValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onKeyUp={syncCursor}
            onClick={syncCursor}
            onSelect={syncCursor}
            onPaste={handlePaste}
            autoFocus
          />
          {isStreaming ? (
            <button className="composer-btn composer-btn--stop" onClick={stopStreaming} title="Stop" type="button">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className="composer-btn composer-btn--send"
              onClick={handleSend}
              title="Send (Enter)"
              type="button"
              disabled={!inputValue.trim() && images.length === 0}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {dragOver && (
        <div className="drop-overlay">
          {uploadingDrop ? "Uploading…" : "Drop files here (images attach, others → @path)"}
        </div>
      )}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="Preview" />
        </div>
      )}
    </div>
  );
}
