import { mount } from 'svelte'

import './assets/main.css'

import App from './App.svelte'

// Which OS's window controls the title bar has to clear (see
// `titlebar-safe-area` in main.css).
document.documentElement.dataset.platform = window.electron.process.platform

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
