import { defineExtension } from '@fluid/sdk'

/**
 * HTML files, as an extension: an email or a page a designer sent over,
 * rendered as a browser would render it and read at whatever width you
 * choose, from the window's down to a phone's.
 *
 * The rendering is Chromium's, in a view the app holds to the file: HTML is a
 * format only a browser engine can honestly draw, and a document drawn inside
 * a page of this extension's would run its script beside the extension's
 * bridge. So this asks for the file to be rendered natively, in a session kept
 * in memory — a document is script the app did not write, and it gets an empty
 * cookie jar that is gone when the app quits.
 */
export default defineExtension({
  id: 'html',
  name: 'HTML',
  description:
    'HTML files in file tabs, rendered as a browser would and read at the width you choose.',

  activate(ctx) {
    ctx.fileViewers.register({
      id: 'document',
      label: 'HTML documents',
      mimeTypes: ['text/html'],
      view: { kind: 'native', session: 'ephemeral', resizable: true }
    })
  }
})
