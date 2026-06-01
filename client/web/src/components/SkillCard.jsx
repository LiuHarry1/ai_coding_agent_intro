import React, { useState } from "react";
import CopyButton from "./CopyButton.jsx";
import ToolRowHeader from "./ToolRowHeader.jsx";
import { detectError, formatBytes } from "../lib/utils.js";

/**
 * Compact row for Skill — `Skill · pptx`, not raw JSON args.
 * Matches Cursor/CC: skill name is the headline; arguments stay in tooltip.
 */
function skillArgsHint(args) {
  const raw = args?.arguments;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = raw.trim();
  return t.length > 72 ? `${t.slice(0, 72)}\u2026` : t;
}

export default function SkillCard({ part, nested = false }) {
  const [expanded, setExpanded] = useState(false);
  const args = part.args || {};
  const result = part.result;
  const isDone = part.status === "done";
  const isError = isDone && detectError("Skill", result);
  const skillName = args.skill_name || args.skill || "";
  const hint = skillArgsHint(args);
  const hasBody = typeof result === "string" && result.length > 0;
  const sizeLabel = isDone && !isError && hasBody ? formatBytes(result.length) : null;

  return (
    <div className={`tool-row skill-card ${nested ? "tool-row--nested" : ""} ${isError ? "has-error" : ""}`}>
      <ToolRowHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        showChevron={Boolean(isDone && hasBody)}
        icon={"\u2699"}
        label="Skill"
        title={skillName || "\u2026"}
        titleTooltip={[skillName, hint].filter(Boolean).join("\n") || undefined}
        subtitle={hint}
        meta={
          sizeLabel ? (
            <span className="tool-row-meta-badge" title="Result size">
              {sizeLabel}
            </span>
          ) : null
        }
        duration={nested ? undefined : part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess={!nested}
        actions={
          isDone && !isError && hasBody ? (
            <CopyButton text={result} label="Copy" inline />
          ) : null
        }
      />

      {expanded && isDone && !isError && hasBody && (
        <pre className="tool-row-body">{result}</pre>
      )}
      {expanded && isError && (
        <div className="tool-row-body tool-row-body--error">{result}</div>
      )}
    </div>
  );
}
