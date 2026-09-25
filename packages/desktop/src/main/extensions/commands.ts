import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { ProcessOptions, ProcessResult } from '@fluid/sdk'

/**
 * Running a command for an extension (`ctx.process.run`).
 *
 * By name only, found on PATH and run without a shell, so what runs is one
 * program with the arguments it was given and nothing a shell would make of
 * them. For an installed extension the name has already been checked against
 * the commands its manifest asked for (see ./isolation/proxy.ts); what is here
 * is how any command is found and run.
 *
 * @module commands
 */

/**
 * Where to look besides PATH. An app launched from the Finder or the Dock does
 * not inherit the PATH a terminal has: macOS hands GUI processes a bare
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which is exactly where Homebrew and the
 * usual installers do not put anything.
 */
const FALLBACK_DIRECTORIES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/home/linuxbrew/.linuxbrew/bin',
  join(homedir(), '.local', 'bin')
]

const DEFAULT_TIMEOUT_MS = 60_000

/** How much of each stream is kept. Past this the command is ended rather than buffered without end. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * The environment variables a command run for an installed extension keeps:
 * who and where the user is, their locale and their temporary folders — what a
 * program needs to find its own configuration. Not the rest of the app's
 * environment, which can hold anyone's tokens.
 */
const MINIMAL_ENVIRONMENT = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  // Windows keeps the same things under other names.
  'SYSTEMROOT',
  'WINDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'COMSPEC',
  'TEMP',
  'TMP'
]

function environment(minimal: boolean): NodeJS.ProcessEnv {
  const base = minimal
    ? Object.fromEntries(
        MINIMAL_ENVIRONMENT.flatMap((name) =>
          process.env[name] === undefined ? [] : [[name, process.env[name]]]
        )
      )
    : { ...process.env }
  return { ...base, PATH: searchPath().join(delimiter) }
}

/** Whether `name` is a bare command name rather than a path or something a shell would expand. */
export function isCommandName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)
}

function searchPath(): string[] {
  const onPath = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')
  // Windows GUI processes do inherit the user's PATH.
  return process.platform === 'win32' ? onPath : [...new Set([...onPath, ...FALLBACK_DIRECTORIES])]
}

/** The executable a command name runs, or undefined when there is none to be found. */
export function findCommand(name: string): string | undefined {
  if (!isCommandName(name)) return undefined
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  for (const directory of searchPath()) {
    for (const candidate of names.map((file) => join(directory, file))) {
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here, or not ours to run. Keep looking.
      }
    }
  }
  return undefined
}

/** A failure to run at all, with the `code` Node would give it. */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: 'ENOENT' | 'ETIMEDOUT' | 'E2BIG' | 'EINVAL'
  ) {
    super(message)
  }
}

/**
 * Runs `name` with `args` and resolves with how it ended. A non-zero exit is an
 * answer, not a failure; not finding it, a timeout, and output past the limit
 * are failures.
 */
export function runCommand(
  name: string,
  args: readonly string[],
  options: ProcessOptions = {},
  /** For an installed extension: only the environment `MINIMAL_ENVIRONMENT` names. */
  { minimalEnvironment = false }: { minimalEnvironment?: boolean } = {}
): Promise<ProcessResult> {
  if (!isCommandName(name)) {
    return Promise.reject(new CommandError(`${name} is not a command name.`, 'EINVAL'))
  }
  if (!args.every((arg) => typeof arg === 'string')) {
    return Promise.reject(new CommandError('Every argument has to be a string.', 'EINVAL'))
  }
  const binary = findCommand(name)
  if (!binary) return Promise.reject(new CommandError(`${name} is not installed.`, 'ENOENT'))

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd ?? homedir(),
      env: environment(minimalEnvironment),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let failure: Error | null = null
    const fail = (error: Error): void => {
      if (failure) return
      failure = error
      child.kill('SIGKILL')
    }
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        fail(new CommandError(`${name} wrote more output than can be kept.`, 'E2BIG'))
        return
      }
      into.push(chunk)
    }
    child.stdout.on('data', collect(out))
    child.stderr.on('data', collect(err))

    const timer = setTimeout(
      () => fail(new CommandError(`${name} did not finish within ${timeoutMs} ms.`, 'ETIMEDOUT')),
      timeoutMs
    )

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(failure ?? error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure) return reject(failure)
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8')
      })
    })

    child.stdin.on('error', () => {
      // A command that exits without reading its input closes the pipe first.
    })
    child.stdin.end(options.input ?? '')
  })
}
