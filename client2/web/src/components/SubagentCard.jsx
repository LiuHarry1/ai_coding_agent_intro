import React, { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import ToolRowHeader from "./ToolRowHeader.jsx";
import { pickCard, SUPPRESSED_TOOL_CARDS } from "./pickToolCard.js";

/**
 * Dedicated card for subagent invocations (explore / plan / general_purpose).
 *
 * A subagent isn't a single tool call — it spawns a whole nested agent run
 * with its own tool steps and a final text report. This card surfaces:
 *
 *   1. Subagent type + task as the headline (no JSON in sight).
 *   2. A nested list of fully-interactive tool cards (same components the
 *      main agent uses for read_file / bash / list_dir / etc.). Each nested
 *      step is independently expandable, copyable, and shows its own args
 *      and result — fixing the "can't click into steps" problem the flat
 *      one-line list had.
 *   3. The final `result` text rendered as markdown — the value the parent
 *      agent reads, so the value the human user most wants to skim. Always
 *      visible when present, never collapsed.
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

/** "Listed 1 dir, read 7 files, ran 14 commands." */
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

  const steps = useMemo(() => {
    const raw = Array.isArray(part.subagentParts) ? part.subagentParts : [];
    // Hide nested tool calls that have a non-tool-card path elsewhere
    // (e.g. todo_write → TodoListCard). Keeps the dispatch consistent
    // with the main message stream.
    return raw.filter(
      (s) => s.type === "tool_call" && !SUPPRESSED_TOOL_CARDS.has(s.name),
    );
  }, [part.subagentParts]);

  // Both the card and the process list default open: when the subagent
  // is running, the user wants to see live progress; when it's done, the
  // steps are still useful context next to the final report. The chip in
  // the header lets the user collapse the steps if they're noisy.
  const [cardOpen, setCardOpen] = useState(true);
  const [stepsOpen, setStepsOpen] = useState(true);
  const [showAllSteps, setShowAllSteps] = useState(false);

  const summary = useMemo(() => summarizeSteps(steps), [steps]);

  const visibleSteps = showAllSteps ? steps : steps.slice(0, STEP_PREVIEW_LIMIT);
  const hiddenCount = steps.length - visibleSteps.length;

  // Title row: type label + middot + task (truncated to one line via CSS).
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

  // Clickable step-count chip in the header. Toggles only the process
  // list, independent of the card-level chevron and the report.
  const stepChip = steps.length > 0 ? (
    <button
      type="button"
      className={`subagent-step-chip ${stepsOpen ? "open" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        setStepsOpen((v) => !v);
      }}
      aria-expanded={stepsOpen}
      aria-label={stepsOpen ? "Hide steps" : "Show steps"}
    >
      <span className="subagent-step-chip-arrow" aria-hidden="true">
        {"\u25B8"}
      </span>
      {steps.length} step{steps.length === 1 ? "" : "s"}
    </button>
  ) : null;

  return (
    <div
      className={`subagent-card subagent-card--${meta.kind} ${isError ? "has-error" : ""}`}
    >
      <ToolRowHeader
        expanded={cardOpen}
        onToggle={() => setCardOpen((v) => !v)}
        icon={meta.icon}
        label={meta.label}
        title={titleContent}
        titleTooltip={task}
        meta={stepChip}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess
      />

      {cardOpen && (
        <div className="subagent-body">
          {summary && (
            <div className="subagent-summary">{summary}</div>
          )}

          {steps.length > 0 && stepsOpen && (
            <div className="subagent-steps">
              {visibleSteps.map((s, i) => {
                const Card = pickCard(s);
                return <Card key={i} part={s} />;
              })}
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
            </div>
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
