/**
 * Cursor-style tool action labels: { loading, completed, error }.
 * One card flips the verb — not two separate UI steps.
 */

const LABELS = {
  edit: { loading: 'Editing', completed: 'Edited', error: 'Edit' },
  create: { loading: 'Creating', completed: 'Created', error: 'Create' },
  write: { loading: 'Creating', completed: 'Created', error: 'Create' },
  shell: { loading: 'Running', completed: 'Ran', error: 'Run' },
  shellBackground: { loading: 'Running', completed: 'Shell', error: 'Run' },
  read: { loading: 'Reading', completed: 'Read', error: 'Read' },
  grep: { loading: 'Grepping', completed: 'Grepped', error: 'Grep' },
  glob: { loading: 'Globbing', completed: 'Globbed', error: 'Glob' },
  await: { loading: 'Waiting', completed: 'Waited', error: 'Wait' },
  stop: { loading: 'Stopping', completed: 'Stopped', error: 'Stop' },
  delete: { loading: 'Deleting', completed: 'Deleted', error: 'Delete' },
}

/**
 * @param {string} toolCase
 * @param {{ loading?: boolean, hasError?: boolean, isNewFile?: boolean, backgrounded?: boolean }} opts
 */
export function toolActionLabel(toolCase, opts = {}) {
  const { loading = false, hasError = false, isNewFile = false, backgrounded = false } =
    opts
  let key = toolCase
  if (toolCase === 'edit' && isNewFile) key = 'create'
  if (toolCase === 'shell' && backgrounded && !loading && !hasError) {
    key = 'shellBackground'
  }
  const map = LABELS[key] || LABELS[toolCase] || {
    loading: 'Working',
    completed: 'Done',
    error: 'Failed',
  }
  if (loading) return map.loading
  if (hasError) return map.error
  return map.completed
}

export { LABELS as TOOL_ACTION_LABELS }
