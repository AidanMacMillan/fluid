import { fileURLToPath, pathToFileURL } from 'node:url'
import { ClipboardItem } from 'electron'

/**
 * Files on the clipboard: the copy Finder or Explorer makes of the files
 * themselves, which a paste into another file manager turns back into files.
 *
 * Electron reads and writes the platform's native file-list format under this
 * one MIME type, as an RFC 2483 list of `file://` URIs. The helpers here are
 * the whole of what the app does with it, shared by the three places that touch
 * it: capturing a copy, putting one back, and the file bar's own Copy.
 */
export const FILE_LIST = 'text/uri-list'

/** The absolute paths in a URI list. Anything that is not a `file://` URI is skipped. */
export function pathsFromFileList(list: string): string[] {
  return list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('file:'))
    .flatMap((uri) => {
      try {
        return [fileURLToPath(uri)]
      } catch {
        return []
      }
    })
}

/**
 * A clipboard item that pastes as these files into a file manager, and as their
 * paths into anything that only takes text — a terminal, an editor, a field.
 * The text is the paths rather than the bare names Finder offers, because a
 * path is what somebody pasting a file into text is after.
 */
export function fileListItem(paths: string[]): ClipboardItem {
  return new ClipboardItem({
    [FILE_LIST]: paths.map((path) => pathToFileURL(path).href).join('\r\n'),
    'text/plain': paths.join('\n')
  })
}
