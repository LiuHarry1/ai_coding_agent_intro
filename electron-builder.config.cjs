/** Desktop package config — productName comes from brand.json. */

const brand = require('./brand.json')

module.exports = {
  appId: 'com.baize.desktop',
  productName: brand.name,
  directories: {
    output: 'dist-desktop',
  },
  files: [
    'electron/**/*',
    'dist/agent/**/*',
    '!dist/agent/**/*.map',
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
