import { mount } from 'svelte'

import './assets/main.css'

import PopoutApp from './PopoutApp.svelte'

// The title bar of a tab popped out into a floating window (Cmd+Shift+P). A
// view above the page in that window, sharing the main window's preload the
// way the find bar does (see `createBar` in src/main/miniplayer.ts).
const app = mount(PopoutApp, {
  target: document.getElementById('popout')!
})

export default app
