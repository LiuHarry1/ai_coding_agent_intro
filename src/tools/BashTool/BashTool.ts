import { createShellTool } from '../shell-runner.js'
import { BASH_TOOL_NAME } from '../../constants/tool_names.js'
import { DESCRIPTION } from './prompt.js'

export const definition = createShellTool({
  name: BASH_TOOL_NAME,
  description: DESCRIPTION,
  commandFieldDesc: 'The bash command to execute.',
  shell: 'bash',
})
