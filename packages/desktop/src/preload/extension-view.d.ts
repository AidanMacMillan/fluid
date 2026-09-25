import type { ExtensionViewBridge } from './extension-view'

declare global {
  interface Window {
    /** Only in an extension's view: see src/preload/extension-view.ts. */
    fluidView: ExtensionViewBridge
  }
}
