// Runtime configuration, loaded before the app bundle. In Docker the web
// image's startup hook (deploy/web-runtime-config.sh) OVERWRITES this file
// from the AUTH_ENABLED env var, so the same image works for every deploy
// mode without a rebuild. This default (auth off) is what `npm run dev`
// and the password/local modes use.
window.__APP_CONFIG__ = { authEnabled: false };
