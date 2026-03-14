import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Spinner } from "@inkjs/ui";
import TextInput from "ink-text-input";

const h = React.createElement;

// ── Welcome Banner ──────────────────────────────────────────
export function Welcome({ title, info = {} }) {
  const infoLines = Object.entries(info).map(([k, v]) =>
    h(Text, { key: `info-${k}`, dimColor: true }, `  ${k}: ${v}`)
  );

  return h(Box, { flexDirection: "column", marginBottom: 1 },
    h(Text, { key: "top-border", dimColor: true }, "═".repeat(56)),
    h(Text, { key: "title", bold: true, color: "cyan" }, `  ${title}`),
    ...infoLines,
    h(Text, { key: "exit-hint", dimColor: true }, '  输入 "exit" 退出'),
    h(Text, { key: "bottom-border", dimColor: true }, "═".repeat(56)),
  );
}

// ── Tool Call Display ───────────────────────────────────────
export function ToolCallView({ name, args, result, isLast }) {
  const argsStr = JSON.stringify(args ?? {});
  const short = argsStr.length > 100 ? argsStr.substring(0, 100) + "…" : argsStr;

  const resultLines = result ? result.split("\n") : [];
  const preview = resultLines.slice(0, 12);
  const truncated = resultLines.length > 12;

  return h(Box, { flexDirection: "column", marginLeft: 2 },
    h(Text, { color: "yellow", bold: true }, "⚡ ", name),
    h(Text, { dimColor: true }, "   ", short),
    result != null && h(Box, { flexDirection: "column", borderStyle: "single", borderColor: "gray", paddingX: 1 },
      ...preview.map((line, i) =>
        h(Text, { key: `line-${i}`, wrap: "truncate" }, line)
      ),
      truncated && h(Text, { key: "trunc", dimColor: true }, `… (${resultLines.length} lines total)`)
    ),
  );
}

// ── Single Step ─────────────────────────────────────────────
export function StepView({ step, index }) {
  const { status, toolCalls } = step;

  const statusIcon = status === "thinking"
    ? h(Spinner, { label: " Thinking..." })
    : status === "tool"
      ? h(Text, { color: "cyan" }, "⚙ Running tools")
      : h(Text, { color: "green" }, "✓ Done");

  return h(Box, { flexDirection: "column", marginTop: index > 0 ? 1 : 0 },
    h(Box, null,
      h(Text, { backgroundColor: "cyan", color: "black", bold: true }, ` STEP ${index + 1} `),
      h(Text, null, " "),
      statusIcon,
    ),
    toolCalls && toolCalls.length > 0 && h(Box, { flexDirection: "column" },
      ...toolCalls.map((tc, i) =>
        h(ToolCallView, {
          key: `tc-${i}`,
          name: tc.name,
          args: tc.args,
          result: tc.result,
          isLast: i === toolCalls.length - 1,
        })
      )
    ),
  );
}

// ── Agent Response ──────────────────────────────────────────
export function AgentResponse({ text, stepCount }) {
  if (!text) return null;

  return h(Box, { flexDirection: "column", marginTop: 1 },
    h(Text, { key: "r-top", dimColor: true }, "─".repeat(56)),
    h(Text, { key: "r-label", color: "green", bold: true }, "🤖 Agent:"),
    h(Box, { key: "r-body", marginLeft: 2 },
      h(Text, { wrap: "wrap" }, text),
    ),
    h(Text, { key: "r-bottom", dimColor: true }, "─".repeat(56)),
    stepCount != null && h(Text, { key: "r-stats", dimColor: true }, `  ✓ 共 ${stepCount} 步完成`),
  );
}

// ── Input Prompt ────────────────────────────────────────────
export function InputPrompt({ onSubmit, busy }) {
  const [value, setValue] = useState("");

  if (busy) return null;

  return h(Box, { marginTop: 1 },
    h(Text, { bold: true }, "You > "),
    h(TextInput, {
      value,
      onChange: setValue,
      onSubmit: (v) => {
        setValue("");
        onSubmit(v);
      },
    }),
  );
}

// ── Main App (WebSocket-driven) ─────────────────────────────
export function AgentApp({ title, info, connection }) {
  const { exit } = useApp();
  const [steps, setSteps] = useState([]);
  const [response, setResponse] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const pendingInput = React.useRef("");

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      connection.disconnect();
      exit();
    }
  }, { isActive: process.stdin.isTTY === true });

  React.useEffect(() => {
    connection.onEvent((event) => {
      switch (event.type) {
        case "thinking":
          setSteps((prev) => [...prev, { status: "thinking", toolCalls: [] }]);
          break;

        case "tool_call":
          setSteps((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last) {
              last.status = "tool";
              last.toolCalls = [...(last.toolCalls || []), { name: event.name, args: event.args, result: null }];
            }
            return updated;
          });
          break;

        case "tool_result":
          setSteps((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.toolCalls) {
              const tc = last.toolCalls[last.toolCalls.length - 1];
              if (tc) tc.result = event.result;
              last.status = "done";
            }
            return updated;
          });
          break;

        case "response":
          setSteps((prev) => prev
            .map((s) => s.status === "thinking" ? { ...s, status: "done" } : s)
            .filter((s) => s.toolCalls && s.toolCalls.length > 0)
          );
          setResponse({ text: event.text, stepCount: event.stepCount });
          setHistory((prev) => [...prev, { input: pendingInput.current, response: event.text }]);
          setBusy(false);
          break;

        case "error":
          setError(event.message);
          setBusy(false);
          break;

        case "disconnected":
          setError("Server disconnected");
          break;
      }
    });
  }, []);

  const handleSubmit = (input) => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (trimmed === "exit" || trimmed === "quit") {
      connection.disconnect();
      exit();
      return;
    }

    pendingInput.current = trimmed;
    setBusy(true);
    setSteps([]);
    setResponse(null);
    setError(null);

    connection.chat(trimmed);
  };

  return h(Box, { flexDirection: "column" },
    h(Welcome, { title, info }),

    ...history.map((item, i) =>
      h(Box, { key: `h-${i}`, flexDirection: "column", marginBottom: 1 },
        h(Text, { dimColor: true }, `You > ${item.input}`),
        h(Text, { dimColor: true }, `🤖 ${(item.response || "").substring(0, 80)}${(item.response || "").length > 80 ? "…" : ""}`),
      )
    ),

    ...steps.map((step, i) =>
      h(StepView, { key: `s-${i}`, step, index: i })
    ),

    response && h(AgentResponse, { key: "response", text: response.text, stepCount: response.stepCount }),

    error && h(Box, { key: "error", marginTop: 1 },
      h(Text, { color: "red", bold: true }, `✖ Error: ${error}`),
    ),

    h(InputPrompt, { key: "input", onSubmit: handleSubmit, busy }),
  );
}
