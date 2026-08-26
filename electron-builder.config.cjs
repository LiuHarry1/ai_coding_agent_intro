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
    'start.js',
    'src/**/*',
    'protocol/**/*',
    'client/web/dist/**/*',
    // Bundled execution-plane worker (built by `npm run build:worker`)
    'dist/worker/**/*',
    'brand.json',
    'package.json',
    // Production deps only by default; `tsx` must be in dependencies
    // because the packaged app boots the agent via `tsx start.js`.
    'node_modules/**/*',
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
