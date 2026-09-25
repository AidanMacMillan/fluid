import { defineExtension } from '@fluid/sdk'

/**
 * Pictures, as an extension: every image file tab, drawn by a viewer that can
 * be zoomed into and panned around.
 *
 * All there is to the main half is the claim. The viewer is a page of the
 * extension's own (see ./views), which loads the picture from the app's file
 * store and keeps where it was left in the tab's view state.
 */
export default defineExtension({
  id: 'image',
  name: 'Images',
  description: 'Pictures in file tabs, to zoom into and pan around.',

  activate(ctx) {
    ctx.fileViewers.register({
      id: 'image',
      label: 'Images',
      // Every image the store names a type for — PNG, JPEG, GIF, WebP, AVIF,
      // SVG, BMP, ICO and APNG today — and anything it comes to name later: an
      // `img` draws whatever Chromium can decode.
      mimeTypes: ['image/*'],
      view: { kind: 'page' }
    })
  }
})
