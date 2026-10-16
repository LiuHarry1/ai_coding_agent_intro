// Runtime configuration, loaded before the app bundle. In Docker the web
// image's startup hook (deploy/web-runtime-config.sh) OVERWRITES this file
// from env vars, so the same image works for every deploy mode without a
// rebuild. Defaults match `npm run dev` / local Electron (auth off, Remote on).
window.__APP_CONFIG__ = { authEnabled: false, remoteEnabled: true };
