import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..', '..')
const generator = path.join(
  root,
  '.ai-agent',
  'skills',
  'echarts-chart',
  'scripts',
  'generate-chart.mjs',
)

type Spec = Record<string, unknown>

function run(temp: string, slug: string, spec: Spec, expectSuccess = true) {
  const input = path.join(temp, `${slug}.input.json`)
  const outputDir = path.join(temp, 'charts')
  fs.writeFileSync(input, JSON.stringify(spec), 'utf8')
  const result = spawnSync(
    process.execPath,
    [generator, '--input', input, '--output-dir', outputDir, '--slug', slug],
    { encoding: 'utf8' },
  )
  if (expectSuccess) {
    assert.equal(result.status, 0, result.stderr)
    return {
      html: path.join(outputDir, `${slug}.html`),
      data: path.join(outputDir, `${slug}.data.json`),
      spec: path.join(outputDir, `${slug}.spec.json`),
    }
  }
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Chart validation failed/)
  return null
}

const basic = (chartType: string): Spec => ({
  title: `${chartType} example`,
  goal: chartType === 'histogram' ? 'distribution' : 'compare',
  chartType,
  source: 'Unit test fixture',
  unit: 'items',
  missingValuePolicy: 'zero',
  data: [
    { category: 'A', value: 2 },
    { category: 'B', value: null },
    { category: 'C', value: 8 },
  ],
  fields: { x: 'category', y: 'value' },
})

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'echarts-skill-'))
  try {
    const cases: Record<string, Spec> = {
      line: basic('line'),
      bar: basic('bar'),
      area: basic('area'),
      histogram: basic('histogram'),
      table: basic('table'),
      stacked: {
        ...basic('stacked_bar'),
        data: [
          { category: 'A', pass: 8, fail: 2 },
          { category: 'B', pass: 6, fail: 3 },
        ],
        fields: { x: 'category', y: ['pass', 'fail'] },
      },
      pie: { ...basic('pie'), goal: 'composition' },
      donut: { ...basic('donut'), goal: 'composition' },
      scatter: {
        ...basic('scatter'),
        goal: 'correlation',
        data: [
          { temperature: 20, yield: 91 },
          { temperature: 25, yield: 94 },
        ],
        fields: { x: 'temperature', y: 'yield' },
      },
      heatmap: {
        ...basic('heatmap'),
        goal: 'distribution',
        data: [
          { station: 'S1', shift: 'Day', failures: 2 },
          { station: 'S1', shift: 'Night', failures: 5 },
        ],
        fields: { x: 'station', y: 'shift', value: 'failures' },
      },
      boxplot: {
        ...basic('boxplot'),
        goal: 'distribution',
        data: [
          { lot: 'L1', min: 1, q1: 2, median: 3, q3: 4, max: 5 },
          { lot: 'L2', min: 2, q1: 3, median: 4, q3: 5, max: 7 },
        ],
        fields: {
          x: 'lot',
          y: ['min', 'q1', 'median', 'q3', 'max'],
        },
      },
      pareto: {
        ...basic('pareto'),
        goal: 'ranking',
        sort: 'desc',
      },
    }

    for (const [name, spec] of Object.entries(cases)) {
      const files = run(temp, name, spec)
      assert(files)
      assert.ok(fs.statSync(files.html).size < 5 * 1024 * 1024)
      assert.ok(fs.existsSync(files.data))
      assert.ok(fs.existsSync(files.spec))
      const html = fs.readFileSync(files.html, 'utf8')
      assert.doesNotMatch(html, /<script[^>]+\bsrc=/i)
      assert.doesNotMatch(html, /\/\*__ECHARTS_RUNTIME__\*\//)
      assert.doesNotMatch(html, /\/\*__CHART_PAYLOAD__\*\//)
    }

    const rich = run(temp, 'rich', {
      title: 'Revenue </script><script>alert(1)</script>',
      goal: 'ranking',
      chartType: 'bar',
      source: ['ERP close', 'Finance adjustments'],
      unit: { revenue: 'CNY million' },
      timeRange: {
        start: '2026-01-01',
        end: '2026-08-31',
        timezone: 'Asia/Shanghai',
      },
      incompletePeriod: { label: '2026 YTD', note: 'Through August' },
      missingValuePolicy: 'error',
      topN: 2,
      includeOther: true,
      annotations: [{ x: 'B', label: 'Policy change' }],
      data: [
        { business: 'A', revenue: 10 },
        { business: 'B', revenue: 30 },
        { business: 'C', revenue: 20 },
      ],
      fields: { x: 'business', y: 'revenue' },
    })
    assert(rich)
    const firstHtml = fs.readFileSync(rich.html, 'utf8')
    assert.doesNotMatch(firstHtml, /<\/script><script>alert/)
    assert.match(firstHtml, /\\u003c\/script>/)
    const cleaned = JSON.parse(fs.readFileSync(rich.data, 'utf8'))
    assert.equal(cleaned.records.length, 3)
    assert.equal(cleaned.records[0].business, 'B')
    assert.equal(cleaned.records[2].business, 'Other')
    assert.equal(cleaned.records[2].revenue, 10)

    run(temp, 'rich', {
      title: 'Revenue </script><script>alert(1)</script>',
      goal: 'ranking',
      chartType: 'bar',
      source: ['ERP close', 'Finance adjustments'],
      unit: { revenue: 'CNY million' },
      timeRange: {
        start: '2026-01-01',
        end: '2026-08-31',
        timezone: 'Asia/Shanghai',
      },
      incompletePeriod: { label: '2026 YTD', note: 'Through August' },
      missingValuePolicy: 'error',
      topN: 2,
      includeOther: true,
      annotations: [{ x: 'B', label: 'Policy change' }],
      data: [
        { business: 'A', revenue: 10 },
        { business: 'B', revenue: 30 },
        { business: 'C', revenue: 20 },
      ],
      fields: { x: 'business', y: 'revenue' },
    })
    assert.equal(fs.readFileSync(rich.html, 'utf8'), firstHtml)

    run(
      temp,
      'bad-pie',
      {
        ...basic('pie'),
        data: Array.from({ length: 7 }, (_, index) => ({
          category: `C${index}`,
          value: index + 1,
        })),
      },
      false,
    )
    run(
      temp,
      'bad-box',
      {
        ...cases.boxplot,
        data: [{ lot: 'L1', min: 5, q1: 2, median: 3, q3: 4, max: 1 }],
      },
      false,
    )

    const pngResult = spawnSync(
      process.execPath,
      [
        generator,
        '--input',
        path.join(temp, 'bar.input.json'),
        '--output-dir',
        path.join(temp, 'charts'),
        '--slug',
        'bar-static',
        '--png',
      ],
      { encoding: 'utf8' },
    )
    assert.equal(pngResult.status, 0, pngResult.stderr)
    const png = path.join(temp, 'charts', 'bar-static.png')
    assert.ok(fs.existsSync(png))
    assert.ok(fs.statSync(png).size > 1000)

    console.log('echarts-chart generator tests OK')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
