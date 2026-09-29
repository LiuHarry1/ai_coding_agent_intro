/**
 * Deterministic integration checks for the built-in coding tools.
 * Run: npx tsx src/scripts/test-coding-tools-core.ts
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  EDIT_FILE_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../constants/tool_names.js'
import type {
  AnyTool,
  ToolContext,
  ToolDefinition,
} from '../core/types.js'
import { noopWireEmitter } from '../core/wire-emitter.js'
import {
  executeOneTool,
  type ExecutedToolResult,
} from '../services/tools/tool_execution.js'
import { definition as editDefinition } from '../tools/FileEditTool/FileEditTool.js'
import { definition as readDefinition } from '../tools/FileReadTool/FileReadTool.js'
import { definition as globDefinition } from '../tools/GlobTool/GlobTool.js'
import { definition as grepDefinition } from '../tools/GrepTool/GrepTool.js'
import { definition as writeDefinition } from '../tools/FileWriteTool/FileWriteTool.js'
import { createFilesystemPermissionContext } from '../utils/permissions/filesystem.js'
import type { ReadFileState } from '../utils/read/types.js'

const definitions = new Map<string, ToolDefinition>(
  [
    readDefinition,
    writeDefinition,
    editDefinition,
    globDefinition,
    grepDefinition,
  ].map(definition => [definition.name, definition]),
)

let callNumber = 0

function toolData<T>(result: ExecutedToolResult): T {
  assert.notEqual(
    result.toolUseResult,
    undefined,
    `${result.toolName} should emit toolUseResult`,
  )
  const definition = definitions.get(result.toolName)
  assert.ok(definition?.outputSchema, `${result.toolName} should have a schema`)
  assert.equal(
    definition.outputSchema.safeParse(result.toolUseResult).success,
    true,
    `${result.toolName} toolUseResult should satisfy its output schema`,
  )
  return result.toolUseResult as T
}

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'coding-tools-core-'),
  )
  const readFileState: ReadFileState = new Map()
  const context = {
    wire: noopWireEmitter,
    permissionContext: createFilesystemPermissionContext(workspace, {
      mode: 'dontAsk',
    }),
    session: { readFileState },
  } as ToolContext
  const tools = Object.fromEntries(
    [...definitions.values()].map(definition => [
      definition.name,
      definition.create(workspace, context),
    ]),
  ) as Record<string, AnyTool>

  async function run(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ExecutedToolResult> {
    callNumber += 1
    return executeOneTool(
      {
        toolCallId: `core-${callNumber}`,
        toolName,
        input,
      },
      tools,
      noopWireEmitter,
      undefined,
      name => definitions.get(name),
    )
  }

  try {
    fs.mkdirSync(path.join(workspace, 'src', 'nested'), { recursive: true })
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true })
    fs.writeFileSync(
      path.join(workspace, 'src', 'alpha.ts'),
      'first\nconst TOKEN = "Alpha"\nthird\nTOKEN again\n',
    )
    fs.writeFileSync(
      path.join(workspace, 'src', 'nested', 'beta.ts'),
      'const beta = "TOKEN"\nconst lower = "token"\n',
    )
    fs.writeFileSync(
      path.join(workspace, 'docs', 'notes.md'),
      'TOKEN in markdown\n',
    )
    fs.writeFileSync(path.join(workspace, 'src', 'ignore.js'), 'TOKEN\n')

    const read = await run(FILE_READ_TOOL_NAME, {
      file_path: 'src/alpha.ts',
      offset: 2,
      limit: 2,
    })
    assert.equal(read.isError, undefined)
    assert.match(read.result, /const TOKEN = "Alpha"/)
    assert.match(read.result, /third/)
    assert.doesNotMatch(read.result, /TOKEN again/)
    const readData = toolData<{
      type: string
      file: {
        filePath: string
        content: string
        numLines: number
        startLine: number
        totalLines: number
      }
    }>(read)
    assert.equal(readData.type, 'text')
    assert.equal(readData.file.filePath, 'src/alpha.ts')
    assert.equal(readData.file.content, ' ', 'wire projection strips file body')
    assert.equal(readData.file.startLine, 2)
    assert.equal(readData.file.numLines, 2)
    assert.equal(readData.file.totalLines, 5)

    const unchanged = await run(FILE_READ_TOOL_NAME, {
      file_path: 'src/alpha.ts',
      offset: 2,
      limit: 2,
    })
    assert.match(unchanged.result, /unchanged/i)
    assert.equal(toolData<{ type: string }>(unchanged).type, 'file_unchanged')

    const missingRead = await run(FILE_READ_TOOL_NAME, {
      file_path: 'missing.txt',
    })
    assert.equal(missingRead.isError, true)
    assert.match(missingRead.result, /^Error: File does not exist:/)
    assert.equal(missingRead.toolUseResult, undefined)

    const created = await run(WRITE_FILE_TOOL_NAME, {
      file_path: 'generated/deep/new.txt',
      content: 'one\ntwo',
    })
    const createData = toolData<{
      type: string
      filePath: string
      content: string
      numLines: number
      numChars: number
      beforeContent?: string
    }>(created)
    assert.equal(createData.type, 'create')
    assert.equal(createData.filePath, 'generated/deep/new.txt')
    assert.equal(createData.content, 'one\ntwo')
    assert.equal(createData.numLines, 2)
    assert.equal(createData.numChars, 7)
    assert.equal(createData.beforeContent, undefined)
    assert.equal(
      fs.readFileSync(path.join(workspace, 'generated/deep/new.txt'), 'utf8'),
      'one\ntwo',
    )

    const overwritten = await run(WRITE_FILE_TOOL_NAME, {
      file_path: 'generated/deep/new.txt',
      content: 'replaced\n',
    })
    const overwriteData = toolData<{
      type: string
      beforeContent?: string
    }>(overwritten)
    assert.equal(overwriteData.type, 'update')
    assert.equal(overwriteData.beforeContent, 'one\ntwo')
    assert.equal(
      fs.readFileSync(path.join(workspace, 'generated/deep/new.txt'), 'utf8'),
      'replaced\n',
    )

    const editPath = path.join(workspace, 'generated', 'edit.txt')
    fs.writeFileSync(editPath, 'red\nblue\nred\n')
    const ambiguousBefore = fs.readFileSync(editPath, 'utf8')
    const ambiguous = await run(EDIT_FILE_TOOL_NAME, {
      file_path: 'generated/edit.txt',
      old_string: 'red',
      new_string: 'green',
    })
    assert.equal(ambiguous.isError, true)
    assert.match(ambiguous.result, /^Error: found 2 matches/)
    assert.equal(ambiguous.toolUseResult, undefined)
    assert.equal(
      fs.readFileSync(editPath, 'utf8'),
      ambiguousBefore,
      'failed edit must not mutate the file',
    )

    const replaceAll = await run(EDIT_FILE_TOOL_NAME, {
      file_path: 'generated/edit.txt',
      old_string: 'red',
      new_string: 'green',
      replace_all: true,
    })
    const replaceAllData = toolData<{
      type: string
      replacements: number
      beforeContent: string
      afterContent: string
    }>(replaceAll)
    assert.equal(replaceAllData.type, 'update')
    assert.equal(replaceAllData.replacements, 2)
    assert.equal(replaceAllData.beforeContent, ambiguousBefore)
    assert.equal(replaceAllData.afterContent, 'green\nblue\ngreen\n')
    assert.equal(fs.readFileSync(editPath, 'utf8'), replaceAllData.afterContent)

    const fuzzy = await run(EDIT_FILE_TOOL_NAME, {
      file_path: 'generated/edit.txt',
      old_string: '  blue  ',
      new_string: 'azure',
    })
    assert.equal(toolData<{ replacements: number }>(fuzzy).replacements, 1)
    assert.equal(fs.readFileSync(editPath, 'utf8'), 'green\nazure\ngreen\n')

    const identicalBefore = fs.readFileSync(editPath, 'utf8')
    const identical = await run(EDIT_FILE_TOOL_NAME, {
      file_path: 'generated/edit.txt',
      old_string: 'azure',
      new_string: 'azure',
    })
    assert.equal(identical.isError, true)
    assert.match(identical.result, /^Error: old_string and new_string are identical/)
    assert.equal(fs.readFileSync(editPath, 'utf8'), identicalBefore)

    const missingEdit = await run(EDIT_FILE_TOOL_NAME, {
      file_path: 'generated/absent.txt',
      old_string: 'x',
      new_string: 'y',
    })
    assert.equal(missingEdit.isError, true)
    assert.match(missingEdit.result, /^Error: file not found/)

    const glob = await run(GLOB_TOOL_NAME, {
      pattern: '**/*.ts',
      path: 'src',
    })
    const globData = toolData<{
      filenames: string[]
      numFiles: number
      truncated: boolean
    }>(glob)
    assert.deepEqual(
      [...globData.filenames].sort(),
      ['src/alpha.ts', 'src/nested/beta.ts'],
    )
    assert.equal(globData.numFiles, 2)
    assert.equal(globData.truncated, false)
    assert.match(glob.result, /src\/alpha\.ts/)

    const directoryGlob = await run(GLOB_TOOL_NAME, { pattern: 'src/nested' })
    assert.deepEqual(
      toolData<{ filenames: string[] }>(directoryGlob).filenames,
      ['src/nested/beta.ts'],
      'literal directory patterns should normalize to a recursive glob',
    )

    const emptyGlob = await run(GLOB_TOOL_NAME, {
      pattern: '**/*.py',
      path: 'src',
    })
    assert.equal(toolData<{ numFiles: number }>(emptyGlob).numFiles, 0)
    assert.equal(emptyGlob.result, 'No files found')

    const grepFiles = await run(GREP_TOOL_NAME, {
      pattern: 'TOKEN',
      path: 'src',
      glob: '*.ts',
      output_mode: 'files_with_matches',
    })
    const grepFilesData = toolData<{
      mode: string
      filenames: string[]
      files: Array<{ path: string; matchCount: number }>
    }>(grepFiles)
    assert.equal(grepFilesData.mode, 'files_with_matches')
    assert.deepEqual(
      [...grepFilesData.filenames].sort(),
      ['src/alpha.ts', 'src/nested/beta.ts'],
    )
    assert.deepEqual(
      [...grepFilesData.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(file => [file.path, file.matchCount]),
      [
        ['src/alpha.ts', 2],
        ['src/nested/beta.ts', 1],
      ],
    )

    const grepContent = await run(GREP_TOOL_NAME, {
      pattern: '^const',
      path: 'src',
      type: 'ts',
      output_mode: 'content',
      head_limit: 1,
    })
    const grepContentData = toolData<{
      mode: string
      content?: string
      numLines?: number
      numMatches?: number
      appliedLimit?: number
    }>(grepContent)
    assert.equal(grepContentData.mode, 'content')
    assert.equal(grepContentData.numLines, 1)
    assert.equal(grepContentData.numMatches, 1)
    assert.equal(grepContentData.appliedLimit, 1)
    assert.match(grepContentData.content ?? '', /^src\//)
    assert.match(grepContent.result, /pagination = limit: 1/)

    const grepCount = await run(GREP_TOOL_NAME, {
      pattern: 'token',
      path: 'src',
      glob: '*.ts',
      output_mode: 'count',
      '-i': true,
    })
    const grepCountData = toolData<{
      mode: string
      numFiles: number
      numMatches?: number
      files: Array<{ path: string; matchCount: number }>
    }>(grepCount)
    assert.equal(grepCountData.mode, 'count')
    assert.equal(grepCountData.numFiles, 2)
    assert.equal(grepCountData.numMatches, 4)
    assert.deepEqual(
      [...grepCountData.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(file => [file.path, file.matchCount]),
      [
        ['src/alpha.ts', 2],
        ['src/nested/beta.ts', 2],
      ],
    )
    assert.match(grepCount.result, /Found 4 total occurrences across 2 files/)

    const noMatches = await run(GREP_TOOL_NAME, {
      pattern: 'DOES_NOT_EXIST',
      path: 'src',
      output_mode: 'content',
    })
    const noMatchesData = toolData<{
      numFiles: number
      numMatches?: number
      content?: string
    }>(noMatches)
    assert.equal(noMatchesData.numFiles, 0)
    assert.equal(noMatchesData.numMatches, 0)
    assert.equal(noMatchesData.content, 'No matches found')

    const missingGrepPath = await run(GREP_TOOL_NAME, {
      pattern: 'TOKEN',
      path: path.dirname(workspace),
      output_mode: 'files_with_matches',
    })
    assert.equal(missingGrepPath.isError, true)
    assert.match(missingGrepPath.result, /^Error:/)
    assert.equal(missingGrepPath.toolUseResult, undefined)

    const remoteFiles = new Map<string, string>()
    const remoteExecution = {
      environmentId: 'ssh-fixture',
      resolve: (base: string, value: string) =>
        `${base.replace(/\/$/, '')}/${value.replace(/^\.?\//, '')}`,
      assertInWorkspace: (base: string, value: string) => {
        if (!value.startsWith(`${base}/`)) throw new Error('outside workspace')
      },
      exists: async (value: string) => remoteFiles.has(value),
      isDirectory: async () => false,
      readText: async (value: string) => {
        const content = remoteFiles.get(value)
        if (content === undefined) throw new Error('missing remote file')
        return content
      },
      writeText: async (value: string, content: string) => {
        remoteFiles.set(value, content)
      },
      rg: async () => ['remote/a.ts', 'remote/b.ts'],
    }
    const remoteContext = {
      wire: noopWireEmitter,
      execution: remoteExecution,
    } as unknown as ToolContext
    const remoteDefinitions = [writeDefinition, editDefinition, globDefinition]
    const remoteTools = Object.fromEntries(
      remoteDefinitions.map(definition => [
        definition.name,
        definition.create('/remote/ws', remoteContext),
      ]),
    ) as Record<string, AnyTool>
    const runRemote = async (toolName: string, input: Record<string, unknown>) =>
      executeOneTool(
        {
          toolCallId: `remote-${++callNumber}`,
          toolName,
          input,
        },
        remoteTools,
        noopWireEmitter,
        undefined,
        name => definitions.get(name),
      )

    const remoteCreate = await runRemote(WRITE_FILE_TOOL_NAME, {
      file_path: 'remote/a.ts',
      content: 'const remote = 1\n',
    })
    assert.equal(toolData<{ type: string }>(remoteCreate).type, 'create')
    const remoteUpdate = await runRemote(WRITE_FILE_TOOL_NAME, {
      file_path: 'remote/a.ts',
      content: 'const remote = 2\nconst second = 2\n',
    })
    assert.equal(toolData<{ type: string }>(remoteUpdate).type, 'update')
    const remoteEdit = await runRemote(EDIT_FILE_TOOL_NAME, {
      file_path: 'remote/a.ts',
      old_string: 'remote = 2',
      new_string: 'remote = 3',
    })
    assert.equal(
      toolData<{ replacements: number }>(remoteEdit).replacements,
      1,
    )
    const remoteMissingEdit = await runRemote(EDIT_FILE_TOOL_NAME, {
      file_path: 'remote/missing.ts',
      old_string: 'x',
      new_string: 'y',
    })
    assert.match(remoteMissingEdit.result, /file not found/)
    const remoteGlob = await runRemote(GLOB_TOOL_NAME, {
      pattern: '**/*.ts',
      path: 'remote',
    })
    assert.deepEqual(
      toolData<{ filenames: string[] }>(remoteGlob).filenames,
      ['remote/a.ts', 'remote/b.ts'],
    )

    for (const definition of definitions.values()) {
      assert.ok(definition.outputSchema, `${definition.name} schema missing`)
      assert.equal(
        definition.outputSchema.safeParse({ definitely: 'invalid' }).success,
        false,
        `${definition.name} schema must reject malformed output`,
      )
    }

    console.log(
      `coding tools core tests passed (${callNumber} real tool executions)`,
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

await main()
