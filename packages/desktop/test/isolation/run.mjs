// Runs the installed-extension sandbox test (harness.ts) in Electron.
//
// Builds the app into out-test/ — the harness loads the app's own extension
// host page and preload from there — then bundles the harness and the probe
// extension beside it, and starts Electron on the harness. Exits with its code.
//
//   pnpm --filter @fluid/desktop test:isolation
//   LIVE_NETWORK=1 pnpm --filter @fluid/desktop test:isolation   (also real requests)

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, '../..')
const out = join(desktop, 'out-test')

const step = (command, args) => {
  const result = spawnSync(command, args, { cwd: desktop, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

step('pnpm', ['exec', 'electron-vite', 'build', '--outDir', 'out-test'])

const quiet = (warning, warn) => {
  if (warning.code !== 'INVALID_ANNOTATION') warn(warning)
}

await build({
  configFile: false,
  root: desktop,
  logLevel: 'warn',
  build: {
    outDir: join(out, 'harness'),
    emptyOutDir: true,
    target: 'chrome140',
    minify: false,
    rollupOptions: { onwarn: quiet },
    lib: { entry: join(here, 'probe.js'), formats: ['es'], fileName: () => 'probe.mjs' }
  }
})

await build({
  configFile: false,
  root: desktop,
  logLevel: 'warn',
  ssr: { noExternal: true, external: ['electron'] },
  build: {
    ssr: join(here, 'harness.ts'),
    outDir: join(out, 'harness'),
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    rollupOptions: {
      onwarn: quiet,
      external: ['electron', /^node:/],
      output: { format: 'cjs', entryFileNames: 'index.cjs' }
    }
  }
})

step(electron, [join(out, 'harness', 'index.cjs')])
