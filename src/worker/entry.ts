/**
 * Standalone worker bundle entry (esbuild → dist/worker/{slug}-worker.cjs).
 * The unified agent uses --worker-stdio on baize-agent instead; this slim
 * artifact remains for optional SSH deploy when upload size matters.
 */
import { runWorkerStdio } from './main.js'
import { WORKER_BUNDLE_NAME } from '../brand.js'

if (!process.argv.includes('--stdio')) {
  process.stderr.write(
    `Usage: ${WORKER_BUNDLE_NAME.replace(/\.cjs$/, '')} --stdio\n`,
  )
  process.exit(2)
}

runWorkerStdio()
