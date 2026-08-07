/**
 * TaskOutput — aligned with Claude Code file-mode (simplified, no UI poller).
 */
import { getTaskOutput, getTaskOutputPath, getTaskOutputSize } from './diskOutput.js'

export class TaskOutput {
  readonly taskId: string
  readonly path: string
  readonly stdoutToFile: boolean

  constructor(taskId: string, stdoutToFile = true) {
    this.taskId = taskId
    this.path = getTaskOutputPath(taskId)
    this.stdoutToFile = stdoutToFile
  }

  getStdout(maxBytes?: number): string {
    return getTaskOutput(this.taskId, maxBytes)
  }

  getStderr(): string {
    // File mode interleaves stderr into the same file.
    return ''
  }

  getOutputFileSize(): number {
    return getTaskOutputSize(this.taskId)
  }

  async flush(): Promise<void> {
    // Sync appends — nothing to flush.
  }

  clear(): void {
    // no-op for file mode
  }

  async deleteOutputFile(): Promise<void> {
    const { cleanupTaskOutput } = await import('./diskOutput.js')
    cleanupTaskOutput(this.taskId)
  }
}
