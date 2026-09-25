import { z } from 'zod'
import { defineExtension } from '@fluid/sdk'
import { setContext } from './main/context'
import { WORKBENCH_GLASS } from './main/glass'
import { destroyVscodeServer, editorUrl } from './main/server'
import { discardWorkspace, pruneWorkspaces } from './main/workspaces'
import { isVscodeTab } from './shared/tab'

/**
 * VS Code, as an extension: a folder open in the user's own editor, as a tab.
 *
 * The main half is here and in ./main — the server that serves the workbench,
 * which is a process of the user's own VS Code install, and the workspace file
 * each tab opens on. The tab itself is a web view pointed at that server,
 * which the app draws; its row and launcher entry are in ./renderer.
 */

/** What an editor tab's payload has to be, whoever opens one. */
const payload = z.object({
  folderPath: z.string().min(1).describe('Absolute path of the folder to open.')
})

export default defineExtension({
  id: 'vscode',
  name: 'VS Code',
  description:
    'Folders open in your own VS Code, as tabs: the real editor, with your extensions and settings synced in.',

  activate(ctx) {
    setContext(ctx)
    // Disabling the extension, or quitting: the server goes, for the reason
    // given on `destroyVscodeServer` — it is a child of the app's process, not
    // of the tabs that used it.
    ctx.onDispose(() => {
      destroyVscodeServer()
      setContext(null)
    })

    ctx.tabTypes.register({
      id: 'editor',
      label: 'VS Code',
      payload,
      agentDescription:
        "A folder open in the user's own VS Code, for them to edit in: the real editor, with their extensions and settings.",
      view: {
        kind: 'web',
        url: (tab) => {
          if (!isVscodeTab(tab)) throw new Error('Not an editor tab.')
          return editorUrl(tab)
        },
        // Find, Save, Reload and the rest are the editor's, and the user's
        // hands know them as the editor's.
        keys: 'all',
        // Made glass, and so drawn with nothing behind it but the app's own
        // (see ./main/glass.ts).
        stylesheet: WORKBENCH_GLASS,
        transparent: true
      },
      onClose: (tab) => void discardWorkspace(tab.id)
    })

    // What no close could clear up: tabs whose task was deleted, or which went
    // while the app was not running. Nothing waits on it.
    void pruneWorkspaces(ctx.api)
  }
})
