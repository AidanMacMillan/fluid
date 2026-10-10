import {
  defineRendererExtension,
  when,
  type LauncherHost,
  type LauncherQuery,
  type NewTab
} from '@fluid/sdk'
import { folderName, isTerminalTab, TERMINAL_TAB, type TerminalTabPayload } from '../shared/tab'
import { COMMAND_THRESHOLD, commandScore } from './commands'

/**
 * The terminal extension's half in the app's windows: how a terminal's row
 * reads, and the launcher rows that open one — at a prompt, or running what
 * was typed. The shell itself is drawn in a
 * view of its own; see ../views.
 */

const ICON = 'icon-[ph--terminal-window]'

/**
 * The names people reach for when they want a shell, including the shells
 * themselves — typing `zsh` should find a terminal rather than search for it.
 */
const KEYWORDS = ['shell', 'console', 'command line', 'cli', 'zsh', 'bash', 'sh', 'fish', 'prompt']

/**
 * How sure the terminal is that what was typed is something to run in it.
 * Never for its own name, though `zsh` is a command: that is somebody looking
 * for a terminal, not asking for a shell inside one.
 */
function runScore(query: LauncherQuery): number {
  return query.lower === 'terminal' || KEYWORDS.includes(query.lower) ? 0 : commandScore(query)
}

export default defineRendererExtension({
  id: 'terminal',

  tabs: {
    shell: {
      icon: ICON,
      // What the shell is running, while it runs — a dev server, a build —
      // and otherwise where it is: both short enough for the row and worth
      // reading, where half a task's terminals would otherwise be `zsh`.
      label: (tab) =>
        isTerminalTab(tab) ? (tab.payload.running ?? folderName(tab.payload.cwd)) : null,
      // The row is only the folder's last segment, and two shells in different
      // checkouts of the same repository would draw two identical rows.
      tooltip: (tab) => {
        if (!isTerminalTab(tab)) return null
        const { running, cwd } = tab.payload
        return running ? `${running} — ${cwd}` : cwd
      }
    }
  },

  launcher: [
    {
      id: 'shell',
      supportsMultiline: false,
      label: 'Terminal',
      icon: ICON,
      keywords: KEYWORDS,
      // Gone once what is typed is a command: the row to take then is the one
      // that runs it, and a bare prompt beside it is the same terminal with
      // the typing thrown away. Found by name the rest of the time.
      relevance: when((query) => runScore(query) >= COMMAND_THRESHOLD, 0),
      // Where it starts is asked for and written down rather than left to be
      // worked out again later: the payload is what a tab restored on the next
      // launch opens with, and "the project's folder" resolved then is not
      // necessarily the same answer as resolved now.
      open: async (host: LauncherHost): Promise<NewTab> => {
        const [cwd, shell] = await Promise.all([
          host.launcher.projectRoot ?? host.api.projects.workingDirectory({}),
          host.call<string>('defaultShell')
        ])
        const payload: TerminalTabPayload = { cwd, shell }
        return { type: TERMINAL_TAB, title: null, payload }
      }
    },
    {
      id: 'run',
      supportsMultiline: false,
      label: 'Run in terminal',
      icon: ICON,
      // Only for a command line. "terminal" is somebody looking for the row
      // above, not a command; "How do I list files?" is a question; and a word
      // the terminal does not know is far more often a search than a program.
      relevance: runScore,
      // Whatever was typed, as a command for a new shell in the same place the
      // row above would start one. A `run` rather than a `command`: it is typed
      // once, and a tab restored after a relaunch should not do it again.
      typed: true,
      open: async (text, host): Promise<NewTab> => {
        const [cwd, shell] = await Promise.all([
          host.launcher.projectRoot ?? host.api.projects.workingDirectory({}),
          host.call<string>('defaultShell')
        ])
        const payload: TerminalTabPayload = { cwd, shell, run: text }
        return { type: TERMINAL_TAB, title: null, payload }
      }
    }
  ]
})
