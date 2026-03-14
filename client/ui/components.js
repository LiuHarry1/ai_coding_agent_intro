import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Spinner } from "@inkjs/ui";

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
    h(Text, { key: "exit-hint", dimColor: true }, "  输入 exit 退出；粘贴多行后按 Ctrl+Enter 发送"),
    h(Text, { key: "bottom-border", dimColor: true }, "═".repeat(56)),
  );
}

// ── Tool Call Display ───────────────────────────────────────
export function ToolCallView({ name, args, result }) {
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
        })
      )
    ),
  );
}

// ── Streaming Agent Response ────────────────────────────────
export function AgentResponse({ text, streaming, stepCount }) {
  if (!text && !streaming) return null;

  return h(Box, { flexDirection: "column", marginTop: 1 },
    h(Text, { key: "r-top", dimColor: true }, "─".repeat(56)),
    h(Text, { key: "r-label", color: "green", bold: true }, "🤖 Agent:"),
    h(Box, { key: "r-body", marginLeft: 2 },
      h(Text, { wrap: "wrap" }, text || ""),
      streaming && h(Text, { color: "cyan" }, "▊"),
    ),
    !streaming && h(Text, { key: "r-bottom", dimColor: true }, "─".repeat(56)),
    !streaming && stepCount != null && h(Text, { key: "r-stats", dimColor: true }, `  ✓ 共 ${stepCount} 步完成`),
  );
}

// 括号粘贴序列：部分终端粘贴时发送 \e[200~ 内容 \e[201~
const BRACKET_PASTE_START = "\u001b[200~";
const BRACKET_PASTE_END = "\u001b[201~";

// ── Multi-line input: Enter = newline, Ctrl+Enter = submit (paste-friendly) ──
// ref 存内容 + 防抖 flush + 括号粘贴检测，减少快速粘贴丢字
function MultilineInput({ value, onChange, onSubmit }) {
  const valueRef = React.useRef(value);
  const flushTimerRef = React.useRef(null);
  const pasteBufRef = React.useRef("");
  const escBufRef = React.useRef("");
  const inPasteRef = React.useRef(false);

  if (value === "" && valueRef.current !== "") valueRef.current = "";
  if (value !== "" && valueRef.current !== value) valueRef.current = value;

  const flush = () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = null;
    onChange(valueRef.current);
  };

  const scheduleFlush = () => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(flush, 16);
  };

  useInput((input, key) => {
    if (key.ctrl && key.return) {
      flush();
      const trimmed = (valueRef.current || "").trim();
      if (trimmed) {
        onSubmit(trimmed);
        valueRef.current = "";
        onChange("");
      }
      return;
    }
    if (key.return) {
      valueRef.current = (valueRef.current || "") + "\n";
      flush();
      return;
    }
    if (key.backspace) {
      const s = valueRef.current || "";
      valueRef.current = s.slice(0, -1);
      flush();
      return;
    }
    if (!input) return;

    if (inPasteRef.current) {
      if (input === "\u001b") {
        escBufRef.current = "\u001b";
        return;
      }
      if (escBufRef.current !== "") {
        escBufRef.current += input;
        if (escBufRef.current === BRACKET_PASTE_END) {
          valueRef.current = (valueRef.current || "") + pasteBufRef.current;
          pasteBufRef.current = "";
          escBufRef.current = "";
          inPasteRef.current = false;
          flush();
        } else if (!BRACKET_PASTE_END.startsWith(escBufRef.current)) {
          valueRef.current = (valueRef.current || "") + pasteBufRef.current + escBufRef.current;
          pasteBufRef.current = "";
          escBufRef.current = "";
          inPasteRef.current = false;
          scheduleFlush();
        }
        return;
      }
      pasteBufRef.current += input;
      scheduleFlush();
      return;
    }

    if (input === "\u001b") {
      escBufRef.current = "\u001b";
      return;
    }
    if (escBufRef.current !== "") {
      escBufRef.current += input;
      if (escBufRef.current === BRACKET_PASTE_START) {
        escBufRef.current = "";
        inPasteRef.current = true;
        pasteBufRef.current = "";
      } else if (!BRACKET_PASTE_START.startsWith(escBufRef.current)) {
        valueRef.current = (valueRef.current || "") + escBufRef.current;
        escBufRef.current = "";
        scheduleFlush();
      }
      return;
    }

    valueRef.current = (valueRef.current || "") + input;
    scheduleFlush();
  });

  const displayValue = valueRef.current !== undefined ? valueRef.current : value;
  const hasContent = displayValue && displayValue.length > 0;
  const displayLines = hasContent ? displayValue.split("\n") : [];

  return h(Box, { flexDirection: "column" },
    hasContent
      ? h(Box, { flexDirection: "column" },
          ...displayLines.map((line, i) => h(Text, { key: i }, line || " ")),
          h(Text, { dimColor: true }, "▊"),
        )
      : h(Text, { dimColor: true }, " 在此输入或粘贴，Ctrl+Enter 发送 ▊"),
  );
}

// ── 输入框：带边框，支持多行粘贴 ─────────────────────────────
export function InputPrompt({ onSubmit, busy }) {
  const [value, setValue] = useState("");

  if (busy) return null;

  return h(Box, { marginTop: 1 },
    h(Box, {
      borderStyle: "single",
      borderColor: "cyan",
      flexDirection: "column",
      minHeight: 2,
      paddingX: 1,
      paddingY: 1,
    },
      h(MultilineInput, {
        value,
        onChange: setValue,
        onSubmit: (v) => {
          setValue("");
          onSubmit(v);
        },
      }),
    ),
  );
}

// ── Main App (HTTP + SSE driven) ────────────────────────────
export function AgentApp({ title, info, connection, chatOpts }) {
  const { exit } = useApp();
  const [steps, setSteps] = useState([]);
  const [responseText, setResponseText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [stepCount, setStepCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState(null);
  const [currentInput, setCurrentInput] = useState("");
  const responseRef = React.useRef("");
  const flushTimer = React.useRef(null);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      connection.abort();
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

        case "text_delta":
          setStreaming(true);
          setSteps((prev) => prev
            .map((s) => s.status === "thinking" ? { ...s, status: "done" } : s)
            .filter((s) => s.toolCalls && s.toolCalls.length > 0)
          );
          responseRef.current += event.delta;
          if (!flushTimer.current) {
            flushTimer.current = setTimeout(() => {
              flushTimer.current = null;
              setResponseText(responseRef.current);
            }, 50);
          }
          break;

        case "done":
          clearTimeout(flushTimer.current);
          flushTimer.current = null;
          setResponseText(responseRef.current);
          setStreaming(false);
          setStepCount(event.stepCount);
          setBusy(false);
          break;

        case "error":
          setStreaming(false);
          setError(event.message);
          setBusy(false);
          break;
      }
    });
  }, []);

  const handleSubmit = (input) => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (trimmed === "exit" || trimmed === "quit") {
      connection.abort();
      exit();
      return;
    }

    if (responseRef.current) {
      setHistory((prev) => [...prev, { input: currentInput, response: responseRef.current }]);
    }
    setCurrentInput(trimmed);
    responseRef.current = "";
    setBusy(true);
    setSteps([]);
    setResponseText("");
    setStepCount(null);
    setStreaming(false);
    setError(null);

    connection.chat(trimmed, chatOpts);
  };

  return h(Box, { flexDirection: "column" },
    h(Welcome, { title, info }),

    ...history.map((item, i) =>
      h(Box, { key: `h-${i}`, flexDirection: "column", marginBottom: 1 },
        h(Text, { dimColor: true }, `You > ${item.input}`),
        h(Text, { dimColor: true }, `🤖 ${(item.response || "").substring(0, 80)}${(item.response || "").length > 80 ? "…" : ""}`),
      )
    ),

    currentInput && (busy || responseText) && h(Text, { key: "current-input", bold: true }, `You > ${currentInput}`),

    ...steps.map((step, i) =>
      h(StepView, { key: `s-${i}`, step, index: i })
    ),

    (responseText || streaming) && h(AgentResponse, {
      key: "response",
      text: responseText,
      streaming,
      stepCount,
    }),

    error && h(Box, { key: "error", marginTop: 1 },
      h(Text, { color: "red", bold: true }, `✖ Error: ${error}`),
    ),

    h(InputPrompt, { key: "input", onSubmit: handleSubmit, busy }),
  );
}
