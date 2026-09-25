import { mount } from 'svelte'

import './assets/main.css'

import SettingsApp from './SettingsApp.svelte'

// The settings window's own entry point. It shares the preload, and so the same
// `window.api`, with the main window; it shares no state with it.
const app = mount(SettingsApp, {
  target: document.getElementById('settings')!
})

export default app
