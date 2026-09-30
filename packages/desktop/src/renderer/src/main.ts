import { mount } from 'svelte'

import './assets/main.css'

import App from './App.svelte'

// Which OS's window controls the title bar has to clear (see
// `titlebar-safe-area` in main.css).
document.documentElement.dataset.platform = window.electron.process.platform

// Native fullscreen hides the macOS traffic lights. Read the initial state too
// so restoring a fullscreen window or reloading it doesn't leave an empty inset.
function applyFullScreen(fullscreen: boolean): void {
  document.documentElement.dataset.fullscreen = String(fullscreen)
}

const stopFullScreen = window.api.window.onFullScreenChanged(applyFullScreen)
applyFullScreen(window.api.window.isFullScreen())
if (import.meta.hot) import.meta.hot.dispose(stopFullScreen)

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
