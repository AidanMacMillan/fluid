import type { Session } from 'electron'

type Policy = (
  details: Electron.OnHeadersReceivedListenerDetails
) => Electron.HeadersReceivedResponse

const policies = new WeakMap<Session, Map<string, Policy>>()

/** Electron keeps one listener per event. Compose header policies without replacing CSP. */
export function setResponsePolicy(target: Session, name: string, policy: Policy): void {
  let handlers = policies.get(target)
  if (!handlers) {
    handlers = new Map()
    policies.set(target, handlers)
    const registered = handlers
    target.webRequest.onHeadersReceived((details, callback) => {
      let response: Electron.HeadersReceivedResponse = {}
      for (const handler of registered.values()) {
        const next = handler({
          ...details,
          responseHeaders: response.responseHeaders
            ? Object.fromEntries(
                Object.entries(response.responseHeaders).map(([key, value]) => [
                  key,
                  Array.isArray(value) ? value : [value]
                ])
              )
            : details.responseHeaders
        })
        response = { ...response, ...next }
        if (response.cancel) break
      }
      callback(response)
    })
  }
  handlers.set(name, policy)
}
