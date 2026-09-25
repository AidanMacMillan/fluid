import { defineRendererExtension, type NewTab, type RendererHost } from '@fluid/sdk'
import { folderName, isVscodeTab, VSCODE_TAB, type VscodeTabPayload } from '../shared/tab'

/**
 * The VS Code extension's half in the app's windows: how an editor's row reads,
 * what it says while the editor starts, and the launcher row that opens one.
 * The editor itself is a web view the app draws (see ../index.ts).
 */

const ICON = 'icon-[logos--visual-studio-code]'

/**
 * Asks for a folder with the OS picker. A folder and not a file, because that
 * is what an editor window *is* here — the workbench opens on a workspace
 * root, and a single file with no folder around it gets no search, no source
 * control and no language server worth the name.
 */
function chooseFolder(host: RendererHost): Promise<string | null> {
  return host.chooseFolder({ title: 'Choose a folder to open in VS Code', buttonLabel: 'Open' })
}

/**
 * The tab for a folder. The folder is all that is recorded: no address is
 * worked out here, because the address is only true of this run — the port is
 * stable but the connection token is a fact about the server rather than about
 * the tab — and the view asks for it as it is made.
 */
function editorTab(folderPath: string): NewTab {
  const payload: VscodeTabPayload = { folderPath }
  return { type: VSCODE_TAB, title: null, payload }
}

export default defineRendererExtension({
  id: 'vscode',

  tabs: {
    editor: {
      icon: ICON,
      // The folder the editor is open on, by its last segment — the same answer
      // a terminal's row gives, and for the same reason: the repository name is
      // what tells one editor from another, and the path above it never differs.
      label: (tab) => (isVscodeTab(tab) ? folderName(tab.payload.folderPath) : null),
      // The row is only the folder's last segment, and two tasks working the
      // same repository in different checkouts would draw two identical rows.
      tooltip: (tab) => (isVscodeTab(tab) ? tab.payload.folderPath : null),
      starting: {
        message: 'Starting VS Code…',
        // Said only while it is plausibly true. The first run of a given VS
        // Code version downloads the server before it can start one, which is
        // hundreds of megabytes and looks exactly like a hang without this.
        detail: 'The first time, this downloads the editor.'
      }
    }
  },

  launcher: [
    {
      id: 'editor',
      label: 'VS Code',
      icon: ICON,
      // The project's own folder when there is one, the way a new terminal and
      // a new session start there. Without one — which is only before the
      // launcher has heard back, or for a project with no folder — it says
      // nothing, and taking the row opens the folder picker.
      detail: ({ projectRoot }) => (projectRoot ? folderName(projectRoot) : ''),
      // What people call the thing rather than what it is called: nobody opens
      // an editor by searching for `vscode`, they search for `edit` or for the
      // repository they are about to work in. `browse` and `elsewhere` are
      // here because somewhere else is what the row's own menu offers — the
      // row is still the one to find when the folder wanted is not this one.
      keywords: [
        'editor',
        'edit',
        'code',
        'ide',
        'vscode',
        'repo',
        'repository',
        'project',
        'folder',
        'browse',
        'elsewhere'
      ],
      open: async (host) => {
        const folderPath = host.launcher.projectRoot ?? (await chooseFolder(host))
        return folderPath ? editorTab(folderPath) : null
      },
      // Somewhere else is not a second row. It is the same row asked a
      // different way — one row for the editor, rather than one for this
      // project and one for every other, which is the same row twice with one
      // of them worse named.
      alternatives: [
        {
          id: 'elsewhere',
          label: 'Open a folder…',
          open: async (host) => {
            const folderPath = await chooseFolder(host)
            return folderPath ? editorTab(folderPath) : null
          }
        }
      ]
    }
  ]
})
