/**
 * Bash quoting helpers aligned with Claude Code `utils/bash/shellQuoting.ts`.
 *
 * We do not depend on `shell-quote` (see `argumentSubstitution.ts`). The
 * eval-wrapper uses POSIX single-quoting, which is what CC uses for heredocs
 * and as the shell-quote fallback.
 */

function quoteForEval(command: string): string {
  const escaped = command.replace(/'/g, "'\"'\"'")
  return `'${escaped}'`
}

/**
 * Detects if a command contains a heredoc pattern.
 * Matches: <<EOF, <<'EOF', <<"EOF", <<-EOF, <<-'EOF', <<\EOF
 * Excludes bit-shift `<<` in arithmetic.
 */
function containsHeredoc(command: string): boolean {
  if (
    /\d\s*<<\s*\d/.test(command) ||
    /\[\[\s*\d+\s*<<\s*\d+\s*\]\]/.test(command) ||
    /\$\(\(.*<<.*\)\)/.test(command)
  ) {
    return false
  }
  return /<<-?\s*(?:(['"]?)(\w+)\1|\\(\w+))/.test(command)
}

function containsMultilineString(command: string): boolean {
  const singleQuoteMultiline = /'(?:[^'\\]|\\.)*\n(?:[^'\\]|\\.)*'/
  const doubleQuoteMultiline = /"(?:[^"\\]|\\.)*\n(?:[^"\\]|\\.)*"/
  return (
    singleQuoteMultiline.test(command) || doubleQuoteMultiline.test(command)
  )
}

/**
 * Insert `< /dev/null` before the first top-level `|` (not `||`).
 * CC `rearrangePipeCommand`: redirect must apply to the first command, not
 * the last stage of the pipeline (otherwise `rg | wc` reads /dev/null).
 */
function insertStdinRedirectBeforeFirstPipe(command: string): string | null {
  let single = false
  let dbl = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (single) {
      if (c === "'") single = false
      continue
    }
    if (dbl) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === '"') dbl = false
      continue
    }
    if (c === "'") {
      single = true
      continue
    }
    if (c === '"') {
      dbl = true
      continue
    }
    if (c === '|' && command[i + 1] !== '|' && command[i - 1] !== '|') {
      return `${command.slice(0, i).trimEnd()} < /dev/null ${command.slice(i)}`
    }
  }
  return null
}

/**
 * Quotes a command for `eval …` (CC `quoteShellCommand`).
 * Regular commands: `'cmd' '<' /dev/null` so eval concatenates a redirect.
 * Pipes: bake `< /dev/null` into the first stage, then single-quote the whole string.
 */
export function quoteShellCommand(
  command: string,
  addStdinRedirect: boolean = true,
): string {
  if (containsHeredoc(command) || containsMultilineString(command)) {
    const quoted = quoteForEval(command)
    if (containsHeredoc(command)) return quoted
    return addStdinRedirect ? `${quoted} '<' /dev/null` : quoted
  }

  if (addStdinRedirect && command.includes('|')) {
    const rearranged = insertStdinRedirectBeforeFirstPipe(command)
    if (rearranged) return quoteForEval(rearranged)
  }

  if (addStdinRedirect) {
    return `${quoteForEval(command)} '<' /dev/null`
  }
  return quoteForEval(command)
}

export function hasStdinRedirect(command: string): boolean {
  return /(?:^|[\s;&|])<(?![<(])\s*\S+/.test(command)
}

export function shouldAddStdinRedirect(command: string): boolean {
  if (containsHeredoc(command)) return false
  if (hasStdinRedirect(command)) return false
  return true
}

/**
 * Rewrites Windows CMD-style `>nul` redirects to POSIX `/dev/null`.
 * See anthropics/claude-code#4928 / CC `rewriteWindowsNullRedirect`.
 */
const NUL_REDIRECT_REGEX = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g

export function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(NUL_REDIRECT_REGEX, '$1/dev/null')
}

/** POSIX-quote a path for the cwd trailer (`pwd -P >| 'path'`). */
export function quotePosixPath(p: string): string {
  return quoteForEval(p)
}
