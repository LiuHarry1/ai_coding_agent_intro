import React, { useState, useEffect, useRef } from "react";
import DiffViewer from "./DiffViewer.jsx";
import FilePreview from "./FilePreview.jsx";
import CopyButton from "./CopyButton.jsx";
import { fileName, formatDuration, formatBytes } from "../lib/utils.js";

/**
 * Compact "file-centric" card used for write_file and edit_file in place of
 * the generic ToolCallCard. Heavily inspired by Cursor / Continue / Copilot
 * Chat: filename is the headline, change-count badge replaces the tool name,
 * a colored left stripe distinguishes create vs edit, and the file content
 * (FilePreview / DiffViewer) is always inline — no "Arguments" wrapper.
 *
 * Falls back to ToolCallCard's behavior in two cases:
 *   - The model produced an Error result → still render the file (so users
 *     can see what it tried to write) plus a red Error footer.
 *   - The args don't have the expected fields yet (e.g. mid-stream before
 *     parsing completes and we have no preview) → render an empty body with
 *     just the header so the user sees something is happening.
 */

function LivePreviewInline({ text, fileName: fName, startTime }) {
  const ref = useRef(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);

  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const bytes = text?.length ?? 0;

  return (
    <div className="file-change-live">
      <div className="file-change-live-meta">
        Writing… {formatBytes(bytes)} · {elapsed}s
      </div>
      <pre className="file-change-live-code" ref={ref}>{text || ""}</pre>
    </div>
  );
}

/**
 * Count line-level additions/removals between two strings. Mirrors the
 * "+N -M" badges shown by Cursor / Continue diff cards. We treat a single
 * old_string → new_string substitution as the diff (rest of the file is
 * unchanged), which matches edit_file's actual semantics.
 */
function diffLineCounts(oldStr, newStr) {
  const oldLines = (oldStr ?? "").split("\n").length;
  const newLines = (newStr ?? "").split("\n").length;
  // Trailing newline produces an empty final entry.
  const norm = (s) => (s.endsWith("\n") ? s.length - 1 : s.length);
  const removed = oldLines - (oldStr === "" ? 1 : 0);
  const added = newLines - (newStr === "" ? 1 : 0);
  // Lines that exist in both are reported as ADDED if newer side has more —
  // we don't have a real LCS here. Good enough for a header badge.
  void norm;
  return { added: Math.max(added, 0), removed: Math.max(removed, 0) };
}

/**
 * Inline counts shown after the filename (e.g. `+12` for write, `+3 -1`
 * for edit). Bare colored text — no pill, matches the Cursor
 * inline-row style. Returns null when there's nothing to count.
 */
function ChangeBadge({ kind, args }) {
  if (kind === "write") {
    const lines = (args?.content ?? "").split("\n").length;
    const visible = (args?.content ?? "").endsWith("\n") ? lines - 1 : lines;
    if (visible <= 0) return null;
    return <span className="file-change-count file-change-count--add">+{visible}</span>;
  }
  if (kind === "edit") {
    const { added, removed } = diffLineCounts(args?.old_string, args?.new_string);
    if (added === 0 && removed === 0) return null;
    return (
      <span className="file-change-count">
        {added > 0 && <span className="file-change-count--add">+{added}</span>}
        {added > 0 && removed > 0 && " "}
        {removed > 0 && <span className="file-change-count--remove">-{removed}</span>}
      </span>
    );
  }
  return null;
}

/** Heuristic: short changes are more useful visible than collapsed. */
const ALWAYS_OPEN_LINE_THRESHOLD = 8;
const COLLAPSED_PREVIEW_LINES = 4;

function ContentPreview({ text }) {
  const lines = (text || "").split("\n").slice(0, COLLAPSED_PREVIEW_LINES);
  return (
    <pre className="file-change-collapsed-preview">{lines.join("\n")}</pre>
  );
}

/**
 * Compact single-line fallback used when a write_file / edit_file tool_call
 * is missing the file_path argument. Two scenarios:
 *   1. Mid-stream — tool_input_start fired but no useful args have arrived
 *      yet. We show a "preparing…" stub with a spinner. (Bug fix for stale
 *      phantom cards left behind when the model never finished the call.)
 *   2. Done — the tool call completed without a file_path (almost always
 *      paired with a backend "Missing tool result for write_file" synthetic
 *      error). We surface it clearly as an error row, not a green "+N"
 *      success card.
 */
function FileChangeStub({ name, isDone, isError, result, duration, liveInputBytes }) {
  let status;
  if (!isDone) {
    const sizeLabel =
      liveInputBytes != null && liveInputBytes > 0
        ? formatBytes(liveInputBytes)
        : "preparing…";
    status = (
      <>
        <span className="file-change-stub-meta">{sizeLabel}</span>
        <span className="spinner spinner-sm" />
      </>
    );
  } else {
    status = (
      <>
        {duration && <span className="file-change-stub-meta">{duration}</span>}
        <span className="file-change-status file-change-status--error">{"\u2717"}</span>
      </>
    );
  }
  return (
    <div className={`file-change-stub ${isError ? "has-error" : ""}`}>
      <div className="file-change-stub-row">
        <span className="file-change-stub-icon" aria-hidden="true">{"\u270E"}</span>
        <span className="file-change-stub-name">{name || "tool_call"}</span>
        <span className="file-change-stub-label">
          {isDone ? "missing file_path" : "preparing arguments"}
        </span>
        <span className="file-change-stub-spacer" />
        {status}
      </div>
      {isDone && isError && typeof result === "string" && (
        <div className="file-change-stub-error">{result}</div>
      )}
    </div>
  );
}

export default function FileChangeCard({ part }) {
  const name = part.name || "";
  const args = part.args || {};
  const result = part.result;
  const isDone = part.status === "done";
  const isError = isDone && typeof result === "string" && result.startsWith("Error:");
  const duration = formatDuration(part.duration);
  const filePath = args.file_path || args.path || null;
  const isWrite = name === "Write";
  const kind = isWrite ? "write" : "edit";
  const icon = isWrite ? "\u{1F4C4}" : "\u270E"; // 📄 / ✎
  const hasLivePreview =
    !isDone && typeof part.livePreview === "string" && part.livePreview.length > 0;

  // The model sometimes opens a tool_call but never produces a usable
  // payload — either the upstream stream gets dropped (we see
  // tool_input_start with no deltas → phantom card), or it finishes the
  // call without ever filling in file_path (we see a "done" tool_call
  // with content but no path → backend then synthesizes a "Missing tool
  // result" error). Both used to render as a full-size "(unknown) 0 chars"
  // / "(unknown) +1 ✗" card that looked like a normal write — extremely
  // confusing.
  //
  // BUT: during the normal streaming path, file_path is also temporarily
  // absent — `tool-input-start` fires with empty args, then preview deltas
  // arrive (livePreview grows), and `tool-call` with the real args only
  // lands at the end. We must NOT swap to a stub in that window, or the
  // user loses the live "Writing README.md…" preview that's the whole
  // point of streaming. So: only fall back to the stub when we genuinely
  // have nothing to show (no path, no live preview, no buffered content).
  const hasArgsContent =
    (isWrite ? typeof args.content === "string" && args.content.length > 0 : false) ||
    (!isWrite && (typeof args.new_string === "string" || typeof args.old_string === "string"));
  const hasAnythingToShow = hasLivePreview || hasArgsContent;
  if (!filePath && !hasAnythingToShow) {
    return (
      <FileChangeStub
        name={name}
        isDone={isDone}
        isError={isError || isDone}
        result={result}
        duration={duration}
        liveInputBytes={part.liveInputBytes}
      />
    );
  }
  // If file_path is still missing while we DO have streaming content, use
  // a soft placeholder name — the real one will arrive with the final
  // tool-call event and React will rerender. If we're already done and the
  // path never came, surface that fact rather than silently labeling a
  // file "(unknown)".
  const fName =
    fileName(filePath) ||
    filePath ||
    (isDone ? "(missing file_path)" : "writing…");

  // Compute changed-line count to decide default expansion. Short edits
  // (≤ 8 lines) stay open because hiding a 3-line typo behind a click is
  // worse than just showing it. Long writes/edits fold to a 4-line preview.
  const previewSource = isWrite ? args.content : args.new_string;
  const changedLineCount = previewSource ? (previewSource.match(/\n/g)?.length ?? 0) + 1 : 0;
  const shouldAutoExpand =
    !isDone || hasLivePreview || isError || changedLineCount <= ALWAYS_OPEN_LINE_THRESHOLD;
  const [expanded, setExpanded] = useState(shouldAutoExpand);
  // If args become available later (mid-stream → done) recompute auto-expand
  // once. Don't override user's manual toggle after that.
  const [userToggled, setUserToggled] = useState(false);
  useEffect(() => {
    if (!userToggled) setExpanded(shouldAutoExpand);
  }, [shouldAutoExpand, userToggled]);

  // Decide what to render in the body. Order of preference:
  //   1. Live preview while streaming (always wins, fresh feedback).
  //   2. Final args once the tool_call payload is parsed (DiffViewer / FilePreview).
  //   3. Nothing (placeholder) if neither is available yet — header alone is enough.
  // Children render in `embedded` mode so they skip their built-in headers
  // (filename + copy button) — those live in our header instead, avoiding
  // a duplicated "📄 README.md  📄 README.md" stack.
  let body = null;
  let copyText = null;
  let extraMeta = null;
  if (hasLivePreview) {
    body = <LivePreviewInline text={part.livePreview} fileName={fName} startTime={part.liveInputStart} />;
  } else if (isWrite && typeof args.content === "string") {
    body = <FilePreview content={args.content} filePath={filePath} embedded />;
    copyText = args.content;
    const lines = args.content.split("\n");
    const visible = args.content.endsWith("\n") ? lines.length - 1 : lines.length;
    extraMeta = `${visible} lines`;
  } else if (!isWrite && typeof args.old_string === "string" && typeof args.new_string === "string") {
    body = (
      <DiffViewer
        oldStr={args.old_string}
        newStr={args.new_string}
        filePath={filePath}
        replaceAll={args.replace_all}
        embedded
      />
    );
    copyText = args.new_string;
    if (args.replace_all) extraMeta = "replace all";
  }

  const toggle = () => {
    setUserToggled(true);
    setExpanded((v) => !v);
  };
  // Stop the click from bubbling up from the inline copy button.
  const stop = (e) => e.stopPropagation();

  return (
    <div className={`file-change-card file-change-card--${kind} ${isError ? "has-error" : ""}`}>
      <button
        type="button"
        className="file-change-header"
        onClick={toggle}
        aria-expanded={expanded}
      >
        <span className={`file-change-chevron ${expanded ? "open" : ""}`} aria-hidden="true">
          {"\u25B6"}
        </span>
        <span className="file-change-icon" aria-hidden="true">{icon}</span>
        <span className="file-change-name" title={filePath || ""}>{fName}</span>
        {isDone && <ChangeBadge kind={kind} args={args} />}
        {extraMeta && isDone && <span className="file-change-extra-meta">{extraMeta}</span>}
        <span className="file-change-spacer" />
        {!isDone && part.liveInputBytes != null && !hasLivePreview && (
          <span className="file-change-progress">{formatBytes(part.liveInputBytes)}</span>
        )}
        {duration && isDone && <span className="file-change-duration">{duration}</span>}
        {isDone && copyText != null && (
          <span onClick={stop}>
            <CopyButton text={copyText} label="Copy" inline />
          </span>
        )}
        {isDone ? (
          isError
            ? <span className="file-change-status file-change-status--error">{"\u2717"}</span>
            : <span className="file-change-status file-change-status--ok">{"\u2713"}</span>
        ) : (
          <span className="spinner" />
        )}
      </button>

      {expanded && body && <div className="file-change-body">{body}</div>}
      {!expanded && isDone && previewSource && (
        <div className="file-change-body file-change-body--collapsed" onClick={toggle}>
          <ContentPreview text={previewSource} />
        </div>
      )}

      {isError && (
        <div className="file-change-error">
          {result}
        </div>
      )}
    </div>
  );
}
