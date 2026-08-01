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
    'brand.json',
    'package.json',
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
