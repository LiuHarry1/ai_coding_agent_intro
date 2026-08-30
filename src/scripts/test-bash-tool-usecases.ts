/**
 * Broader Bash-tool use cases (same spawn/wrap as the tool).
 * Simulates session cwd persistence like shell-runner cwdRef.
 *
 *   npx tsx src/scripts/test-bash-tool-usecases.ts
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runShellCommand } from '../core/shell/spawn-shell.js'
import { findGitBashPath } from '../core/shell/windows-paths.js'

type Row = { cat: string; name: string; ok: boolean; detail: string }
const rows: Row[] = []

function rec(cat: string, name: string, ok: boolean, detail: string) {
  rows.push({ cat, name, ok, detail })
  const tag = ok ? 'OK  ' : 'BAD '
  console.log(`${tag} [${cat}] ${name}: ${detail}`)
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function norm(p: string): string {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase()
}

const isWindows = process.platform === 'win32'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baize-bash-uc-'))
let cwd = fs.realpathSync(root)
const workspace = fs.realpathSync(process.cwd())

async function bash(
  command: string,
  timeoutMs = 20_000,
  stdin?: string,
): Promise<{
  code: number | null
  stdout: string
  stderr: string
  cwdAfter?: string
  elapsed: number
  timedOut?: boolean
}> {
  const started = Date.now()
  const r = await runShellCommand({
    shell: 'bash',
    command,
    cwd,
    timeoutMs,
    stdin,
  })
  if (r.cwdAfter) cwd = r.cwdAfter
  return {
    code: r.code,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    cwdAfter: r.cwdAfter,
    elapsed: Date.now() - started,
    timedOut: r.timedOut,
  }
}

function out(r: { stdout: string; stderr: string }): string {
  return (r.stdout + r.stderr).replace(/\s+/g, ' ').trim().slice(0, 160)
}

async function main(): Promise<void> {
  if (isWindows) {
    const gitBash = findGitBashPath()
    if (!gitBash) {
      console.error('Git Bash not found')
      process.exit(1)
    }
    console.log(`Git Bash: ${gitBash}`)
  }
  console.log(`start cwd: ${cwd}`)
  console.log(`workspace: ${workspace}\n`)

  // ── basics ──────────────────────────────────────────────────────────────
  {
    const r = await bash('echo hello-bash && pwd -W 2>/dev/null || pwd')
    rec('basic', 'echo + pwd', r.code === 0 && /hello-bash/.test(r.stdout), out(r))
  }
  {
    const r = await bash('printf "HOME=%s\\nUSERPROFILE=%s\\n" "$HOME" "$USERPROFILE"')
    rec(
      'basic',
      '$HOME / $USERPROFILE set',
      r.code === 0 && /HOME=/.test(r.stdout) && r.stdout.includes(os.homedir().replace(/\\/g, '/') ) || r.stdout.includes(os.homedir()),
      out(r),
    )
  }
  {
    const r = await bash('uname -s; command -v git; command -v node')
    rec('basic', 'uname + command -v', r.code === 0 && /git/.test(r.stdout), out(r))
  }
  {
    const r = await bash('false')
    rec('basic', 'false exit 1', r.code === 1, `code=${r.code}`)
  }
  {
    const r = await bash('false && echo should-not; echo after-and; false; echo after-semi')
    rec(
      'basic',
      '&& vs ;',
      !/should-not/.test(r.stdout) && /after-and/.test(r.stdout) && /after-semi/.test(r.stdout),
      out(r),
    )
  }

  // ── paths ───────────────────────────────────────────────────────────────
  {
    const r = await bash('mkdir -p rel/nested && ls -ld rel/nested')
    rec(
      'path',
      'relative mkdir -p',
      exists(path.join(root, 'rel', 'nested')),
      `exists=${exists(path.join(root, 'rel', 'nested'))} ${out(r)}`,
    )
  }
  {
    const fwd = `${root.replace(/\\/g, '/')}/from-forward`
    const r = await bash(`mkdir -p ${fwd} && test -d ${fwd} && echo ok`)
    rec('path', 'C:/ forward-slash mkdir', exists(path.join(root, 'from-forward')) && /ok/.test(r.stdout), out(r))
  }
  {
    const msys = root.replace(/^([A-Za-z]):\\/, (_m, d) => `/${String(d).toLowerCase()}/`).replace(/\\/g, '/')
    const dest = `${msys}/from-msys`
    const r = await bash(`mkdir -p '${dest}' && echo ok`)
    rec('path', '/c/... msys mkdir', exists(path.join(root, 'from-msys')) && r.code === 0, out(r))
  }
  {
    const quoted = path.join(root, 'from-quoted-bs')
    const r = await bash(`mkdir -p '${quoted}'`)
    rec(
      'path',
      "single-quoted C:\\\\ mkdir",
      exists(quoted),
      `exists=${exists(quoted)} code=${r.code}`,
    )
  }
  {
    const dbl = path.join(root, 'from-dbl-bs')
    const r = await bash(`mkdir -p "${dbl}"`)
    rec(
      'path',
      'double-quoted C:\\\\ mkdir',
      exists(dbl),
      `exists=${exists(dbl)} code=${r.code} names=${fs.readdirSync(root).filter(n => /dbl|from-d/i.test(n)).join(',')}`,
    )
  }
  {
    const unq = path.join(root, 'from-unquoted-bs')
    const r = await bash(`mkdir -p ${unq}`)
    rec(
      'path',
      'UNQUOTED C:\\\\ mkdir (known Git Bash pitfall)',
      exists(unq),
      `exists=${exists(unq)} code=${r.code} extra=${fs.readdirSync(root).filter(n => /from-unquoted|C:Users|CUsers/i.test(n)).join(',')}`,
    )
  }
  {
    const r = await bash('mkdir -p "dir with spaces/inner" && echo x > "dir with spaces/a b.txt" && cat "dir with spaces/a b.txt"')
    rec(
      'path',
      'spaces in dir + file',
      exists(path.join(root, 'dir with spaces', 'a b.txt')) && /^\s*x\s*$/m.test(r.stdout),
      out(r),
    )
  }
  {
    const r = await bash('mkdir -p "中文目录" && echo 你好 > "中文目录/说明.txt" && cat "中文目录/说明.txt"')
    rec(
      'path',
      'Chinese dir + file',
      exists(path.join(root, '中文目录', '说明.txt')) && /你好/.test(r.stdout),
      out(r),
    )
  }

  // ── session cwd ─────────────────────────────────────────────────────────
  {
    const sub = path.join(root, 'rel', 'nested')
    const r = await bash(`cd rel/nested && pwd -W 2>/dev/null || pwd`)
    rec(
      'cwd',
      'cd relative persists',
      !!r.cwdAfter && norm(r.cwdAfter) === norm(sub),
      `cwdAfter=${r.cwdAfter} expected=${sub}`,
    )
  }
  {
    const r = await bash('pwd -W 2>/dev/null || pwd')
    rec(
      'cwd',
      'next call stays in nested',
      !!r.cwdAfter && /nested/i.test(r.cwdAfter),
      `cwd=${r.cwdAfter} stdout=${out(r)}`,
    )
  }
  {
    const r = await bash('cd /tmp && { pwd -W 2>/dev/null || pwd -P; }')
    const tmpOk =
      !!r.cwdAfter &&
      (norm(r.cwdAfter) === norm(os.tmpdir()) ||
        norm(r.cwdAfter).includes('/temp') ||
        /temp/i.test(r.cwdAfter))
    rec(
      'cwd',
      'cd /tmp session cwd → TEMP',
      tmpOk,
      `cwdAfter=${r.cwdAfter} tmp=${os.tmpdir()} stdout=${out(r)}`,
    )
  }
  {
    const r = await bash('mkdir -p baize-uc-after-tmp && pwd -W 2>/dev/null || pwd')
    const inTemp = exists(path.join(os.tmpdir(), 'baize-uc-after-tmp'))
    const inRoot = exists(path.join(root, 'baize-uc-after-tmp'))
    rec(
      'cwd',
      'mkdir after cd /tmp lands in TEMP',
      inTemp && !inRoot,
      `TEMP=${inTemp} startDir=${inRoot} cwd=${cwd} ${out(r)}`,
    )
  }
  {
    // Return to sandbox root for remaining file tests
    const r = await bash(`cd '${root.replace(/\\/g, '/')}' && pwd -W 2>/dev/null || pwd`)
    rec(
      'cwd',
      'cd back to sandbox via C:/ path',
      !!r.cwdAfter && norm(r.cwdAfter) === norm(root),
      `cwdAfter=${r.cwdAfter}`,
    )
  }
  {
    const r1 = await bash('export BAIZE_UC_MARK=persisted')
    const r2 = await bash('printf "%s" "$BAIZE_UC_MARK"')
    rec(
      'cwd',
      'export does NOT persist (by design)',
      r1.code === 0 && r2.stdout.trim() === '',
      `second stdout=${JSON.stringify(r2.stdout)}`,
    )
  }
  {
    const r = await bash('export BAIZE_UC_MARK=same-call && printf "%s" "$BAIZE_UC_MARK"')
    rec('cwd', 'export in same call works', r.stdout.trim() === 'same-call', out(r))
  }
  {
    const r = await bash('(cd rel && pwd -W 2>/dev/null || pwd)')
    rec(
      'cwd',
      'subshell cd does not persist',
      !!cwd && norm(cwd) === norm(root),
      `session=${cwd} stdout=${out(r)}`,
    )
  }

  // ── files / pipes / redirect ────────────────────────────────────────────
  {
    const r = await bash('printf "alpha\\nbeta\\ngamma\\n" > notes.txt && wc -l notes.txt && cat notes.txt')
    rec('io', 'redirect > file + cat', exists(path.join(cwd, 'notes.txt')) && /alpha/.test(r.stdout), out(r))
  }
  {
    const r = await bash('printf "a\\nb\\nc\\n" | wc -l')
    rec('io', 'pipe printf | wc -l', r.code === 0 && /3/.test(r.stdout), out(r))
  }
  {
    const r = await bash('printf "a\\nb\\nc\\n" | head -n 2')
    rec('io', 'pipe | head', r.code === 0 && /a/.test(r.stdout) && /b/.test(r.stdout) && !/c/.test(r.stdout), out(r))
  }
  {
    const r = await bash('yes | head -n 3', 8_000)
    rec(
      'io',
      'yes | head (stdin /dev/null may empty this)',
      r.code === 0 && /y/.test(r.stdout) && !r.timedOut && r.elapsed < 5_000,
      `elapsed=${r.elapsed} code=${r.code} timedOut=${!!r.timedOut} ${out(r)}`,
    )
  }
  {
    const r = await bash('echo x 2>nul; echo y 2>/dev/null')
    rec(
      'io',
      '2>nul rewrite + 2>/dev/null',
      r.code === 0 && !exists(path.join(cwd, 'nul')) && /x/.test(r.stdout) && /y/.test(r.stdout),
      `nul=${exists(path.join(cwd, 'nul'))} ${out(r)}`,
    )
  }
  {
    const r = await bash('cat <<EOF\nheredoc-line\nEOF')
    rec('io', 'heredoc', r.code === 0 && /heredoc-line/.test(r.stdout), out(r))
  }
  {
    const r = await bash('cat', 8_000, 'stdin-payload\n')
    rec('io', 'tool stdin → cat', r.code === 0 && /stdin-payload/.test(r.stdout), out(r))
  }
  {
    const r = await bash('cp notes.txt notes.bak && mv notes.bak notes.moved && test -f notes.moved && rm notes.moved && echo cleaned')
    rec('io', 'cp / mv / rm', r.code === 0 && /cleaned/.test(r.stdout) && !exists(path.join(cwd, 'notes.moved')), out(r))
  }
  {
    const r = await bash('ln -s notes.txt notes.link && test -e notes.link && echo linked')
    rec(
      'io',
      'ln -s',
      r.code === 0 && /linked/.test(r.stdout),
      `code=${r.code} ${out(r)}`,
    )
  }
  {
    const r = await bash('touch glob-a.txt glob-b.txt && ls glob-*.txt')
    rec('io', 'glob *', r.code === 0 && /glob-a/.test(r.stdout) && /glob-b/.test(r.stdout), out(r))
  }
  {
    const r = await bash('test -f notes.txt && test -d rel && echo tests-ok')
    rec('io', 'test -f / test -d', r.code === 0 && /tests-ok/.test(r.stdout), out(r))
  }

  // ── git / node (typical agent) ──────────────────────────────────────────
  {
    const ws = workspace.replace(/\\/g, '/')
    const r = await bash(`git -C '${ws}' status -sb && git -C '${ws}' rev-parse --abbrev-ref HEAD`)
    rec('dev', 'git status + branch', r.code === 0 && r.stdout.trim().length > 0, out(r))
  }
  {
    const r = await bash('node -e "console.log(1+2)"')
    rec('dev', 'node -e', r.code === 0 && /3/.test(r.stdout), out(r))
  }
  {
    const r = await bash('python -c "print(2+2)" || py -3 -c "print(2+2)" || python3 -c "print(2+2)"')
    rec('dev', 'python/py -c', r.code === 0 && /4/.test(r.stdout), out(r))
  }
  {
    const r = await bash('echo \'{"a":1}\' | node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d);process.stdin.on(\'end\',()=>console.log(JSON.parse(s).a))"')
    rec('dev', 'pipe JSON into node', r.code === 0 && /1/.test(r.stdout), out(r))
  }

  // ── Windows interop (expected failures + workarounds) ───────────────────
  {
    const r = await bash('cmd.exe //c echo cmd-ok', 12_000)
    rec(
      'win',
      'cmd.exe //c echo (workaround)',
      r.elapsed < 10_000 && /cmd-ok/i.test(r.stdout),
      `${r.elapsed}ms code=${r.code} ${out(r)}`,
    )
  }
  {
    const r = await bash('cmd.exe /c echo cmd-ok', 12_000)
    rec(
      'win',
      'cmd.exe /c echo (MSYS eats /c)',
      r.elapsed < 10_000 && /cmd-ok/i.test(r.stdout),
      `${r.elapsed}ms code=${r.code} ${out(r)}`,
    )
  }
  {
    const r = await bash('powershell.exe -NoProfile -NonInteractive -Command "Write-Output \'ps-from-bash\'"', 30_000)
    rec(
      'win',
      'powershell.exe from Bash',
      r.code === 0 && /ps-from-bash/.test(r.stdout),
      `code=${r.code} ${out(r)}`,
    )
  }
  {
    const r = await bash('Test-Path .')
    rec('win', 'Test-Path in Bash (should fail)', r.code !== 0, `code=${r.code} ${out(r)}`)
  }
  {
    const r = await bash('echo %USERPROFILE%')
    rec(
      'win',
      'echo %USERPROFILE% is literal',
      r.code === 0 && /%USERPROFILE%/.test(r.stdout),
      out(r),
    )
  }
  {
    const r = await bash('timeout /t 1 /nobreak > /dev/null; echo after-timeout')
    rec(
      'win',
      'timeout /t (GNU timeout, not CMD)',
      /after-timeout/.test(r.stdout) === false || r.code !== 0,
      `code=${r.code} ${out(r)}`,
    )
  }
  {
    const r = await bash('dir /b notes.txt')
    rec(
      'win',
      'dir /b is Git Bash dir, not CMD',
      r.code === 0,
      `code=${r.code} ${out(r)}`,
    )
  }

  // ── quoting / substitution ──────────────────────────────────────────────
  {
    const r = await bash('echo "quoted $HOME" && echo \'single $HOME\'')
    rec(
      'quote',
      'double expands, single does not',
      /quoted /.test(r.stdout) && /single \$HOME/.test(r.stdout),
      out(r),
    )
  }
  {
    const r = await bash('x=world; echo hello-$x; echo $(echo subst)')
    rec('quote', 'var + $( ) substitution', /hello-world/.test(r.stdout) && /subst/.test(r.stdout), out(r))
  }
  {
    const r = await bash("echo 'it'\\''s ok'")
    rec('quote', "escaped single quote", /it's ok/.test(r.stdout), out(r))
  }

  // summary
  const ok = rows.filter(x => x.ok).length
  const bad = rows.filter(x => !x.ok)
  console.log(`\n${ok}/${rows.length} passed, ${bad.length} failed`)
  if (bad.length) {
    console.log('\nFailed:')
    for (const b of bad) console.log(`  - [${b.cat}] ${b.name}: ${b.detail}`)
  }

  try {
    fs.rmSync(path.join(os.tmpdir(), 'baize-uc-after-tmp'), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

main().catch(err => {
  console.error(err)
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(1)
})
