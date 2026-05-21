import React from "react";
import Mermaid from "../components/Mermaid.jsx";

/**
 * Shared `components` prop for every <ReactMarkdown> in the app.
 *
 * Currently only intercepts ```mermaid``` fenced blocks and routes
 * them to <Mermaid />; everything else falls through to the default
 * `rehype-highlight` rendering.
 */
export const mdComponents = {
  code({ inline, className, children, ...props }) {
    const lang = /language-(\w+)/.exec(className || "")?.[1];
    if (!inline && lang === "mermaid") {
      const code = String(children ?? "").replace(/\n$/, "");
      return <Mermaid code={code} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};
