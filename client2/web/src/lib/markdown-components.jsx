import React from "react";
import Mermaid from "../components/Mermaid.jsx";

function isMermaidBlock(child) {
  if (!React.isValidElement(child)) return false;
  const t = child.type;
  if (t === Mermaid) return true;
  if (typeof t === "object" && t !== null && t.type?.mermaidBlock) return true;
  const cn = child.props?.className;
  return typeof cn === "string" && cn.includes("mermaid-block");
}

/** Drop the markdown <pre> wrapper for mermaid — it adds a second border. */
function pre({ children, ...props }) {
  const items = React.Children.toArray(children);
  if (items.length === 1 && isMermaidBlock(items[0])) {
    return items[0];
  }
  return <pre {...props}>{children}</pre>;
}

function makeCode(streaming) {
  return function code({ inline, className, children, ...props }) {
    const lang = /language-(\w+)/.exec(className || "")?.[1];
    if (!inline && lang === "mermaid") {
      const source = String(children ?? "").replace(/\n$/, "");
      return <Mermaid code={source} streaming={streaming} />;
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  };
}

const MD_COMPONENTS_IDLE = {
  pre,
  code: makeCode(false),
};

const MD_COMPONENTS_STREAMING = {
  pre,
  code: makeCode(true),
};

export function getMdComponents({ streaming = false } = {}) {
  return streaming ? MD_COMPONENTS_STREAMING : MD_COMPONENTS_IDLE;
}

export const mdComponents = MD_COMPONENTS_IDLE;

export function createMdComponents({ streaming = false } = {}) {
  return getMdComponents({ streaming });
}
