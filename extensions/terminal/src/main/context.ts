import type { ExtensionContext } from '@fluid/sdk'

/**
 * The context the app handed the extension when it activated.
 *
 * Held module-wide because the sessions are module-wide. Set once in
 * `activate` and cleared when the extension is disposed, so a module that
 * reaches for it while the extension is off fails loudly rather than acting on
 * a stale one.
 */
let current: ExtensionContext | null = null

export function setContext(ctx: ExtensionContext | null): void {
  current = ctx
}

export function context(): ExtensionContext {
  if (!current) throw new Error('The terminal extension is not active.')
  return current
}
