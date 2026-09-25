import { defineViews } from '@fluid/sdk'
import { mount } from 'svelte'
import VideoView from './VideoView.svelte'

/** The video extension's view: a player, in a page of its own. */
export default defineViews({
  id: 'video',

  files: {
    video: {
      mount: (target, { tab }) => {
        if (tab.type !== 'file') return
        mount(VideoView, { target, props: { tab } })
      }
    }
  }
})
