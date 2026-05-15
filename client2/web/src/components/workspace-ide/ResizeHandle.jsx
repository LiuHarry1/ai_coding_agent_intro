import React, { useEffect, useRef } from "react";

/**
 * 4-6px wide vertical drag bar pinned to the IDE panel's right edge.
 *
 * While dragging, we attach window-level mousemove/mouseup listeners (so
 * the drag keeps working when the cursor leaves the handle) and add a
 * page-wide CSS class that locks the cursor to col-resize and suppresses
 * text selection — without this the chat side fights the drag by trying
 * to select text. Movement is RAF-throttled to keep React updates cheap.
 */
export default function ResizeHandle({ onResize, onReset }) {
  const dragging = useRef(false);
  const rafId = useRef(0);
  const latestX = useRef(0);

  useEffect(() => () => cancelAnimationFrame(rafId.current), []);

  const handleMouseDown = (e) => {
    e.preventDefault();
    dragging.current = true;
    document.body.classList.add("is-resizing-ide");

    const onMove = (ev) => {
      latestX.current = ev.clientX;
      if (rafId.current) return;
      rafId.current = requestAnimationFrame(() => {
        rafId.current = 0;
        if (dragging.current) onResize(latestX.current);
      });
    };
    const onUp = () => {
      dragging.current = false;
      document.body.classList.remove("is-resizing-ide");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      className="workspace-ide-resize"
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      title="Drag to resize · double-click to reset"
      role="separator"
      aria-orientation="vertical"
    />
  );
}
