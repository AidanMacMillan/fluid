import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = join(here, '../..')
const out = join(desktop, 'out-test')

// Build the actual sandboxed preload, then test it with Electron's real sessions.
const compile = spawnSync('pnpm', ['exec', 'electron-vite', 'build', '--outDir', 'out-test'], {
  cwd: desktop,
  stdio: 'inherit'
})
if (compile.status !== 0) process.exit(compile.status ?? 1)
await build({
  configFile: false,
  root: desktop,
  logLevel: 'warn',
  build: {
    ssr: join(here, 'harness.ts'),
    outDir: join(out, 'adblocker'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      external: ['electron', /^node:/],
      output: { format: 'cjs', entryFileNames: 'index.cjs' }
    }
  }
})
const result = spawnSync(electron, [join(out, 'adblocker/index.cjs')], {
  cwd: desktop,
  stdio: 'inherit'
})
process.exit(result.status ?? 1)
