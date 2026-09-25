import type { WorkspaceEvent } from '@fluid/sdk'

/**
 * Where the API announces what it changed.
 *
 * Every write in src/main/api emits here once it has committed, and everything
 * that reacts to the workspace listens here: the windows (through
 * src/main/api/ipc.ts), the teardown of whatever a closed tab was running
 * (src/main/api/teardown.ts), the project picker, and extensions.
 *
 * Listeners run synchronously and in order, and one that throws does not stop
 * the rest — a subscriber's bug should cost that subscriber, not the write that
 * has already happened.
 */

type Listener = (event: WorkspaceEvent) => void

const listeners = new Set<Listener>()

export function emit(event: WorkspaceEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event)
    } catch (error) {
      console.error(`A listener failed on ${event.type}:`, error)
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
