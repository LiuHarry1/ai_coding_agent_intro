import { createShellTool } from '../shell-runner.js'
import { POWERSHELL_TOOL_NAME } from '../../constants/tool_names.js'
import { DESCRIPTION } from './prompt.js'

export const definition = createShellTool({
  name: POWERSHELL_TOOL_NAME,
  description: DESCRIPTION,
  commandFieldDesc: 'The PowerShell command to execute.',
  shell: 'powershell',
})
