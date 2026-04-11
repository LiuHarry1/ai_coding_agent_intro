import React from "react";
import { useChatStore } from "../stores/chat-store.js";

const HINTS = [
  { icon: "\u{1F4C1}", label: "View project structure", prompt: "Read the current directory structure and list all files" },
  { icon: "\u{1F4C4}", label: "Read package.json", prompt: "Read the package.json file and summarize the project" },
  { icon: "\u2699\uFE0F", label: "Create Express server", prompt: "Create a simple Express server listening on port 3000" },
  { icon: "\u{1F4BB}", label: "Check Node version", prompt: "Run node --version to check the current Node version" },
];

export default function WelcomeScreen() {
  const sendMessage = useChatStore((s) => s.sendMessage);

  return (
    <div className="welcome">
      <div className="welcome-icon">&#9670;</div>
      <h2 className="welcome-title">AI Coding Agent</h2>
      <p className="welcome-desc">
        I can read and write files, run commands, and help you with coding tasks. Tell me what you want to do.
      </p>
      <div className="hint-grid">
        {HINTS.map((h, i) => (
          <button key={i} className="hint-card" onClick={() => sendMessage(h.prompt)}>
            <span className="hint-icon">{h.icon}</span>
            <span className="hint-label">{h.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
