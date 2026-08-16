/**
 * Print the pairing details for the browser extension.
 *
 * Run: npx tsx src/scripts/browser-pair.ts
 */
import { DEFAULT_RELAY_PORT } from '../browser/relay/protocol.js'
import { getPairingToken } from '../browser/relay/server.js'
import { resolveSettings } from '../core/settings-manager.js'

const config = resolveSettings(process.cwd()).config.browser ?? {}
const port = config.relayPort ?? DEFAULT_RELAY_PORT
const token = getPairingToken()

console.log('')
console.log('  Browser extension pairing')
console.log('  ─────────────────────────')
console.log(`  Port   ${port}`)
console.log(`  Token  ${token}`)
console.log('')
console.log(
  '  1. chrome://extensions → Developer mode → Load unpacked → select chrome-extension/',
)
console.log('  2. Open the extension popup and paste the token above')
console.log('')

if (config.mode !== 'extension') {
  console.log(
    '  Note: browser.mode is currently "' +
      (config.mode ?? 'isolated') +
      '". Set it to "extension" in .ai-agent/settings.json',
  )
  console.log('  for the agent to drive this browser instead of its own.')
  console.log('')
}
