let native: typeof import('@fluid/haptics') | null | undefined
let lastPulse = -Infinity

/** Best-effort feedback: unsupported hardware or a missing addon stays silent. */
export function alignmentHaptic(): void {
  if (process.platform !== 'darwin') return
  const now = performance.now()
  if (now - lastPulse < 50) return
  lastPulse = now
  try {
    // Load lazily so a missing native binary cannot prevent the app from starting.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    if (native === undefined) native = require('@fluid/haptics')
    native?.alignment()
  } catch (error) {
    native = null
    console.warn('Trackpad haptics unavailable:', error)
  }
}
