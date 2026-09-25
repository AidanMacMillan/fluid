import type { RendererHost } from './renderer'
import type { Tab } from './models'

/**
 * The half of an extension that runs in views of its own.
 *
 * A tab type registered with a `view` (see `TabTypeContribution`) is not drawn
 * in the app's window. Each tab of it gets a page of its own, in a process of
 * its own, and the page draws the extension's `ExtensionView` for that type
 * into itself. The page is the app's: it brings the app's stylesheet and the
 * bridge below, and the extension brings a `mount`.
 *
 * Kept apart from the renderer half because it is loaded apart from it: the
 * app's windows never import it, and a view never imports the renderer half.
 */

/** What a view's page gives the extension, beyond what a window gives it. */
export type ViewHost = RendererHost & {
  /** The tab this view draws. */
  readonly tabId: string
  /** Sends a message to the main half's `ViewConnection` for this view. */
  post(message: unknown): void
  /** Messages from the main half. Returns what stops listening. */
  onMessage(listener: (message: unknown) => void): () => void
  /** Where a dropped or picked `File` is on disk. Empty for one that is not a file on disk. */
  pathForFile(file: File): string
  /**
   * Whether the app is the application in front. A view is focused only while
   * it has the keyboard, so `window` focus says less than it does in a window:
   * clicking the sidebar blurs the page, with the app still in front.
   */
  appFocused(): boolean
  onAppFocusChange(listener: (focused: boolean) => void): () => void
}

/** How one tab type is drawn in its view. */
export type ExtensionView = {
  /**
   * Draws `tab` into `target`, the page's whole body. Returns what takes it
   * down again, if anything needs to — the page is thrown away with the view,
   * so most never do.
   */
  mount(target: HTMLElement, props: { tab: Tab; host: ViewHost }): void | (() => void)
}

/**
 * How the extension's section of the settings window is drawn (see
 * `Extension.settings`). The page has no tab, so the host has no view state and
 * no connection: the section reaches its main half through `host.call`.
 */
export type SettingsView = {
  /**
   * Draws the section into `target`, the page's whole body. The page scrolls
   * when what is drawn is taller than the panel.
   */
  mount(target: HTMLElement, props: { host: RendererHost }): void | (() => void)
}

export type ExtensionViews = {
  /** The same id as the extension's main half. */
  id: string
  /** Its section of the settings window, when its main half asks for one. */
  settings?: SettingsView
  /** Keyed by the tab type's own id, without the extension prefix. */
  tabs?: Record<string, ExtensionView>
  /**
   * How each of its `page` file viewers draws a file (see
   * `FileViewerContribution`), keyed by the viewer's own id. The tab it is
   * handed is a file tab, whose payload names the file to load from
   * `storedFileUrl`.
   */
  files?: Record<string, ExtensionView>
}

/** Declares an extension's view half. An identity function, there for the types. */
export function defineViews(views: ExtensionViews): ExtensionViews {
  return views
}
