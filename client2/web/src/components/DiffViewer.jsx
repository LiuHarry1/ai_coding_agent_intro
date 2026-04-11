import React from "react";

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default function DiffViewer({ oldStr, newStr, filePath, replaceAll }) {
  return (
    <div className="diff-viewer">
      <div className="diff-del">
        <span className="diff-label">-</span>
        <pre>{oldStr}</pre>
      </div>
      <div className="diff-add">
        <span className="diff-label">+</span>
        <pre>{newStr}</pre>
      </div>
      {filePath && (
        <div className="diff-meta">
          {filePath}{replaceAll ? " (replace all)" : ""}
        </div>
      )}
    </div>
  );
}
