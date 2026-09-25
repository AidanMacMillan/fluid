import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/**
 * Which Claude Code a Claude tab runs.
 *
 * The SDK ships a CLI of its own, pinned to the SDK's version, and that CLI is
 * what decides the model picker's rows (see `claudeModels` in ./sessions.ts).
 * Pinned means a model released after the last dependency bump does not exist
 * as far as the app is concerned, even while the `claude` in the user's
 * terminal — which updates itself — already offers it. So the installed one is preferred, and
 * the bundled one is what is left when there is none, or none newer.
 */

/**
 * Where to look besides `PATH`. An app launched from the Dock gets a bare PATH,
 * and the native installer puts `claude` in `~/.local/bin`, which is not on it.
 */
const FALLBACK_DIRECTORIES = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.claude', 'local'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/home/linuxbrew/.linuxbrew/bin'
]

/** `2.1.280 (Claude Code)` → `[2, 1, 280]`. */
function versionOf(text: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return match ? match.slice(1).map(Number) : null
}

function atLeast(version: number[], floor: number[]): boolean {
  for (let i = 0; i < floor.length; i++) {
    if (version[i]! !== floor[i]!) return version[i]! > floor[i]!
  }
  return true
}

/**
 * The version of the CLI the SDK bundles, read off the manifest that sits next
 * to it. Null if that cannot be read, in which case any installed CLI that runs
 * is taken — being out of date is the problem this file exists to solve, and
 * the bundled one is the likelier of the two to be.
 */
function bundledVersion(): number[] | null {
  try {
    const sdk = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
    const manifest = JSON.parse(readFileSync(join(sdk, 'manifest.json'), 'utf8')) as {
      version?: string
    }
    return manifest.version ? versionOf(manifest.version) : null
  } catch {
    return null
  }
}

function findInstalledClaude(): string | undefined {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const onPath = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')
  const directories = process.platform === 'win32' ? onPath : [...onPath, ...FALLBACK_DIRECTORIES]
  for (const directory of directories) {
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here. Keep looking.
    }
  }
  return undefined
}

let chosen: { path: string | undefined } | null = null

/**
 * The installed `claude` to run, or undefined for the SDK's own.
 *
 * Decided once per launch: asking costs a process, and a CLI that updates
 * itself mid-run is picked up next launch like every other update. An installed
 * CLI older than the bundled one loses, so a stale Homebrew copy cannot take
 * away a model the app already knew about.
 */
export function claudeExecutable(): string | undefined {
  if (chosen) return chosen.path
  chosen = { path: undefined }
  const installed = findInstalledClaude()
  if (!installed) return undefined
  try {
    const output = execFileSync(installed, ['--version'], { encoding: 'utf8', timeout: 5_000 })
    const version = versionOf(output)
    const floor = bundledVersion()
    if (!version || (floor && !atLeast(version, floor))) return undefined
    chosen.path = installed
  } catch {
    // It is there but does not run. The bundled one does.
  }
  return chosen.path
}
