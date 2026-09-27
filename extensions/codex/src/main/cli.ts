import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
const execute = promisify(execFile)
export async function codexExecutable(): Promise<string> {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  if (process.platform !== 'win32')
    dirs.push(
      join(homedir(), '.local/bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/home/linuxbrew/.linuxbrew/bin'
    )
  for (const directory of new Set(dirs)) {
    const candidate = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex')
    try {
      await access(candidate, constants.X_OK)
      const { stdout } = await execute(candidate, ['--version'], {
        timeout: 5000,
        windowsHide: true
      })
      const version = /(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)/.exec(stdout)
      if (version && (+version[1]! > 0 || +version[2]! >= 154)) return candidate
    } catch {
      /* Continue past broken or outdated installations. */
    }
  }
  throw new Error(
    'Codex 0.154.0 or newer is required. Install or update Codex CLI, run “codex login” in Terminal, then click Retry.'
  )
}
