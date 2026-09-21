/**
 * The bridge extension's id, pinned by the `key` field in its manifest.
 *
 * Chrome derives an unpacked extension's id from its public key when the
 * manifest carries one, so this stays the same on every machine. Two things
 * depend on that: the relay only accepts a WebSocket whose `Origin` is this
 * extension, and the host has to be able to name `connect.html` in a URL
 * before the extension has ever spoken to it.
 *
 * The matching private key is not in this repo and is only needed to pack a
 * `.crx`; loading the folder unpacked does not use it.
 */
export const BRIDGE_EXTENSION_ID = 'fpajgihelhfenahgncmdjadkhpcmmbac'

export const BRIDGE_EXTENSION_ORIGIN = `chrome-extension://${BRIDGE_EXTENSION_ID}`
