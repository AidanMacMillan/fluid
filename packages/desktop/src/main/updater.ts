import { app, dialog, Menu } from 'electron'
import { autoUpdater } from 'electron-updater'

const CHECK_INTERVAL = 6 * 60 * 60 * 1000
export const UPDATE_MENU_ID = 'check-for-updates'

let initialized = false
let busy = false
let downloadedVersion: string | undefined
let showingPrompt = false

function updateMenu(label: string, enabled = true): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(UPDATE_MENU_ID)
  if (item) {
    item.label = label
    item.enabled = enabled
  }
}

async function offerRestart(): Promise<void> {
  if (showingPrompt) return
  const version = downloadedVersion
  showingPrompt = true
  try {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `Fluid ${downloadedVersion} is ready to install`,
      detail:
        'Restart to install the update, or keep working and it will install when you quit Fluid.',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 1,
      cancelId: 1
    })
    // Squirrel waits for this process to exit. The existing will-quit handler
    // flushes the database before exiting, including on an updater restart.
    if (response === 0 && version === downloadedVersion) autoUpdater.quitAndInstall()
  } finally {
    showingPrompt = false
  }
}

export async function checkForUpdates(manual = true): Promise<void> {
  if (!initialized || busy) return
  if (downloadedVersion) {
    if (manual) await offerRestart()
    return
  }

  busy = true
  updateMenu('Checking for Updates…', false)
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result?.isUpdateAvailable) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          message: 'Fluid is up to date',
          detail: `You’re running Fluid ${app.getVersion()}.`
        })
      }
      return
    }
    updateMenu('Downloading Update…', false)
    await autoUpdater.downloadUpdate()
  } catch (error) {
    downloadedVersion = undefined
    console.error('Update check or download failed:', error)
    if (manual) {
      await dialog.showMessageBox({
        type: 'error',
        message: 'Could not update Fluid',
        detail: 'Check your internet connection and try again later.'
      })
    }
  } finally {
    busy = false
    updateMenu(downloadedVersion ? 'Restart to Install Update…' : 'Check for Updates…')
  }
}

/** Only the distributed Mac app checks the public GitHub release feed. */
export function registerAutoUpdater(): void {
  if (initialized || !app.isPackaged || process.platform !== 'darwin') return
  initialized = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  // Native Squirrel errors can arrive after the download promise settles.
  autoUpdater.on('error', (error) => {
    downloadedVersion = undefined
    updateMenu('Check for Updates…')
    console.error('Auto-updater error:', error)
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version
    updateMenu('Restart to Install Update…')
    void offerRestart().catch((error) => console.error('Update prompt failed:', error))
  })

  // Let the first window appear before doing any network work.
  const startup = setTimeout(() => void checkForUpdates(false), 15_000)
  const interval = setInterval(() => void checkForUpdates(false), CHECK_INTERVAL)
  startup.unref()
  interval.unref()
  app.once('before-quit', () => {
    clearTimeout(startup)
    clearInterval(interval)
  })
}
