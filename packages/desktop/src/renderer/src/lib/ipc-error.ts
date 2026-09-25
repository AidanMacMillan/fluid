/**
 * What the main process actually said, for panels that show a failure.
 *
 * A rejected `invoke` does not arrive as the error that was thrown: Electron
 * re-raises it here wrapped in its own framing — the channel name, and a
 * doubled `Error:` — and none of that is the user's business. Every panel that
 * puts one of these on screen wants the same sentence out of it.
 */
export function reasonFrom(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}
