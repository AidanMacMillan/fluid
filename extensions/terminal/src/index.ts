import { z } from 'zod'
import { defineExtension } from '@fluid/sdk'
import { setContext } from './main/context'
import {
  connectView,
  defaultShell,
  destroyAllTerminals,
  destroyTerminal,
  forgetStaleCommands
} from './main/sessions'

/**
 * Terminals, as an extension: a shell in a tab.
 *
 * The main half is here and in ./main — the shells themselves, which are pty
 * processes that outlive the views drawing them. The view that draws a shell
 * is in ./views, in a page of its own, and trades bytes with its shell over
 * the view's connection. The row and the launcher entry are in ./renderer.
 */

/** What a terminal tab's payload has to be, whoever opens one. */
const payload = z.object({
  cwd: z.string().min(1).describe('Absolute path of the directory the shell starts in.'),
  shell: z
    .string()
    .optional()
    .describe("The shell to run. Leave it out for the user's own login shell."),
  command: z
    .string()
    .optional()
    .describe('A command to type into the shell once it starts, as the user would have typed it.'),
  run: z
    .string()
    .optional()
    .describe(
      'A command to type into the shell the first time it starts only, not again when the tab is restored. Taken off the tab once typed.'
    ),
  running: z
    .string()
    .optional()
    .describe('Kept up to date by the terminal itself, from what its shell reports. Leave it out.')
})

export default defineExtension({
  id: 'terminal',
  name: 'Terminal',
  description: 'Shells in tabs, which keep running while you look at something else.',

  activate(ctx) {
    setContext(ctx)
    // Disabling the extension, or quitting: every shell goes, before the
    // context their tabs are closed through does.
    ctx.onDispose(() => {
      destroyAllTerminals()
      setContext(null)
    })

    ctx.tabTypes.register({
      id: 'shell',
      label: 'Terminal',
      payload,
      agentDescription:
        'A shell for the user to work in. It is not a way for an agent to run commands of its own: whatever runs here, the agent does not see.',
      // Drawn in a view of its own (see ./views). It claims no keys: what a
      // shell needs beyond the menu's — Ctrl and Option, arrows, Tab — the menu
      // binds none of, and Cmd+C and Cmd+V reach the page as copy and paste.
      // And it takes the keyboard whenever it is switched to, the way a
      // terminal emulator's window does: a shell is there to be typed into. Its
      // bar is its own, with the folder in it, so the app draws none over it.
      view: { focusOnShow: true, drawsBar: true },
      // What stops is the shell. A settled task's terminal starts a new one in
      // the same directory when it is next shown.
      onStop: (tab) => destroyTerminal(tab.id)
    })

    ctx.views.onConnect('shell', connectView)

    // Where a new terminal's shell is written down from, since the renderer
    // cannot read the environment it would be started in.
    ctx.rpc.handle('defaultShell', () => defaultShell())

    void forgetStaleCommands()
  }
})
