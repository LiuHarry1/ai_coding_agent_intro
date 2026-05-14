import React, { useState } from "react";
import CopyButton from "./CopyButton.jsx";
import ToolRowHeader from "./ToolRowHeader.jsx";
import { detectError } from "../lib/utils.js";

/**
 * Compact one-line card for bash. Three modes:
 *   - { kill: true, pid }  → "Killed pid N"
 *   - { pid }              → "Checked pid N"
 *   - { command }          → "Ran <command>"
 *
 * Renders the title as `tool-row-title--plain` because a shell command is
 * plain mono text, not a clickable identifier — the default accent color
 * for filenames/queries reads wrong on `git status`.
 */

function describeBash(args) {
  if (!args || typeof args !== "object") return { verb: "Ran", text: "" };
  if (args.kill && args.pid != null) return { verb: "Killed", text: `pid ${args.pid}` };
  if (args.pid != null) return { verb: "Checked", text: `pid ${args.pid}` };
  if (typeof args.command === "string") return { verb: "Ran", text: args.command };
  return { verb: "Ran", text: "" };
}

export default function BashCard({ part }) {
  const [expanded, setExpanded] = useState(false);
  const args = part.args || {};
  const result = part.result;
  const isDone = part.status === "done";
  const isError = isDone && detectError("bash", result);
  const { verb, text } = describeBash(args);
  const hasOutput = typeof result === "string" && result.length > 0;

  return (
    <div className={`tool-row bash-card ${isError ? "has-error" : ""}`}>
      <ToolRowHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        label={verb}
        title={text}
        titlePlain
        titleTooltip={text}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        actions={
          isDone && !isError && hasOutput ? (
            <CopyButton text={result} label="Copy output" inline />
          ) : null
        }
      />

      {expanded && isDone && hasOutput && (
        <pre className={`tool-row-body ${isError ? "tool-row-body--error" : ""}`}>
          {result}
        </pre>
      )}
      {expanded && isDone && !hasOutput && (
        <div className="tool-row-empty">(no output)</div>
      )}
    </div>
  );
}
