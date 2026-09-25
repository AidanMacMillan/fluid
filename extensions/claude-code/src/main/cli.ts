import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

// Apps launched from the Dock may not inherit the user's shell PATH.
const FALLBACK_DIRECTORIES = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.claude', 'local'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/home/linuxbrew/.linuxbrew/bin'
]

function versionOf(text: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(text.trim())
  return match ? match.slice(1).map(Number) : null
}

function atLeast(version: number[], floor: number[]): boolean {
  for (let i = 0; i < floor.length; i++) {
    if (version[i]! !== floor[i]!) return version[i]! > floor[i]!
  }
  return true
}

// Use the CLI version shipped with this SDK as our tested compatibility floor.
// Its manifest remains in the app; the executable itself is never bundled.
function minimumVersion(): number[] {
  const sdk = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
  const manifest = JSON.parse(readFileSync(join(sdk, 'manifest.json'), 'utf8')) as {
    version?: string
  }
  const version = manifest.version ? versionOf(manifest.version) : null
  if (!version)
    throw new Error('Fluid’s Claude compatibility information is missing. Reinstall Fluid.')
  return version
}

/** Resolve a compatible local installation for each new session, including retries. */
export function claudeExecutable(): string {
  const floor = minimumVersion()
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const onPath = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  const directories = process.platform === 'win32' ? onPath : [...onPath, ...FALLBACK_DIRECTORIES]
  let found = false
  let outdated = false
  for (const directory of new Set(directories)) {
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    found = true
    try {
      const output = execFileSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true
      })
      const version = versionOf(output)
      if (version && atLeast(version, floor)) return candidate
      if (version) outdated = true
    } catch {
      // A broken PATH entry should not hide a working native installation.
    }
  }
  if (outdated) {
    throw new Error(
      `Fluid requires Claude Code ${floor.join('.')} or newer. Update Claude Code with “claude update” (or your package manager), then click Retry.`
    )
  }
  if (found) {
    throw new Error(
      'Claude Code could not start. Run “claude --version” in Terminal, repair or update your installation, then click Retry.'
    )
  }
  throw new Error(
    'Claude Code is not installed. Install it from code.claude.com/docs/en/setup, run “claude” in Terminal to sign in, then click Retry.'
  )
}
