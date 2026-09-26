import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import afterPack, { prepareTerminal } from '../scripts/prepare-terminal.mjs'

test('packaged macOS helpers are executable before signing, for both architectures', async (t) => {
  const appOutDir = mkdtempSync(join(tmpdir(), 'fluid-terminal-'))
  t.after(() => rmSync(appOutDir, { recursive: true, force: true }))
  const root = join(
    appOutDir,
    'Fluid.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty'
  )
  const helpers = ['prebuilds/darwin-arm64', 'prebuilds/darwin-x64', 'build/Release'].map(
    (directory) => join(root, directory, 'spawn-helper')
  )
  for (const helper of helpers) {
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, '', { mode: 0o644 })
  }
  const addon = join(root, 'prebuilds/darwin-arm64/pty.node')
  writeFileSync(addon, '', { mode: 0o644 })
  const context = {
    appOutDir,
    electronPlatformName: 'darwin',
    packager: { appInfo: { productFilename: 'Fluid' } }
  }
  await afterPack(context)
  await afterPack(context)
  for (const helper of helpers) assert.equal(statSync(helper).mode & 0o777, 0o755)
  assert.equal(statSync(addon).mode & 0o777, 0o644)
})

test('missing helpers fail the build rather than shipping a broken terminal', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fluid-terminal-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  assert.throws(() => prepareTerminal(directory), /Missing node-pty spawn-helper/)
})

test('other platforms do not need the macOS helper', async () => {
  await afterPack({ electronPlatformName: 'linux' })
  await afterPack({ electronPlatformName: 'win32' })
})
