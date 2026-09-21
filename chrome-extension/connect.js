/**
 * Consent page. The agent opens this URL on Chrome's command line, so the
 * query string is the only way the relay endpoint reaches the extension — and
 * nothing connects until the button below is pressed.
 */

const SUPPORTED_PROTOCOL_VERSION = 2

const $ = id => document.getElementById(id)

function fail(message) {
  $('title').textContent = 'Cannot connect'
  $('subtitle').textContent = ''
  $('actions').style.display = 'none'
  const result = $('result')
  result.className = 'error'
  result.textContent = message
}

function parseRelayUrl(raw) {
  // A loopback ws:// endpoint is the only thing this page will ever dial.
  const url = new URL(raw)
  if (url.protocol !== 'ws:') throw new Error('not a ws:// url')
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost')
    throw new Error('not a loopback address')
  return url
}

const params = new URLSearchParams(location.search)
const relayUrlRaw = params.get('relayUrl') ?? ''
const clientName = params.get('client') || 'An agent'
const requestedVersion = Number(params.get('protocolVersion') ?? '1')

let relayUrl
try {
  relayUrl = parseRelayUrl(relayUrlRaw)
} catch (err) {
  fail(`The connect link is malformed (${err.message}). Re-run the agent's pair command.`)
}

if (relayUrl && requestedVersion > SUPPORTED_PROTOCOL_VERSION) {
  fail(
    'The agent speaks a newer bridge protocol than this extension. ' +
      'Reload the extension from chrome://extensions to pick up the matching build.',
  )
} else if (relayUrl) {
  $('subtitle').textContent = `${clientName} on this machine is asking for access, via ${relayUrl.host}.`
}

$('allow').addEventListener('click', async () => {
  $('allow').disabled = true
  $('cancel').disabled = true
  const response = await chrome.runtime.sendMessage({
    type: 'connect',
    relayUrl: relayUrl.toString(),
    clientName,
  })
  if (response?.ok) {
    $('title').textContent = 'Connected'
    $('subtitle').textContent = `${clientName} can now drive this browser.`
    $('actions').style.display = 'none'
    $('result').textContent = 'You can close this tab.'
    return
  }
  $('allow').disabled = false
  $('cancel').disabled = false
  const result = $('result')
  result.className = 'error'
  result.textContent = response?.error ?? 'The agent did not accept the connection.'
})

$('cancel').addEventListener('click', () => {
  window.close()
})
