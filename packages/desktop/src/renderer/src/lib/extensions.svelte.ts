import type { Component } from 'svelte'
import {
  claimsMediaType,
  type ExtensionInfo,
  type FileViewerInfo,
  type LauncherEntry,
  type NewTaskEntry,
  type RendererExtension,
  type RendererHost,
  type TabTypeInfo,
  type TabView,
  type TaskTypeInfo
} from '@fluid/sdk'
import claudeCodeRenderer from '@fluid/extension-claude-code/renderer'
import slackRenderer from '@fluid/extension-slack/renderer'
import terminalRenderer from '@fluid/extension-terminal/renderer'
import vscodeRenderer from '@fluid/extension-vscode/renderer'
import { fluid } from './api'
import { reasonFrom } from './ipc-error'

/**
 * Extensions, as the app's windows see them: what their main halves say they
 * contribute (task types, tab types, whether they are running at all), and
 * their renderer halves — how their tabs are drawn, and what they add to the
 * new-tab and new-task launchers. Settings are not here: an extension's
 * section of the settings window is a page of its own views.
 *
 * A renderer half is only consulted while its extension is active, so
 * disabling an extension takes its panes and launcher rows away along with
 * everything its main half registered.
 */

/** Props every extension component is given, alongside any of its own. */
export type ExtensionComponent = Component<{ host: RendererHost } & Record<string, unknown>>

// The terminal first: its launcher row is the one the app has always led with,
// and the launcher lists entries in this order.
const RENDERERS: RendererExtension<ExtensionComponent>[] = [
  terminalRenderer as RendererExtension<ExtensionComponent>,
  slackRenderer as RendererExtension<ExtensionComponent>,
  claudeCodeRenderer as RendererExtension<ExtensionComponent>,
  vscodeRenderer as RendererExtension<ExtensionComponent>
]

/**
 * What an extension's renderer code can ask of the window it runs in, beyond
 * the API. Filled in by the window that has these things — the main one; a
 * panel window leaves them as no-ops.
 */
type WindowActions = Pick<RendererHost, 'openLink' | 'setViewState' | 'flushViewState'>

let actions: WindowActions = {
  openLink: (url) => window.open(url),
  setViewState: () => {},
  flushViewState: () => {}
}

/** Called once by the main window, which is where links open and view state lives. */
export function provideWindowActions(provided: WindowActions): void {
  actions = provided
}

// A cache, not state: nothing is drawn from it.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const hosts = new Map<string, RendererHost>()

/** The host an extension's renderer code is handed. One per extension, so `call` knows whose methods to reach. */
export function hostFor(extensionId: string): RendererHost {
  let host = hosts.get(extensionId)
  if (!host) {
    host = {
      api: fluid,
      call: <T>(method: string, input?: unknown) =>
        fluid.extensions.call({ extensionId, method, input }) as Promise<T>,
      openLink: (url) => actions.openLink(url),
      setViewState: (tabId, viewState) => actions.setViewState(tabId, viewState),
      flushViewState: (tabId) => actions.flushViewState(tabId),
      reasonFrom,
      openSettings: () => window.api.settingsWindow.open(),
      chooseFolder: (options) => window.api.dialog.chooseFolder(options)
    }
    hosts.set(extensionId, host)
  }
  return host
}

class Extensions {
  /** Every installed extension, as its main half last described it. */
  infos = $state<ExtensionInfo[]>([])
  /** Whether `infos` has been heard at all, rather than being empty because nothing has arrived yet. */
  loaded = $state(false)

  private started = false

  /** Starts following the extensions. Idempotent; every window calls it as it loads. */
  start(): void {
    if (this.started) return
    this.started = true
    fluid.watch('extensions.list', {}, (infos) => {
      this.infos = infos
      this.loaded = true
    })
  }

  private active(id: string): boolean {
    return this.infos.some((info) => info.id === id && info.active)
  }

  private renderer(id: string): RendererExtension<ExtensionComponent> | undefined {
    return this.active(id) ? RENDERERS.find((renderer) => renderer.id === id) : undefined
  }

  /** How a tab of an extension's type is drawn, if that extension is running. */
  tabView(type: string): (TabView<ExtensionComponent> & { host: RendererHost }) | undefined {
    const dot = type.indexOf('.')
    if (dot === -1) return undefined
    const extensionId = type.slice(0, dot)
    const view = this.renderer(extensionId)?.tabs?.[type.slice(dot + 1)]
    return view ? { ...view, host: hostFor(extensionId) } : undefined
  }

  /**
   * Whether tabs of `type` are drawn in a view of their own rather than here,
   * and which kind — which is only ever so while the extension that registered
   * it is running. Null for a type drawn here, or not drawn at all.
   */
  /** Whether tabs of `type` draw their own bar across the top of their view. */
  tabDrawsBar(type: string): boolean {
    for (const info of this.infos) {
      if (!info.active) continue
      const found = info.tabTypes.find((tabType) => tabType.id === type)
      if (found) return found.drawsBar === true
    }
    return false
  }

  tabViewKind(type: string): TabTypeInfo['view'] {
    for (const info of this.infos) {
      if (!info.active) continue
      const found = info.tabTypes.find((tabType) => tabType.id === type)
      if (found) return found.view
    }
    return null
  }

  /**
   * The file viewer that draws a file of `mimeType`, if a running extension
   * offers one. The same answer the main process reaches (see `fileViewerFor`
   * in src/main/api/contributions.ts), from the same order: extensions as they
   * are listed, and each one's viewers as it registered them.
   */
  fileViewer(mimeType: string): FileViewerInfo | null {
    for (const info of this.infos) {
      if (!info.active) continue
      const found = info.fileViewers.find((viewer) => claimsMediaType(viewer.mimeTypes, mimeType))
      if (found) return found
    }
    return null
  }

  /** What a tab type is called, for a tab whose extension says nothing better — or has gone. */
  tabTypeLabel(type: string): string {
    for (const info of this.infos) {
      const found = info.tabTypes.find((tabType) => tabType.id === type)
      if (found) return found.label
    }
    return type
  }

  /** How a task of an extension's type is badged, if that extension is running. */
  taskType(type: string | null): TaskTypeInfo | undefined {
    if (type === null) return undefined
    for (const info of this.infos) {
      if (!info.active) continue
      const found = info.taskTypes.find((taskType) => taskType.id === type)
      if (found) return found
    }
    return undefined
  }

  /** Every running extension's launcher entries. */
  launcherEntries(): { extensionId: string; entry: LauncherEntry; host: RendererHost }[] {
    return RENDERERS.filter((renderer) => this.active(renderer.id)).flatMap((renderer) =>
      (renderer.launcher ?? []).map((entry) => ({
        extensionId: renderer.id,
        entry,
        host: hostFor(renderer.id)
      }))
    )
  }

  /** Every running extension's new-task entries, in the order `launcherEntries` lists. */
  newTaskEntries(): { extensionId: string; entry: NewTaskEntry; host: RendererHost }[] {
    return RENDERERS.filter((renderer) => this.active(renderer.id)).flatMap((renderer) =>
      (renderer.newTask ?? []).map((entry) => ({
        extensionId: renderer.id,
        entry,
        host: hostFor(renderer.id)
      }))
    )
  }
}

export const extensions = new Extensions()
