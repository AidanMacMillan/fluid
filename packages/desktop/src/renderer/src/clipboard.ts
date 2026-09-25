import { mount } from 'svelte'

import './assets/main.css'

import ClipboardApp from './ClipboardApp.svelte'

// The clipboard panel's own entry point. Like the launcher it shares the
// preload, and so the same `window.api`, with the main window; it holds no
// workspace state of its own, and asks main which task it is showing rather
// than being told by the window it opened over.
const app = mount(ClipboardApp, {
  target: document.getElementById('clipboard')!
})

export default app
