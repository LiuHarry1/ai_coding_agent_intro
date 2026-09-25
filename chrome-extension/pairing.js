/**
 * Auto-connect token.
 *
 * The extension generates a secret once and shows it in the popup; the user
 * puts it in the agent's config. The agent never sends the secret itself — it
 * sends HMAC-SHA256(token, relayUrl), which is only good for that one relay
 * endpoint, so seeing it on Chrome's command line does not let anyone reuse it.
 *
 * Plain ES module with no chrome.* calls so the agent's tests can import it
 * and check both sides compute the same proof.
 */

const TOKEN_BYTES = 32

function toBase64Url(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generatePairingToken() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))
}

export async function pairingProof(token, relayUrl) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(relayUrl)),
  )
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function sameProof(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length)
    return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
