/** Desktop package config — productName comes from brand.json. */

const brand = require('./brand.json')

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
    'electron/**/*',
    'dist/agent/**/*',
    '!dist/agent/**/*.map',
    '!dist/agent/*-agent',
    '!dist/agent/*-agent.exe',
    'dist/worker/**/*',
    '!dist/worker/**/*.map',
    'client/web/dist/**/*',
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
