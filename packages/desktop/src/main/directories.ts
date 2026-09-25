import { homedir } from 'os'
import { statSync, type Stats } from 'fs'
import { isAbsolute, join, resolve, sep } from 'path'
import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'

/**
 * Folders, as the app has to deal with them: checking one is there, making one
 * out of something typed, and asking the OS for one.
 *
 * These began in the app's terminal code, back when the one folder the app had an
 * opinion about was where new terminals started. That preference is now a
 * project's root (see src/main/projects.ts) and the same three questions are
 * asked about it, so they live here rather than in the module that first
 * needed them.
 */

/** Whether there is something at `path` and it is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Nothing there at all: a directory that has been moved or deleted, or one
    // on a volume that is not mounted.
    return false
  }
}

/** A directory that exists, falling back to home for one that has since gone. */
export function usableCwd(cwd: string | null | undefined): string {
  return cwd != null && isDirectory(cwd) ? cwd : homedir()
}

/**
 * A typed path as somewhere a process could actually be started.
 *
 * Throws with what is wrong, which the panel that asked shows as it is.
 */
export function resolveDirectory(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') throw new Error('Enter a directory.')

  const path = expandHome(trimmed)
  // Relative to what? This process's working directory is wherever the app was
  // launched from, which is never the place the user had in mind.
  if (!isAbsolute(path)) throw new Error('Enter the full path to a directory.')

  // `resolve` over `normalize` for the trailing separator: the path is shown
  // back and compared against what is stored, so one spelling per directory is
  // worth having.
  const directory = resolve(path)

  let stats: Stats
  try {
    stats = statSync(directory)
  } catch {
    throw new Error(`There is nothing at ${directory}.`)
  }
  if (!stats.isDirectory()) throw new Error(`${directory} is not a directory.`)
  return directory
}

/**
 * `~` is the shell's, not the filesystem's. Nothing below this expands it, so
 * a path pasted in from somewhere a shell read it would name a directory almost
 * nobody has.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2))
  return path
}

/**
 * The native directory picker, so a folder can be pointed at rather than typed.
 * Returns what was chosen, or null when the user cancelled.
 *
 * Parented to the window that asked, which on macOS makes it a sheet on that
 * window rather than a window of its own to go looking for. Every caller is a
 * panel that is dismissed by looking away, so every caller also has to hold
 * itself open for as long as this is up — a sheet takes key status from the
 * window it is attached to, and that arrives as an ordinary blur.
 */
export async function chooseDirectory(
  parent: BrowserWindow | null,
  options: { title: string; startAt?: string | null; buttonLabel?: string }
): Promise<string | null> {
  const dialogOptions: OpenDialogOptions = {
    title: options.title,
    // Opens at what is already chosen, so adjusting one is a step rather than a
    // search from the top.
    defaultPath: usableCwd(options.startAt),
    buttonLabel: options.buttonLabel ?? 'Choose',
    properties: ['openDirectory', 'createDirectory']
  }

  const result = parent
    ? await dialog.showOpenDialog(parent, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}
