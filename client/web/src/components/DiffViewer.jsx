import React from "react";
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued";
import { useChatStore } from "../stores/chat-store.js";
import CopyButton from "./CopyButton.jsx";
import { fileName } from "../lib/utils.js";

const darkStyles = {
  variables: {
    dark: {
      diffViewerBackground: "#161b22",
      diffViewerColor: "#e6edf3",
      addedBackground: "rgba(63,185,80,0.12)",
      addedColor: "#e6edf3",
      removedBackground: "rgba(248,81,73,0.12)",
      removedColor: "#e6edf3",
      wordAddedBackground: "rgba(63,185,80,0.30)",
      wordRemovedBackground: "rgba(248,81,73,0.30)",
      addedGutterBackground: "rgba(63,185,80,0.20)",
      removedGutterBackground: "rgba(248,81,73,0.20)",
      gutterBackground: "#161b22",
      gutterBackgroundDark: "#1c2128",
      highlightBackground: "rgba(88,166,255,0.1)",
      highlightGutterBackground: "rgba(88,166,255,0.15)",
      codeFoldGutterBackground: "#1c2128",
      codeFoldBackground: "#1c2128",
      emptyLineBackground: "#161b22",
      gutterColor: "#6e7681",
      addedGutterColor: "#3fb950",
      removedGutterColor: "#f85149",
      codeFoldContentColor: "#8b949e",
      diffViewerTitleBackground: "#1c2128",
      diffViewerTitleColor: "#e6edf3",
      diffViewerTitleBorderColor: "#30363d",
    },
  },
  line: { padding: "0 8px", fontSize: "12px", lineHeight: "1.55", fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace" },
  gutter: { padding: "0 6px", minWidth: "36px", fontSize: "10px", fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace" },
  codeFold: { fontSize: "11px", fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace" },
  contentText: { fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace", fontSize: "12px", lineHeight: "1.55" },
};

const lightStyles = {
  variables: {
    light: {
      diffViewerBackground: "#ffffff",
      diffViewerColor: "#1f2328",
      addedBackground: "#dafbe1",
      addedColor: "#116329",
      removedBackground: "#ffebe9",
      removedColor: "#82071e",
      wordAddedBackground: "#abf2bc",
      wordRemovedBackground: "#ff8182",
      addedGutterBackground: "#ccffd8",
      removedGutterBackground: "#ffd7d5",
      gutterBackground: "#f6f8fa",
      gutterBackgroundDark: "#ebeef1",
      highlightBackground: "rgba(9,105,218,0.08)",
      highlightGutterBackground: "rgba(9,105,218,0.12)",
      codeFoldGutterBackground: "#ebeef1",
      codeFoldBackground: "#ebeef1",
      emptyLineBackground: "#f6f8fa",
      gutterColor: "#59636e",
      addedGutterColor: "#1a7f37",
      removedGutterColor: "#cf222e",
      codeFoldContentColor: "#59636e",
      diffViewerTitleBackground: "#ebeef1",
      diffViewerTitleColor: "#1f2328",
      diffViewerTitleBorderColor: "#d1d9e0",
    },
  },
  line: { padding: "0 8px", fontSize: "12px", lineHeight: "1.55", fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace" },
  gutter: { padding: "0 6px", minWidth: "36px", fontSize: "10px", fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace" },
  codeFold: { fontSize: "11px", fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace" },
  contentText: { fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace", fontSize: "12px", lineHeight: "1.55" },
};

export default function DiffViewer({ oldStr, newStr, filePath, replaceAll, embedded = false }) {
  const theme = useChatStore((s) => s.theme);
  const isDark = theme === "dark";
  const fName = fileName(filePath);

  return (
    <div className={`diff-viewer ${embedded ? "diff-viewer--embedded" : ""}`}>
      {!embedded && filePath && (
        <div className="diff-file-header">
          <span className="diff-file-icon">{"\u{1F4C4}"}</span>
          <span className="diff-file-name" title={filePath}>{fName}</span>
          {replaceAll && <span className="diff-replace-all-badge">replace all</span>}
          <CopyButton text={newStr} label="Copy new content" inline />
        </div>
      )}
      <ReactDiffViewer
        oldValue={oldStr || ""}
        newValue={newStr || ""}
        splitView={false}
        useDarkTheme={isDark}
        compareMethod={DiffMethod.LINES}
        // Show ALL lines, no fold/expand bar. The "🔀 N 🟩🟥" marker that
        // appears with `showDiffOnly: true` is more visual noise than help
        // for the small targeted edits this tool produces.
        showDiffOnly={false}
        extraLinesSurroundingDiff={3}
        // The library always renders TWO line-number gutters in unified
        // mode (old | new). We hide the OLD gutter via CSS in tools.css to
        // keep just the new-side numbers — that's what users care about.
        styles={isDark ? darkStyles : lightStyles}
      />
    </div>
  );
}
