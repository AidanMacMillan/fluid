import { chmodSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// node-pty 1.1.0 ships its macOS spawn-helper prebuilds without executable
// permissions. Fix both architectures, including any locally rebuilt helper.
// Do this before signing; a running, installed app should never repair itself.
export function prepareTerminal(packageDirectory) {
  const helpers = readdirSync(packageDirectory, { recursive: true }).filter(
    (file) => file.split(/[\\/]/).at(-1) === 'spawn-helper'
  )
  if (helpers.length === 0) throw new Error(`Missing node-pty spawn-helper in ${packageDirectory}`)
  for (const helper of helpers) {
    const path = join(packageDirectory, helper)
    const mode = statSync(path).mode
    if ((mode & 0o111) !== 0o111) chmodSync(path, (mode & 0o777) | 0o111)
  }
}

// electron-builder calls afterPack after copying dependencies and before signing.
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  prepareTerminal(
    join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents/Resources/app.asar.unpacked/node_modules/node-pty'
    )
  )
}

// Also repair development installs, which use node-pty directly from pnpm.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.platform === 'darwin'
) {
  const require = createRequire(import.meta.url)
  prepareTerminal(dirname(require.resolve('node-pty/package.json')))
}
