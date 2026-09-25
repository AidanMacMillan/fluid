import { defineRendererExtension, type LauncherHost, type NewTab } from '@fluid/sdk'
import { folderName, isTerminalTab, TERMINAL_TAB, type TerminalTabPayload } from '../shared/tab'

/**
 * The terminal extension's half in the app's windows: how a terminal's row
 * reads, and the launcher rows that open one — at a prompt, or running what
 * was typed. The shell itself is drawn in a
 * view of its own; see ../views.
 */

const ICON = 'icon-[ph--terminal-window]'

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
      label: 'Terminal',
      icon: ICON,
      // The names people reach for when they want a shell, including the two
      // shells themselves — typing `zsh` should find this rather than search
      // for it.
      keywords: ['shell', 'console', 'command line', 'cli', 'zsh', 'bash', 'prompt'],
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
      label: 'Run in terminal',
      icon: ICON,
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
