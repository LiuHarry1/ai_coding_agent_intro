import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { definition as writeFileDefinition } from '../tools/FileWriteTool/FileWriteTool.js'
import { createFilesystemPermissionContext } from '../utils/permissions/filesystem.js'
import { resolvePath } from '../tools/utils.js'

const root = 'C:\\Users\\harry.liu\\cursor_workspace\\ai_coding_agent_intro'
const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fix-'))
const target = path.join(mem, 'reference_concur_login.md')
const joined = path.join(root, target)
console.log('joined', joined)
console.log('resolved', resolvePath(root, joined))

const tool = writeFileDefinition.create(root, {
  permissionContext: createFilesystemPermissionContext(root, { extraWriteRoots: [mem] }),
})
const out = await (
  tool as { execute: (a: unknown) => Promise<unknown> }
).execute({
  file_path: joined,
  content: '---\nname: Concur\ntype: reference\n---\nok\n',
})
console.log(
  'result',
  typeof out === 'string'
    ? out
    : (out as { data?: { message?: string } })?.data?.message ?? out,
)
console.log('exists', fs.existsSync(target))
fs.rmSync(mem, { recursive: true, force: true })
