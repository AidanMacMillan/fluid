// Renders the app icons (see theme-icons.mjs) when they are missing or older
// than what they are drawn from. They are build output, not checked in, so a
// fresh clone has none; dev, start and build run this first. Up to date, it
// costs a few stats rather than an Electron launch.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(desktop, 'scripts/theme-icons.mjs')

const sources = [join(desktop, 'build/icon.svg'), script]
const outputs = [join(desktop, 'resources/icon.png')]
const icons = join(desktop, 'resources/icons')
if (existsSync(icons)) {
  for (const file of readdirSync(icons, { recursive: true })) {
    if (file.endsWith('.png')) outputs.push(join(icons, file))
  }
}

const newestSource = Math.max(...sources.map((file) => statSync(file).mtimeMs))
const oldestOutput = Math.min(
  ...outputs.map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0))
)

if (oldestOutput <= newestSource) {
  const { status } = spawnSync(electron, [script], { stdio: 'inherit' })
  if (status !== 0) process.exit(status ?? 1)
}
