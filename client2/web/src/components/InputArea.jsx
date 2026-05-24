import React, { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { useChatStore } from "../stores/chat-store.js";
import { agentApi } from "../lib/api/agent.js";

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

function extractImages(dataTransfer) {
  const files = [];
  if (!dataTransfer?.items) return files;
  for (const item of dataTransfer.items) {
    if (item.kind === "file" && ACCEPTED_TYPES.includes(item.type)) {
      files.push(item.getAsFile());
    }
  }
  return files;
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

export default function InputArea() {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const workspace = useChatStore((s) => s.workspace);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const [images, setImages] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [inputValue, setInputValue] = useState("");
  const [slashEntries, setSlashEntries] = useState([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [expandedSections, setExpandedSections] = useState(new Set());

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

  const slashFilter = useMemo(() => getSlashFilter(inputValue), [inputValue]);

  const slashMatches = useMemo(() => {
    if (slashFilter === null) return [];
    return slashEntries.filter((e) =>
      e.name.toLowerCase().startsWith(slashFilter),
    );
  }, [slashEntries, slashFilter]);

  const showSlashMenu = slashFilter !== null && slashMatches.length > 0;

  const slashGroups = useMemo(() => groupEntries(slashMatches), [slashMatches]);

  // Build a flat "visible items" list from groups, respecting collapsed state.
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
    handleInput({ target: el });
  }, [handleInput]);

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const text = el.value.trim();
    if ((!text && images.length === 0) || isStreaming) return;
    el.value = "";
    setInputValue("");
    el.style.height = "auto";
    sendMessage(text || "(image)", images);
    setImages([]);
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

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [showSlashMenu, flatVisible, slashIndex, applySlashSelection, handleSend],
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

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const files = extractImages(e.dataTransfer);
    if (files.length > 0) addImageFiles(files);
  }, [addImageFiles]);

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
      <div className={`input-wrapper ${images.length > 0 ? "has-images" : ""}`}>
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
          <button
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
            placeholder="Describe your task… type / for commands & skills"
            value={inputValue}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            autoFocus
          />
          {isStreaming ? (
            <button className="stop-btn" onClick={stopStreaming} title="Stop">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button className="send-btn" onClick={handleSend} title="Send">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="input-hint">
        Enter to send · Shift+Enter newline · / commands & skills · ↑↓ pick
      </div>
      {dragOver && <div className="drop-overlay">Drop images here</div>}
      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="Preview" />
        </div>
      )}
    </div>
  );
}