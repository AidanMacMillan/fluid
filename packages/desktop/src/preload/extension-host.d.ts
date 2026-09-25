import type { ExtensionHostBridge } from '../main/extensions/isolation/protocol'

declare global {
  interface Window {
    /** Only in an installed extension's host page: see src/preload/extension-host.ts. */
    fluidHost: ExtensionHostBridge
  }
}
