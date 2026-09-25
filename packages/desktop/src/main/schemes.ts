import { protocol } from 'electron'
import { FILE_SCHEME_PRIVILEGES } from './files'
import { extensionSchemes } from './extensions/host'
import { INSTALLED_SCHEME_PRIVILEGES } from './extensions/installed'

/**
 * Every scheme of the app's own, declared in one place.
 *
 * It is one place because Electron allows exactly one call to
 * `registerSchemesAsPrivileged` per process: a second one does not add to the
 * first, and the failure is silent and bewildering — the scheme registered last
 * works and the other one starts refusing every request with nothing in the
 * console to say why.
 *
 * So each module that serves a scheme exports what it needs granted — the file
 * store here, the folders installed extensions' views load their code from,
 * and extensions by declaring theirs (see `Extension.schemes`) — and this is
 * the only caller.
 */
export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    FILE_SCHEME_PRIVILEGES,
    INSTALLED_SCHEME_PRIVILEGES,
    ...extensionSchemes()
  ])
}
