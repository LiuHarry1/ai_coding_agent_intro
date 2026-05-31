import React, { useState, useMemo, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { mdComponents } from "../lib/markdown-components.jsx";
import ToolRowHeader from "./ToolRowHeader.jsx";
import { pickCard, SUPPRESSED_TOOL_CARDS, SUBAGENT_SUPPRESSED } from "./pickToolCard.js";

/**
 * Subagent row (Explore / Plan / Agent): same flat tool-row shell as Read/Bash.
 * Nested steps + report expand beneath the header — no outer card chrome.
 */

const TYPE_LABELS = {
  Explore: "Explore",
  explore: "Explore",
  Plan: "Plan",
  plan: "Plan",
  "general-purpose": "Agent",
  general_purpose: "Agent",
};

function labelFor(subagentType) {
  if (TYPE_LABELS[subagentType]) return TYPE_LABELS[subagentType];
  if (!subagentType) return "Agent";
  return subagentType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

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
    ["Glob", "glob", "globs"],
    ["list_dir", "dir", "dirs"],
    ["Bash", "cmd", "cmds"],
    ["PowerShell", "cmd", "cmds"],
    ["WebSearch", "web search", "web searches"],
    ["__search__", "web search", "web searches"],
    ["WebFetch", "fetch", "fetches"],
    ["__fetch__", "fetch", "fetches"],
    ["Write", "write", "writes"],
    ["Edit", "edit", "edits"],
    ["Skill", "skill", "skills"],
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
  const subagentType = args.subagent_type || part.name || "subagent";
  const result = part.result;
  const headline =
    args.description ||
    args.task ||
    (typeof args.prompt === "string" ? args.prompt.slice(0, 120) : "");
  const fullPrompt = args.prompt || args.task || "";
  const isDone = part.status === "done";
  const isError =
    isDone && typeof result === "string" && result.startsWith("Error:");
  const label = labelFor(subagentType);

  const steps = useMemo(() => {
    const raw = Array.isArray(part.subagentParts) ? part.subagentParts : [];
    return raw.filter(
      (s) =>
        s.type === "tool_call" &&
        !SUPPRESSED_TOOL_CARDS.has(s.name) &&
        !SUBAGENT_SUPPRESSED.has(s.name),
    );
  }, [part.subagentParts]);

  const [expanded, setExpanded] = useState(true);
  const [stepsOpen, setStepsOpen] = useState(() => !isDone);
  const [showAllSteps, setShowAllSteps] = useState(false);
  const wasDone = useRef(isDone);

  useEffect(() => {
    if (isDone && !wasDone.current) {
      setStepsOpen(false);
    }
    wasDone.current = isDone;
  }, [isDone]);

  const summary = useMemo(() => summarizeSteps(steps), [steps]);

  const visibleSteps = showAllSteps ? steps : steps.slice(0, STEP_PREVIEW_LIMIT);
  const hiddenCount = steps.length - visibleSteps.length;

  const handleStepToggle = (e) => {
    e.stopPropagation();
    if (!expanded) {
      setExpanded(true);
      setStepsOpen(true);
      return;
    }
    setStepsOpen((v) => !v);
  };

  const stepsToggle =
    steps.length > 0 ? (
      <button
        type="button"
        className={`subagent-step-toggle ${stepsOpen && expanded ? "open" : ""}`}
        onClick={handleStepToggle}
        aria-expanded={expanded && stepsOpen}
        aria-label={stepsOpen && expanded ? "Hide steps" : "Show steps"}
      >
        {steps.length} step{steps.length === 1 ? "" : "s"}
      </button>
    ) : null;

  const hasReport = isDone && typeof result === "string" && result.length > 0;

  return (
    <div className={`tool-row subagent-row ${isError ? "has-error" : ""}`}>
      <ToolRowHeader
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        label={label}
        title={headline || "\u2026"}
        titleTooltip={fullPrompt || headline || undefined}
        subtitle={summary}
        meta={stepsToggle}
        duration={part.duration}
        isDone={isDone}
        isError={isError}
        showSuccess
      />

      {expanded && (
        <div className="subagent-expanded">
          {steps.length > 0 && stepsOpen && (
            <div className="subagent-steps">
              {visibleSteps.map((s, i) => {
                const Card = pickCard(s, { nested: true });
                return (
                  <div className="subagent-nested-step" key={s.id ?? i}>
                    <Card part={s} nested />
                  </div>
                );
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

          {hasReport && (
            <div className={`subagent-result ${isError ? "subagent-result--error" : ""}`}>
              {isError ? (
                <pre className="subagent-result-error">{result}</pre>
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
