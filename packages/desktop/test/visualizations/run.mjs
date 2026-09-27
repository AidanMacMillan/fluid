import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import electron from 'electron'
const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../out-test/visualizations')
await build({
  configFile: false,
  root: join(here, '../..'),
  plugins: [svelte()],
  logLevel: 'error',
  build: {
    outDir: out,
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: join(here, 'renderer.svelte.ts'),
      formats: ['es'],
      fileName: () => 'renderer.js',
      cssFileName: 'renderer'
    }
  }
})
await build({
  configFile: false,
  root: join(here, '../..'),
  logLevel: 'error',
  ssr: { noExternal: true, external: ['electron'] },
  build: {
    ssr: join(here, 'harness.ts'),
    outDir: out,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external: ['electron', /^node:/],
      output: { format: 'cjs', entryFileNames: 'harness.cjs' }
    }
  }
})
const result = spawnSync(electron, [join(out, 'harness.cjs')], {
  stdio: 'inherit',
  timeout: 45000,
  env: { ...process.env, ELECTRON_RENDERER_URL: 'fluid-test://host' }
})
process.exit(result.status ?? 1)
