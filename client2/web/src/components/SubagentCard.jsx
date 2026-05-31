import React, { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { mdComponents } from "../lib/markdown-components.jsx";
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
  Explore: { kind: "explore", icon: "\u{1F50D}", label: "Explore" },
  explore: { kind: "explore", icon: "\u{1F50D}", label: "Explore" },
  Plan: { kind: "plan", icon: "\u{1F5C2}", label: "Plan" },
  plan: { kind: "plan", icon: "\u{1F5C2}", label: "Plan" },
  "general-purpose": { kind: "agent", icon: "\u{1F916}", label: "Agent" },
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
 * Compact one-liner summary of what the subagent did, shown both in the
 * collapsed header (so the user sees scope at a glance) and below the
 * task line when expanded.
 *
 * Examples: "7 reads · 14 searches · 1 dir" / "3 reads · 2 edits".
 * Lower-case + middot-separated keeps it dense; pluralization is dropped
 * since the count is already there.
 */
function summarizeSteps(steps) {
  const counts = {};
  for (const s of steps) {
    const n = s.name || "other";
    let bucket = n;
    if (n.endsWith("_fetch")) bucket = "__fetch__";
    else if (n.endsWith("_search") || n.endsWith("_web_search")) bucket = "__search__";
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  const VERBS = [
    ["Read", "read", "reads"],
    ["Grep", "search", "searches"],
    ["list_dir", "dir", "dirs"],
    ["Bash", "cmd", "cmds"],
    ["PowerShell", "cmd", "cmds"],
    ["WebSearch", "web search", "web searches"],
    ["__search__", "web search", "web searches"],
    ["WebFetch", "fetch", "fetches"],
    ["__fetch__", "fetch", "fetches"],
    ["Write", "write", "writes"],
    ["Edit", "edit", "edits"],
  ];
  const phrases = [];
  for (const [key, sing, plur] of VERBS) {
    if (counts[key]) phrases.push(`${counts[key]} ${counts[key] > 1 ? plur : sing}`);
  }
  if (phrases.length === 0) return null;
  return phrases.join(" \u00B7 ");
}

const STEP_PREVIEW_LIMIT = 6;

export default function SubagentCard({ part }) {
  const args = part.args || {};
  // Dispatch tool is named "Agent"; legacy builds used "task". Identity
  // is in args.subagent_type. Older sessions stored it in part.name.
  const subagentType = args.subagent_type || part.name || "subagent";
  const result = part.result;
  // New schema uses { description, prompt }; legacy used { task }. The
  // short `description` is the headline; if the user only sent `prompt`
  // we truncate that as a fallback.
  const headline =
    args.description ||
    args.task ||
    (typeof args.prompt === "string" ? args.prompt.slice(0, 120) : "");
  const fullPrompt = args.prompt || args.task || "";
  const isDone = part.status === "done";
  const isError =
    isDone && typeof result === "string" && result.startsWith("Error:");
  const meta = typeMetaFor(subagentType);

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

  // Title row: type label + middot + headline (truncated to one line via CSS).
  const titleContent = headline ? (
    <>
      <span className="subagent-sep" aria-hidden="true">
        {"\u00B7"}
      </span>
      <span className="subagent-task" title={fullPrompt || headline}>
        {headline}
      </span>
    </>
  ) : null;

  // Clickable step-count chip in the header. When the card is collapsed,
  // clicking it pops the card open AND shows the step list (one-click
  // path to "show me the steps"). When expanded, it just toggles the
  // step list independently of the card chevron and the report.
  const handleStepChipClick = (e) => {
    e.stopPropagation();
    if (!cardOpen) {
      setCardOpen(true);
      setStepsOpen(true);
      return;
    }
    setStepsOpen((v) => !v);
  };
  // Visual: when card is collapsed the arrow always points "right" since
  // the action is "expand"; when expanded it reflects the steps-open state.
  const stepChipOpen = cardOpen && stepsOpen;
  const stepChip = steps.length > 0 ? (
    <button
      type="button"
      className={`subagent-step-chip ${stepChipOpen ? "open" : ""}`}
      onClick={handleStepChipClick}
      aria-expanded={stepChipOpen}
      aria-label={stepChipOpen ? "Hide steps" : "Show steps"}
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
        titleTooltip={fullPrompt || headline}
        subtitle={summary}
        meta={stepChip}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess
      />

      {cardOpen && (
        <div className="subagent-body">
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
                  components={mdComponents}
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
