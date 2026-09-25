import { defineViews } from '@fluid/sdk'
import { mount } from 'svelte'
import ImageView from './ImageView.svelte'

/**
 * The image extension's view: a picture, drawn in a page of its own.
 *
 * Handed its tab once, which is all it needs: a file tab's payload is what the
 * file is and does not change under it, and its view state is this view's to
 * write rather than to follow.
 */
export default defineViews({
  id: 'image',

  files: {
    image: {
      mount: (target, { tab, host }) => {
        if (tab.type !== 'file') return
        mount(ImageView, { target, props: { tab, host } })
      }
    }
  }
})
