const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const runtime = require.resolve('echarts/dist/echarts.min.js', {
  paths: [root],
})
const sourceSkill = path.join(root, '.ai-agent', 'skills', 'echarts-chart')
const deploySkill = path.join(
  root,
  'deploy',
  'workspace-seed',
  '.ai-agent',
  'skills',
  'echarts-chart',
)
const checkOnly = process.argv.includes('--check')

function copyTree(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true })
}

function listFiles(dir, prefix = '') {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => {
      const relative = path.join(prefix, entry.name)
      return entry.isDirectory()
        ? listFiles(path.join(dir, entry.name), relative)
        : [relative]
    })
    .sort()
}

function assertTreesEqual(left, right) {
  const leftFiles = listFiles(left)
  const rightFiles = listFiles(right)
  if (leftFiles.join('\n') !== rightFiles.join('\n')) {
    throw new Error('echarts-chart skill file inventories differ')
  }
  for (const relative of leftFiles) {
    if (
      !fs
        .readFileSync(path.join(left, relative))
        .equals(fs.readFileSync(path.join(right, relative)))
    ) {
      throw new Error(`echarts-chart skill file differs: ${relative}`)
    }
  }
}

const vendoredRuntime = path.join(sourceSkill, 'references', 'echarts.min.js')
if (checkOnly) {
  if (!fs.readFileSync(runtime).equals(fs.readFileSync(vendoredRuntime))) {
    throw new Error('vendored ECharts runtime is not the locked 5.5.1 package')
  }
} else {
  fs.copyFileSync(runtime, vendoredRuntime)
  copyTree(sourceSkill, deploySkill)
}
assertTreesEqual(sourceSkill, deploySkill)

console.log(
  checkOnly
    ? 'echarts-chart skill copies are identical'
    : 'synced echarts-chart skill and ECharts 5.5.1 runtime',
)
