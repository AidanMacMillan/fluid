import { mount } from 'svelte'

import './assets/main.css'

import FindApp from './FindApp.svelte'

// The find bar's own entry point. Like the launcher it shares the preload, and
// so the same `window.api`, with the main window — but it is a view rather than
// a window, composited over the page it searches (see src/main/find-bar.ts).
//
// It holds no state but what is in its field: the query lives in main, because
// the page being searched does too.
const app = mount(FindApp, {
  target: document.getElementById('find')!
})

export default app
