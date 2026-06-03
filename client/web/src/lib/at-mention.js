/**
 * @-mention autocomplete helpers — ported from claude-code-rev useTypeahead.tsx.
 */

const AT_TOKEN_HEAD_RE = /^@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*/u;
const PATH_CHAR_HEAD_RE = /^[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+/u;
const TOKEN_WITH_AT_RE = /(@[\p{L}\p{N}\p{M}_\-./\\()[\]~:]*|[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+)$/u;

/** Extract completable @ token at cursor (includeAtSymbol=true). */
export function extractCompletionToken(text, cursorPos, includeAtSymbol = false) {
  if (!text) return null;

  const textBeforeCursor = text.substring(0, cursorPos);

  if (includeAtSymbol) {
    const quotedAtRegex = /@"([^"]*)"?$/;
    const quotedMatch = textBeforeCursor.match(quotedAtRegex);
    if (quotedMatch && quotedMatch.index !== undefined) {
      const textAfterCursor = text.substring(cursorPos);
      const afterQuotedMatch = textAfterCursor.match(/^[^"]*"?/);
      const quotedSuffix = afterQuotedMatch ? afterQuotedMatch[0] : "";
      return {
        token: quotedMatch[0] + quotedSuffix,
        startPos: quotedMatch.index,
        isQuoted: true,
      };
    }
  }

  if (includeAtSymbol) {
    const atIdx = textBeforeCursor.lastIndexOf("@");
    if (atIdx >= 0 && (atIdx === 0 || /\s/.test(textBeforeCursor[atIdx - 1]))) {
      const fromAt = textBeforeCursor.substring(atIdx);
      const atHeadMatch = fromAt.match(AT_TOKEN_HEAD_RE);
      if (atHeadMatch && atHeadMatch[0].length === fromAt.length) {
        const textAfterCursor = text.substring(cursorPos);
        const afterMatch = textAfterCursor.match(PATH_CHAR_HEAD_RE);
        const tokenSuffix = afterMatch ? afterMatch[0] : "";
        return {
          token: atHeadMatch[0] + tokenSuffix,
          startPos: atIdx,
          isQuoted: false,
        };
      }
    }
  }

  const tokenRegex = includeAtSymbol ? TOKEN_WITH_AT_RE : /[\p{L}\p{N}\p{M}_\-./\\()[\]~:]+$/u;
  const match = textBeforeCursor.match(tokenRegex);
  if (!match || match.index === undefined) return null;

  const textAfterCursor = text.substring(cursorPos);
  const afterMatch = textAfterCursor.match(PATH_CHAR_HEAD_RE);
  const tokenSuffix = afterMatch ? afterMatch[0] : "";
  return {
    token: match[0] + tokenSuffix,
    startPos: match.index,
    isQuoted: false,
  };
}

/** Strip @ prefix and quotes from completion token for search query. */
export function extractSearchToken(completionToken) {
  if (completionToken.isQuoted) {
    return completionToken.token.slice(2).replace(/"$/, "");
  }
  if (completionToken.token.startsWith("@")) {
    return completionToken.token.substring(1);
  }
  return completionToken.token;
}

/** Format replacement text when applying a file suggestion. */
export function formatAtMentionReplacement(displayPath, options) {
  const { hasAtPrefix, needsQuotes, isQuoted, isDir } = options;
  const suffix = isDir ? "/" : " ";
  if (isQuoted || needsQuotes) {
    return `@"${displayPath}"${suffix}`;
  }
  if (hasAtPrefix) {
    return `@${displayPath}${suffix}`;
  }
  return `${displayPath}${suffix}`;
}

/** Replace partial @ token with selected path (CC applyFileSuggestion). */
export function applyFileSuggestion(replacementValue, input, partialPath, startPos) {
  const newInput =
    input.substring(0, startPos) +
    replacementValue +
    input.substring(startPos + partialPath.length);
  const newCursorPos = startPos + replacementValue.length;
  return { newInput, newCursorPos };
}

/** Convert absolute workspace path to relative @ mention path. */
export function toWorkspaceRelative(absPath, workspaceRoot) {
  const norm = (p) => p.replace(/\\/g, "/");
  const root = norm(workspaceRoot).replace(/\/$/, "");
  const abs = norm(absPath);
  if (abs.toLowerCase().startsWith(root.toLowerCase() + "/")) {
    return abs.slice(root.length + 1);
  }
  if (abs.toLowerCase() === root.toLowerCase()) return "";
  const parts = abs.split("/");
  return parts[parts.length - 1] || abs;
}

/** Insert text at textarea cursor, adding leading space if needed. */
export function insertTextAtCursor(el, text, setInputValue) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const needsSpace = before.length > 0 && !/\s/.test(before[before.length - 1]);
  const insert = (needsSpace ? " " : "") + text;
  const next = before + insert + after;
  el.value = next;
  setInputValue(next);
  const pos = start + insert.length;
  el.setSelectionRange(pos, pos);
  el.focus();
  return pos;
}
