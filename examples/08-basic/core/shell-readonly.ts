/**
 * Heuristic read-only check for shell tool inputs. Mirrors Claude Code's
 * BashTool.isReadOnly / isConcurrencySafe split: only commands that cannot
 * mutate state and do not `cd` are safe to run in parallel (shell tools
 * share a per-instance cwd ref that would race under concurrent `cd`).
 */

const MUTATING_PATTERN =
  /(?:^|[\s;&|])(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|tee|truncate|install|uninstall|npm\s+(?:i|install|un|uninstall|run|exec|ci|publish)|pnpm\s+(?:i|install|add|run|exec|publish)|yarn\s+(?:add|remove|install|run)|pip\s+install|cargo\s+(?:build|run|install)|git\s+(?:add|commit|push|pull|merge|rebase|reset|checkout|switch|restore|clean|stash|cherry-pick|revert|tag|init)|sed\s+-i|perl\s+-pi)\b/i;

const REDIRECT_PATTERN = /(?:^|[\s])>>?|\|\s*(?:tee|sed|awk)\b/;

const CD_PATTERN = /(?:^|[\s;&|])cd(?:\s|$)/i;

const READ_ONLY_COMMAND =
  /^(?:git\s+(?:status|diff|log|show|branch|rev-parse|remote|describe|tag\s+-l)|ls(?:\s|$)|pwd|echo|cat|head|tail|wc|find|which|type|file|stat|du|df|env|printenv|node\s+--version|npm\s+(?:ls|list|view|outdated|prefix|root)|pnpm\s+(?:ls|list)|yarn\s+(?:info|list))\b/i;

function isSimpleReadOnlyPart(part: string): boolean {
  const trimmed = part.trim();
  if (!trimmed) return true;
  if (MUTATING_PATTERN.test(trimmed)) return false;
  if (REDIRECT_PATTERN.test(trimmed)) return false;
  if (CD_PATTERN.test(trimmed)) return false;
  return READ_ONLY_COMMAND.test(trimmed);
}

export function isShellCommandReadOnly(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  if (/[;&|]/.test(trimmed)) {
    const parts = trimmed.split(/\s*(?:&&|\|\||;|\|)\s*/);
    return parts.every(isSimpleReadOnlyPart);
  }

  return isSimpleReadOnlyPart(trimmed);
}

/** Input shape shared by bash / powershell tools. */
export function isShellInputConcurrencySafe(input: unknown): boolean {
  const args = input as {
    command?: string;
    background?: boolean;
    pid?: number;
    kill?: boolean;
  };

  if (args.background) return false;
  if (args.kill) return false;
  if (!args.command && args.pid != null) return true;
  if (!args.command) return false;
  return isShellCommandReadOnly(args.command);
}
