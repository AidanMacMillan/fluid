import { mkdirSync } from 'node:fs'
import { is } from '@electron-toolkit/utils'
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { ExtensionInfo, ExtensionManifest } from '@fluid/sdk'
import { chooseDirectory } from './directories'
import { approvalsPersist } from './extensions/approvals'
import {
  approveExtension,
  installedFolder,
  installExtension,
  listExtensions,
  planApproval,
  planInstall,
  uninstallExtension
} from './extensions/host'
import { installedExtensionsDir, permissionsOf } from './extensions/installed'
import { holdSettingsWindow, isSettingsWindow } from './settings-window'

/**
 * Installing, removing and finding installed extensions, for the settings
 * panel's Extensions section.
 *
 * Not part of the workspace API, which extensions and agents can call too:
 * installing or approving an extension is agreeing to run its code, so only
 * the user, in the panel, can do it — and the panel asks them first, with the
 * extension's id, where it came from and everything it will be allowed to do
 * in front of them. What they are asked about is the snapshot that will run
 * (see `Snapshot` in extensions/installed.ts), not the folder as it may be a
 * moment later.
 *
 * Every sheet here is put up on the panel, which is held open while it is (see
 * `holdSettingsWindow`): a sheet takes key status from the panel, and the blur
 * that gives would otherwise close it.
 *
 * @module installed-extensions-ipc
 */

/** What installing or approving came to. */
export type InstallResult = { installed: ExtensionInfo } | { cancelled: true }

/**
 * The settings panel, if it is what sent this: its own page, and not an
 * extension's section laid over it, which is in the same window.
 */
function panelOf(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || !isSettingsWindow(window) || window.webContents !== event.sender) {
    throw new Error('Only the settings panel can install extensions.')
  }
  return window
}

/** Everything the user is agreeing to, one line each, for the sheet that asks them. */
function consequences(manifest: ExtensionManifest, source: string): string {
  const { hosts, commands, extensions } = permissionsOf(manifest)
  const names = new Map(listExtensions().map((info) => [info.id, info.name]))
  const abilities = [
    'Read and change your tasks, tabs, notes and bookmarks',
    ...hosts.map((host) => `Connect to ${host}`),
    ...commands.map((command) => `Run ${command} on your computer`),
    ...extensions.map((id) => `Use the ${names.get(id) ?? id} extension`)
  ]
  return [
    `${manifest.name} ${manifest.version} (${manifest.id})`,
    `From ${source}`,
    '',
    'It will be able to:',
    ...abilities.map((line) => `• ${line}`),
    '',
    ...(commands.length > 0
      ? [
          'A command runs as you, so it can do anything that command can — including run other programs.',
          ''
        ]
      : []),
    'Only install extensions you trust.',
    ...(approvalsPersist()
      ? []
      : ['This computer cannot store approvals securely, so you will be asked again next time.'])
  ].join('\n')
}

async function held<T>(run: () => Promise<T>): Promise<T> {
  const release = holdSettingsWindow()
  try {
    return await run()
  } finally {
    release()
  }
}

export function registerInstalledExtensionsIpc(): void {
  ipcMain.handle('installedExtensions:install', (event): Promise<InstallResult> => {
    const panel = panelOf(event)
    return held(async () => {
      const folder = await chooseDirectory(panel, {
        title: 'Install an extension',
        buttonLabel: 'Install'
      })
      if (!folder) return { cancelled: true }

      const plan = planInstall(folder)
      const { candidate, replaces } = plan
      const { name, version } = candidate.manifest
      const { response } = await dialog.showMessageBox(panel, {
        type: 'warning',
        message: replaces
          ? `Replace ${replaces.name}${replaces.version ? ` ${replaces.version}` : ''} with ${version}?`
          : `Install ${name} ${version}?`,
        detail: consequences(candidate.manifest, candidate.source),
        buttons: [replaces ? 'Replace' : 'Install', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      if (response !== 0) return { cancelled: true }

      return { installed: await installExtension(plan) }
    })
  })

  ipcMain.handle('installedExtensions:approve', (event, id: unknown): Promise<InstallResult> => {
    const panel = panelOf(event)
    if (typeof id !== 'string') throw new Error('Expected an extension id.')
    return held(async () => {
      const plan = planApproval(id)
      const { manifest, dir } = plan.installed
      const { response } = await dialog.showMessageBox(panel, {
        type: 'warning',
        message:
          plan.reason === 'changed'
            ? `${manifest.name}'s files have changed since you approved it. Run it anyway?`
            : `${manifest.name} was added to the app's data folder, not installed through the app. Run it?`,
        detail: consequences(manifest, dir),
        buttons: ['Approve', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      })
      if (response !== 0) return { cancelled: true }
      return { installed: await approveExtension(plan) }
    })
  })

  ipcMain.handle('installedExtensions:remove', (event, id: unknown): Promise<boolean> => {
    const panel = panelOf(event)
    if (typeof id !== 'string') throw new Error('Expected an extension id.')
    const extension = listExtensions().find((info) => info.id === id)
    if (!extension) throw new Error(`No extension ${id} is installed.`)
    return held(async () => {
      const { response } = await dialog.showMessageBox(panel, {
        type: 'question',
        message: `Remove ${extension.name}?`,
        detail:
          'Its settings, saved sign-ins and everything else it stored are deleted with it. Tasks and tabs it made stay.',
        buttons: ['Remove', 'Cancel'],
        defaultId: 0,
        cancelId: 1
      })
      if (response !== 0) return false
      await uninstallExtension(id)
      return true
    })
  })

  ipcMain.handle('installedExtensions:reveal', (event, id: unknown) => {
    panelOf(event)
    if (typeof id !== 'string') throw new Error('Expected an extension id.')
    shell.showItemInFolder(installedFolder(id))
  })

  ipcMain.handle('installedExtensions:openFolder', async (event) => {
    panelOf(event)
    const dir = installedExtensionsDir()
    mkdirSync(dir, { recursive: true })
    const failure = await shell.openPath(dir)
    if (failure) throw new Error(failure)
  })

  // A relaunch starts the app again from its own files, which while developing
  // are the dev server's: that server goes with the process that started it,
  // so there the answer is to restart it by hand.
  ipcMain.handle('installedExtensions:relaunch', (event): boolean => {
    panelOf(event)
    if (is.dev) return false
    app.relaunch()
    app.quit()
    return true
  })
}
