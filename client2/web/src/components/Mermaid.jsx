import React, { useEffect, useId, useRef, useState } from "react";
import mermaid from "mermaid";

// One-time global config. Pick a dark theme to match the rest of the chat UI.
let initialized = false;
function ensureInit() {
  if (initialized) return;
  initialized = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    securityLevel: "strict",
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  });
}

/**
 * Render a Mermaid diagram from raw source.
 *
 * Streaming-safe: while the agent is still emitting the code block the
 * source is almost always syntactically invalid. We debounce renders
 * and fall back to a `<pre>` preview on parse errors instead of
 * thrashing the DOM with red error boxes.
 */
export default function Mermaid({ code }) {
  const rawId = useId();
  // useId returns ":r12:"; mermaid uses the id as part of SVG element ids,
  // and colons break CSS selectors / querySelector inside the lib.
  const id = `mmd-${rawId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  const ref = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    ensureInit();
    let cancelled = false;
    const handle = setTimeout(() => {
      mermaid
        .render(id, code)
        .then(({ svg, bindFunctions }) => {
          if (cancelled || !ref.current) return;
          ref.current.innerHTML = svg;
          bindFunctions?.(ref.current);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          // mermaid leaves a stray <div id="dmermaid-…"> on parse failure.
          document.querySelectorAll(`[id^="d${id}"]`).forEach((n) => n.remove());
          setError(String(e?.message || e));
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [code, id]);

  if (error) {
    return (
      <pre className="mermaid-error" title={error}>
        <code>{code}</code>
      </pre>
    );
  }
  return <div className="mermaid-diagram" ref={ref} />;
}
