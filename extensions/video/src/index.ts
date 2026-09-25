import { defineExtension } from '@fluid/sdk'

/**
 * Videos, as an extension: every video file tab, played by a viewer with a
 * transport of its own.
 *
 * All there is to the main half is the claim. The player is a page of the
 * extension's own (see ./views), which streams the file from the app's store.
 */
export default defineExtension({
  id: 'video',
  name: 'Video',
  description: 'Videos in file tabs, with their own transport.',

  activate(ctx) {
    ctx.fileViewers.register({
      id: 'video',
      label: 'Videos',
      // What the store names a type for is what Chromium will play: MP4, M4V,
      // MOV, WebM and Ogg. A container it cannot open is given no type there,
      // and so is never offered to this.
      mimeTypes: ['video/*'],
      view: { kind: 'page' }
    })
  }
})
