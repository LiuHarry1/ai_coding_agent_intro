import React, { useRef, useCallback, useState } from "react";
import { useChatStore } from "../stores/chat-store.js";

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

export default function InputArea() {
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const [images, setImages] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  const addImageFiles = useCallback(async (files) => {
    const remaining = MAX_IMAGES - images.length;
    const toProcess = files.slice(0, remaining);
    const dataUrls = await Promise.all(toProcess.map(fileToDataURL));
    setImages((prev) => [...prev, ...dataUrls].slice(0, MAX_IMAGES));
  }, [images.length]);

  const removeImage = useCallback((idx) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, []);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [isStreaming, images]
  );

  const handleSend = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const text = el.value.trim();
    if ((!text && images.length === 0) || isStreaming) return;
    el.value = "";
    el.style.height = "auto";
    sendMessage(text || "(image)", images);
    setImages([]);
  }, [sendMessage, isStreaming, images]);

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
            placeholder="Describe your task... (paste or drop images)"
            onInput={handleInput}
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
        Enter to send &middot; Shift+Enter for new line &middot; Paste or drag images
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
