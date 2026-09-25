import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Client } from '@fluid/sdk'
import { VSCODE_TAB } from '../shared/tab'
import { context } from './context'

/**
 * Where the tabs' workspace files are kept, one directory per tab.
 *
 * These exist because of what the editor treats as a window's identity. It
 * keeps each window's state — which files are open, the editor layout, the
 * expanded folders, the search history — in browser storage under a key derived
 * from the *workspace* the window was opened on, and a folder is a workspace.
 * So two tabs opened on the same folder are, as far as the editor can tell, one
 * window opened twice: they share the one record, overwrite each other's as
 * they go, and on the next launch both restore whatever the last one to write
 * happened to leave there. Which is the whole of the bug this answers.
 *
 * A tab therefore gets a workspace of its own. A `.code-workspace` file naming
 * the single folder the tab was opened on is a workspace in its own right, with
 * its own identity and so its own stored state, while still being the same
 * folder underneath: the files, the git repository and the terminal's directory
 * are all the real ones, and only the editor's bookkeeping differs.
 *
 * It is deliberately the *tab* these are keyed on and not the task. A tab is
 * what the user arranged — this file open, that one pinned, the explorer
 * scrolled here — so a tab is what should get it back.
 *
 * What this costs, and it is worth being plain about it: the editor knows it
 * has been given a workspace rather than a bare folder, and says so. The title
 * bar reads `nac (Workspace)`, and the explorer hangs the folder under a root
 * of its own instead of listing it at the top level. Both are cosmetic, and
 * both are the price of two tabs on one project being two windows.
 */
function workspacesDir(): string {
  return join(context().dataDir, 'workspaces')
}

/**
 * A tab's workspace file.
 *
 * Named after the folder rather than the tab, because the name is what the
 * editor shows: it titles the window with the workspace file's name and offers
 * it back under that name in Recent. The tab's id is the directory instead,
 * where nothing displays it. `folder` covers the folder with no name to take —
 * only the filesystem root has none, and it is a strange thing to open, but a
 * path ending in `/.code-workspace` would be stranger.
 */
function workspaceFileFor(tabId: string, folderPath: string): string {
  return join(workspacesDir(), tabId, `${basename(folderPath) || 'folder'}.code-workspace`)
}

/**
 * The id as a directory name, or nothing.
 *
 * The id is joined into a path, which is the shape a path traversal takes; ids
 * are generated as UUIDs, so anything that is not one is either a bug or an
 * attempt, and neither deserves a directory.
 */
function safeTabId(tabId: string): string | null {
  return /^[A-Za-z0-9-]{1,64}$/.test(tabId) ? tabId : null
}

/**
 * The colours a stylesheet cannot take out of the workbench.
 *
 * Nearly all of the editor is HTML, and everything painted as HTML is dealt
 * with where the rest of the transparency is — a stylesheet put into the view
 * (see ./glass.ts). These two are the
 * exceptions, and they are exceptions for the same reason: the minimap and the
 * terminal are drawn into a `<canvas>`, from colours the editor reads out of
 * the theme in script and paints as pixels. There is no element to restyle and
 * no variable to empty. The only way to change what is drawn is to change the
 * colour it is drawn from, which is what this does.
 *
 * `#00000000` rather than a named colour, because it is the alpha that matters
 * and VS Code's colours are hex with an optional alpha pair.
 */
const TRANSPARENT_COLORS = {
  'minimap.background': '#00000000',
  'terminal.background': '#00000000'
} as const

/**
 * The workspace file with those colours in it, as an edit rather than a
 * replacement.
 *
 * `workbench.colorCustomizations` reaches the editor from here because it is a
 * window-scoped setting, so a workspace may set it — the same way a project
 * sets its own window colour in `.vscode/settings.json`. It is worth doing it
 * here rather than in the user's own settings for the reason nothing else in
 * this module touches those: the user's settings are Settings Sync's, shared
 * with the VS Code they run outside this app, and a transparent editor is a
 * fact about this window rather than about their editor everywhere.
 *
 * Only the two keys are written, and everything else in the file is left as it
 * was found. That matters because the file stops being ours after the first
 * launch — the editor writes here when a folder is added to the workspace or
 * the workspace is given settings of its own — so this reads what is there,
 * changes the two colours, and puts the rest back untouched.
 */
function withTransparentColors(contents: Record<string, unknown>): Record<string, unknown> {
  const settings = { ...((contents.settings as Record<string, unknown> | undefined) ?? {}) }
  const colors = {
    ...((settings['workbench.colorCustomizations'] as Record<string, unknown> | undefined) ?? {}),
    ...TRANSPARENT_COLORS
  }
  return { ...contents, settings: { ...settings, 'workbench.colorCustomizations': colors } }
}

/**
 * Writes the tab's workspace file, creating it on the first open and otherwise
 * only putting the colours above back into the one that is there.
 *
 * The file is the editor's after the first launch, so the rewrite is confined
 * to the two keys and skipped entirely when the file cannot be read as JSON —
 * which is what a file the user has since put comments in looks like, and
 * replacing that with a generated one would be throwing away their edit to fix
 * a colour.
 */
export async function ensureWorkspaceFile(tabId: string, folderPath: string): Promise<string> {
  const id = safeTabId(tabId)
  if (!id) throw new Error('That tab cannot be opened in the editor.')
  const file = workspaceFileFor(id, folderPath)

  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true })
    const contents = withTransparentColors({ folders: [{ path: folderPath }] })
    await writeFile(file, `${JSON.stringify(contents, null, 2)}\n`, 'utf8')
    return file
  }

  let existing: Record<string, unknown>
  try {
    existing = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    // Unreadable, or no longer plain JSON. Left exactly as it is: the tab still
    // opens on it, and the editor is the better judge of a file it wrote.
    return file
  }

  const updated = withTransparentColors(existing)
  const next = `${JSON.stringify(updated, null, 2)}\n`
  // Only when it would actually differ, so an unchanged workspace is not
  // rewritten — and its modified time not moved — on every open.
  if (next !== `${JSON.stringify(existing, null, 2)}\n`) {
    await writeFile(file, next, 'utf8')
  }
  return file
}

/** Every editor tab there is, across every task of every project, open or settled. */
async function liveTabIds(api: Client): Promise<Set<string>> {
  const live = new Set<string>()
  for (const project of await api.projects.list({})) {
    for (const task of await api.tasks.list({ projectId: project.id })) {
      for (const tab of await api.tabs.list({ taskId: task.id })) {
        if (tab.type === VSCODE_TAB) live.add(tab.id)
      }
    }
  }
  return live
}

/**
 * Throws away the workspaces of tabs that no longer exist.
 *
 * Called once as the extension starts, as well as for each tab that closes
 * (see `discardWorkspace`), because a tab has more ways to go than being closed
 * — its task can be deleted, or the app killed between the two — and sweeping
 * the directory against the tabs that remain catches whatever no hook on a
 * close could.
 *
 * Note what this does not reclaim: the editor's own stored state for those
 * workspaces stays in the browser profile, because it lives in the workbench's
 * storage rather than on disk here and only a page on that origin can delete
 * it. It is a few hundred kilobytes per closed tab, and nothing reads it again.
 */
export async function pruneWorkspaces(api: Client): Promise<void> {
  let live: Set<string>
  try {
    live = await liveTabIds(api)
  } catch {
    // Deleting on a guess is the one outcome worth avoiding here: every
    // directory removed is a tab's editor state removed with it. An unreadable
    // tab list is a reason to sweep nothing.
    return
  }
  let entries: string[]
  try {
    entries = await readdir(workspacesDir())
  } catch {
    // No directory yet, which is every launch before the first editor tab.
    return
  }
  await Promise.all(
    entries
      .filter((entry) => !live.has(entry))
      .map((entry) => rm(join(workspacesDir(), entry), { recursive: true, force: true }))
  )
}

/**
 * Throws away one tab's workspace, once the tab has gone for good. Its editor
 * state stays behind in the browser profile, for the reason `pruneWorkspaces`
 * gives.
 */
export async function discardWorkspace(tabId: string): Promise<void> {
  const id = safeTabId(tabId)
  if (id) await rm(join(workspacesDir(), id), { recursive: true, force: true })
}
