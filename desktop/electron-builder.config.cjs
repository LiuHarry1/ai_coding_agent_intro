/**
 * Desktop package config — productName comes from brand.json.
 *
 * Invoked from the repo root (`electron-builder --config desktop/...`), so
 * `files` / `extraResources` paths below are relative to the repo root, not
 * to this directory.
 */

const brand = require('../brand.json')

// GitHub electron releases often stall in CN (got request timeout). Override with ELECTRON_MIRROR.
const electronMirror =
  process.env.ELECTRON_MIRROR ||
  process.env.npm_config_electron_mirror ||
  'https://npmmirror.com/mirrors/electron/'

module.exports = {
  appId: 'com.baize.desktop',
  productName: brand.name,
  electronDownload: {
    mirror: electronMirror,
  },
  directories: {
    output: 'dist-desktop',
  },
  files: [
    'desktop/**/*',
    'dist/agent/**/*',
    '!dist/agent/**/*.map',
    '!dist/agent/*-agent',
    '!dist/agent/*-agent.exe',
    'dist/worker/**/*',
    '!dist/worker/**/*.map',
    'web/dist/**/*',
    'integrations/**/*',
    'brand.json',
    'package.json',
    '!node_modules',
  ],
  extraResources: [
    {
      from: 'deploy/desktop/workspace-seed',
      to: 'workspace-seed',
      filter: ['**/*'],
    },
    {
      from: 'chrome-extension',
      to: 'chrome-extension',
      filter: ['**/*', '!**/*.pem', '!**/*.crx'],
    },
    {
      from: 'dist/desktop-resources/ripgrep',
      to: 'ripgrep',
      filter: ['**/*'],
    },
  ],
  asar: false,
  win: {
    target: ['nsis'],
  },
  mac: {
    target: ['dmg'],
  },
  linux: {
    target: ['AppImage'],
  },
}
