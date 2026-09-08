/**
 * Git Bash path derivation — CC `pathWin32.join(git.exe, '..', '..', 'bin', 'bash.exe')`.
 */
import { bashExeFromGitExe, findGitBashPath } from '../core/shell/windows-paths.js'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function assertEq(got: string, want: string, msg: string): void {
  assert(got === want, `${msg}\n  got:  ${got}\n  want: ${want}`)
}

assertEq(
  bashExeFromGitExe('C:\\Program Files\\Git\\cmd\\git.exe'),
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'Program Files cmd\\git.exe',
)

assertEq(
  bashExeFromGitExe(
    'C:\\Users\\foo\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
  ),
  'C:\\Users\\foo\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
  'AppData Local Programs cmd\\git.exe',
)

assertEq(
  bashExeFromGitExe('C:\\Program Files (x86)\\Git\\cmd\\git.exe'),
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'Program Files (x86) cmd\\git.exe',
)

if (process.platform === 'win32') {
  const found = findGitBashPath()
  assert(found, 'findGitBashPath should resolve Git Bash on this machine')
  console.log(`Git Bash: ${found}`)
}

console.log('windows git-bash path checks passed')
