// Generate the package's declarations from the JSDoc in its sources, then
// add the hand-written entry point that holds the augmentable event maps.
// Run through `npm run build:types`, which puts the local `tsc` on PATH.
import { execFileSync } from 'node:child_process'
import { copyFileSync, rmSync } from 'node:fs'

const OUT = 'types'

rmSync(OUT, { recursive: true, force: true })
execFileSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit' })
copyFileSync('server/index.d.ts', `${OUT}/server/index.d.ts`)
