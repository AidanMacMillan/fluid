import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { MAX_VISUALIZATION_BYTES, parseVisualization } from '../shared/visualizations'
import { visualizationDocument, VISUALIZATION_CSP } from './visualization-document'
import type { SchemeDeclaration } from '@fluid/sdk'

type VisualizationStore = {
  declaration: SchemeDeclaration
  load: (tabId: string, path: string, roots: string[]) => Promise<string>
  serve: (request: Request) => Response
  release: (tabId: string) => void
  clear: () => void
}

/** Resolve symlinks before authorizing; bound reads even if a file grows after stat. */
export async function readVisualization(path: string, roots: string[]): Promise<string> {
  if (!parseVisualization({ path })) throw new Error('Expected an absolute HTML file path.')
  const actual = await realpath(path)
  const allowed = await Promise.all(
    roots.map(async (root) => {
      try {
        const inside = relative(await realpath(root), actual)
        return (
          inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
        )
      } catch {
        return false
      }
    })
  )
  if (!allowed.some(Boolean)) throw new Error('Visualization must be inside the session folder.')
  const file = await open(actual, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_VISUALIZATION_BYTES)
      throw new Error('Visualization must be an HTML file under 1 MB.')
    const buffer = Buffer.alloc(MAX_VISUALIZATION_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_VISUALIZATION_BYTES) throw new Error('Visualization must be under 1 MB.')
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    await file.close()
  }
}

/** URLs carry random capabilities, never filesystem paths. No general file server. */
export function createVisualizationStore(scheme: string): VisualizationStore {
  const pages = new Map<string, { tabId: string; path: string; document: string }>()
  return {
    declaration: { scheme, privileges: { standard: true, secure: true } },
    async load(tabId: string, path: string, roots: string[]): Promise<string> {
      const html = await readVisualization(path, roots)
      const key = randomUUID()
      pages.set(key, { tabId, path, document: visualizationDocument(html) })
      // Bound retained HTML; evicted references can be reloaded from their file.
      while (pages.size > 64) pages.delete(pages.keys().next().value!)
      return `${scheme}://preview/${key}`
    },
    serve(request: Request): Response {
      const url = new URL(request.url)
      const page =
        url.protocol === `${scheme}:` && url.host === 'preview' && !url.search
          ? pages.get(url.pathname.slice(1))
          : undefined
      if (!page || request.method !== 'GET') return new Response(null, { status: 404 })
      return new Response(page.document, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': VISUALIZATION_CSP,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }
      })
    },
    release(tabId: string): void {
      for (const [key, page] of pages) if (page.tabId === tabId) pages.delete(key)
    },
    clear(): void {
      pages.clear()
    }
  }
}
