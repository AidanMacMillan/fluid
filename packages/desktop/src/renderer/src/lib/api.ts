import { createClient, type WorkspaceEvent } from '@fluid/sdk'

/**
 * The workspace API, for every window of the app.
 *
 * The same typed client an extension gets, over the preload's two channels
 * (see src/preload/index.ts): one to call a method, one that carries every
 * event. One IPC listener for the whole window, fanned out here, so a window
 * with a dozen watches is not a dozen listeners on the same channel.
 */

const listeners = new Set<(event: WorkspaceEvent) => void>()

window.fluid.onEvent((event) => {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      console.error(`A listener failed on ${event.type}:`, error)
    }
  }
})

export const fluid = createClient({
  call: (method, input) => window.fluid.call(method, input),
  subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
})
