import { mount } from 'svelte'

import './assets/main.css'

import ProjectApp from './ProjectApp.svelte'

// The project picker's own entry point. Like the launcher it shares the
// preload, and so the same `window.api`, with the main window, and holds no
// workspace state of its own — what it settles on goes back across the bridge,
// and the window that asked for it redraws its strip.
const app = mount(ProjectApp, {
  target: document.getElementById('project')!
})

export default app
