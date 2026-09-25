import { mount } from 'svelte'

import './assets/main.css'

import IconPickerApp from './IconPickerApp.svelte'
import LauncherApp from './LauncherApp.svelte'

// The launcher panel's own entry point. Like the settings window it shares the
// preload, and so the same `window.api`, with the main window; it holds no
// workspace state of its own — the address it settles on goes back across the
// bridge, and the window that asked for it does the opening.
//
// The icon picker is the same panel asking a different kind of question, and a
// different component draws it (see `LauncherMode`).
const mode = new URLSearchParams(location.search).get('mode')
const app = mount(mode === 'icon' ? IconPickerApp : LauncherApp, {
  target: document.getElementById('launcher')!
})

export default app
