import React, { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import ToolRowHeader from "./ToolRowHeader.jsx";
import { fileName } from "../lib/utils.js";

/**
 * Dedicated card for subagent invocations (explore / plan / general_purpose).
 *
 * A subagent isn't really a single tool call — it spawns a whole nested
 * agent run with its own tool steps and a final text report. The generic
 * ToolCallCard renders it identically to a one-shot tool (JSON args header
 * + collapsed result), which buries the actual content. This card surfaces:
 *
 *   1. Subagent type + task as the headline (no JSON in sight).
 *   2. A compact one-row-per-step timeline of nested tool calls so the user
 *      can see what the subagent actually did.
 *   3. The final `result` text rendered as markdown — this is the value the
 *      parent agent will read, so it's also the value the user most wants
 *      to skim.
 *
 * Visual contract:
 *   explore        → purple stripe / 🔍
 *   plan           → amber  stripe / 🗒️
 *   general_purpose→ slate  stripe / 🤖
 *   anything else  → same as general_purpose (forward-compatible fallback)
 */

const TYPE_META = {
  explore: { kind: "explore", icon: "\u{1F50D}", label: "Explore" },
  plan: { kind: "plan", icon: "\u{1F5C2}", label: "Plan" },
  general_purpose: { kind: "agent", icon: "\u{1F916}", label: "Agent" },
};

function typeMetaFor(name) {
  if (TYPE_META[name]) return TYPE_META[name];
  // Forward-compat: any other subagent name renders with the generic "Agent"
  // style but uses its own label so the user can still tell them apart.
  const pretty = name
    ? name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "Agent";
  return { kind: "agent", icon: "\u{1F916}", label: pretty };
}

/**
 * Render the args of a nested tool call as a one-line tail string.
 * Mirrors ToolCallCard.formatArgs heuristics but tuned shorter — these
 * appear in a dense timeline list, not a standalone card.
 */
function shortArgs(name, args) {
  if (!args || typeof args !== "object") return "";
  if (args.file_path) return fileName(args.file_path) || args.file_path;
  if (args.path) return fileName(args.path) || args.path;
  if (args.command)
    return args.command.length > 60
      ? args.command.slice(0, 57) + "\u2026"
      : args.command;
  if (args.pattern) return args.pattern;
  if (args.query) return `\u201C${args.query}\u201D`;
  if (args.url) {
    try {
      return new URL(args.url).hostname.replace(/^www\./, "");
    } catch {
      return args.url.slice(0, 40);
    }
  }
  if (args.task)
    return args.task.length > 60
      ? args.task.slice(0, 57) + "\u2026"
      : args.task;
  return "";
}

/**
 * Single compact row inside the timeline. Not a full card — we don't want
 * three levels of nested chevrons. If the user wants to dig into a specific
 * step they can rerun a query that targets it.
 */
function NestedStepRow({ part }) {
  const name = part.name || "tool";
  const args = part.args || {};
  const result = part.result;
  const isDone = part.status === "done";
  const isError =
    isDone &&
    typeof result === "string" &&
    (result.startsWith("Error:") || /\[exit code: [^0]/.test(result));
  const args1 = shortArgs(name, args);
  return (
    <li className={`subagent-step ${isError ? "subagent-step--error" : ""}`}>
      <span
        className="subagent-step-status"
        aria-label={isDone ? (isError ? "failed" : "done") : "running"}
      >
        {!isDone
          ? "\u25CB"
          : isError
            ? "\u2717"
            : "\u2713"}
      </span>
      <span className="subagent-step-name">{name}</span>
      {args1 && (
        <span className="subagent-step-args" title={args1}>
          {args1}
        </span>
      )}
    </li>
  );
}

/** "Searched 4 dirs, read 3 files, ran 2 commands." */
function summarizeSteps(steps) {
  const counts = {};
  for (const s of steps) {
    const n = s.name || "other";
    counts[n] = (counts[n] || 0) + 1;
  }
  const phrases = [];
  if (counts.list_dir) phrases.push(`listed ${counts.list_dir} dir${counts.list_dir > 1 ? "s" : ""}`);
  if (counts.read_file) phrases.push(`read ${counts.read_file} file${counts.read_file > 1 ? "s" : ""}`);
  if (counts.grep) phrases.push(`${counts.grep} search${counts.grep > 1 ? "es" : ""}`);
  if (counts.bash) phrases.push(`ran ${counts.bash} command${counts.bash > 1 ? "s" : ""}`);
  if (counts.web_search) phrases.push(`${counts.web_search} web search${counts.web_search > 1 ? "es" : ""}`);
  if (counts.web_fetch) phrases.push(`${counts.web_fetch} fetch${counts.web_fetch > 1 ? "es" : ""}`);
  if (counts.write_file) phrases.push(`wrote ${counts.write_file} file${counts.write_file > 1 ? "s" : ""}`);
  if (counts.edit_file) phrases.push(`edited ${counts.edit_file} file${counts.edit_file > 1 ? "s" : ""}`);
  if (phrases.length === 0) return null;
  // Capitalize first letter for prose feel.
  const joined = phrases.join(", ");
  return joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
}

const STEP_PREVIEW_LIMIT = 6;

export default function SubagentCard({ part }) {
  const name = part.name || "subagent";
  const args = part.args || {};
  const result = part.result;
  const task = args.task || "";
  const isDone = part.status === "done";
  const isError =
    isDone && typeof result === "string" && result.startsWith("Error:");
  const meta = typeMetaFor(name);

  const steps = Array.isArray(part.subagentParts) ? part.subagentParts : [];

  // Default open while the subagent is running (so the user sees progress)
  // and on completion (so the final report is immediately visible — the
  // whole point of running a subagent is to read its answer). Manual toggle
  // wins after that.
  const [expanded, setExpanded] = useState(true);
  const [showAllSteps, setShowAllSteps] = useState(false);

  const summary = useMemo(() => summarizeSteps(steps), [steps]);

  const visibleSteps = showAllSteps ? steps : steps.slice(0, STEP_PREVIEW_LIMIT);
  const hiddenCount = steps.length - visibleSteps.length;

  // The task description sits next to the label, separated by a middot,
  // and truncates with ellipsis to keep the row to one line.
  const titleContent = task ? (
    <>
      <span className="subagent-sep" aria-hidden="true">
        {"\u00B7"}
      </span>
      <span className="subagent-task" title={task}>
        {task}
      </span>
    </>
  ) : null;

  return (
    <div
      className={`subagent-card subagent-card--${meta.kind} ${isError ? "has-error" : ""}`}
    >
      <ToolRowHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        icon={meta.icon}
        label={meta.label}
        title={titleContent}
        titleTooltip={task}
        meta={
          steps.length > 0 ? (
            <span className="subagent-step-count">
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </span>
          ) : null
        }
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess
      />

      {expanded && (
        <div className="subagent-body">
          {summary && (
            <div className="subagent-summary">{summary}</div>
          )}

          {steps.length > 0 && (
            <ul className="subagent-steps-list">
              {visibleSteps.map((s, i) => (
                <NestedStepRow key={i} part={s} />
              ))}
            </ul>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              className="subagent-more"
              onClick={(e) => {
                e.stopPropagation();
                setShowAllSteps(true);
              }}
            >
              Show {hiddenCount} more step{hiddenCount === 1 ? "" : "s"}
            </button>
          )}

          {/* Final report from the subagent. This is the text the parent
              agent will read on its next turn, and the single most useful
              piece of information for the human user. Always shown when
              available, never collapsed inside another details/summary. */}
          {isDone && typeof result === "string" && result.length > 0 && (
            <div
              className={`subagent-report ${isError ? "subagent-report--error" : ""}`}
            >
              {isError ? (
                <pre className="subagent-report-error">{result}</pre>
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                >
                  {result}
                </ReactMarkdown>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
