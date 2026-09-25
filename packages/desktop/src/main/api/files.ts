import { isAbsolute } from 'node:path'
import type { FileTabPayload } from '@fluid/sdk'
import { importFile } from '../files'
import { ApiError } from './errors'

/**
 * The file store, as the API offers it. Importing changes nothing in the
 * workspace — the copy belongs to nothing until a file tab is opened on it — so
 * it announces nothing either.
 */

export async function importPath(path: string): Promise<FileTabPayload> {
  // Relative would resolve against this process's working directory, which is
  // the app's and never the caller's: it would find the wrong file, not none.
  if (!isAbsolute(path)) throw new ApiError(`${path} is not an absolute path.`)
  return importFile(path)
}
