import type { AgentEvent } from '../shared/events'
/** Compact streaming updates in replay without dropping the start of a text block. */
export function appendReplay(replay: AgentEvent[], events: AgentEvent[]): void {
  for (const event of events) {
    if (event.type === 'user.removed') {
      const at = replay.findIndex((e) => e.type === 'user' && e.itemId === event.itemId)
      if (at >= 0) replay.splice(at, 1)
      continue
    }
    if (event.type === 'user.anchor') {
      const at = replay.findIndex((e) => e.type === 'user' && e.itemId === event.itemId)
      const old = replay[at]
      if (old?.type === 'user') {
        replay[at] = { ...old, uuid: event.uuid }
        continue
      }
    }
    if (event.type === 'text.delta' || event.type === 'text.set') {
      const at = replay.findIndex(
        (e) => (e.type === 'text.delta' || e.type === 'text.set') && e.itemId === event.itemId
      )
      const old = replay[at]
      if (at >= 0 && old && (old.type === 'text.delta' || old.type === 'text.set')) {
        replay[at] =
          event.type === 'text.set'
            ? event
            : { ...event, delta: (old.type === 'text.delta' ? old.delta : old.text) + event.delta }
        continue
      }
    }
    if (event.type === 'item.updated' || event.type === 'item.completed') {
      const at = replay.findIndex(
        (e) =>
          (e.type === 'item.started' || e.type === 'item.updated' || e.type === 'item.completed') &&
          e.item.id === event.item.id
      )
      if (at >= 0) {
        replay[at] = event
        continue
      }
    }
    replay.push(event)
  }
}
