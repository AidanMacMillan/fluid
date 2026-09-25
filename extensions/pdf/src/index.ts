import { defineExtension } from '@fluid/sdk'

/**
 * PDFs, as an extension: shown in the viewer Chromium ships, with its toolbar,
 * page thumbnails, find, print, text selection and accessibility.
 *
 * The rendering is Chromium's, in a view the app holds to the file. The
 * session has to be a persisted one — the viewer is a built-in extension that
 * only exists in those — and all it keeps there is the viewer's zoom. A PDF's
 * width was decided when it was made, so it gets the whole pane and no widths
 * to choose from.
 */
export default defineExtension({
  id: 'pdf',
  name: 'PDF',
  description: "PDFs in file tabs, in Chromium's own viewer.",

  activate(ctx) {
    ctx.fileViewers.register({
      id: 'document',
      label: 'PDF documents',
      mimeTypes: ['application/pdf'],
      view: { kind: 'native', session: 'persisted' }
    })
  }
})
