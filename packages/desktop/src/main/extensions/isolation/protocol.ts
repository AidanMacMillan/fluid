import type {
  BookmarkContribution,
  ExtensionPermissions,
  FileViewerContribution,
  ProcessOptions,
  ProcessResult,
  Tab,
  Task,
  TaskActionIcon,
  WorkspaceEvent
} from '@fluid/sdk'

/**
 * What crosses between the main process and the sandboxed page an installed
 * extension's main half runs in (see ./proxy.ts for the main process's side,
 * and src/renderer/src/extension-host.ts for the page's).
 *
 * The extension's code is in the page and everything it can touch is here, so
 * the page's requests are the whole of what the extension can ask for, and the
 * main process checks each one against the extension's permissions. The main
 * process's calls are the other way round: the app asking the extension's code
 * something — a task's buttons, what a tab's menu offers, an RPC — which only
 * the page can answer, since functions do not cross.
 *
 * Everything here is data that survives the structured clone IPC uses. A
 * registration names its callbacks by what it has (`hasActions`) rather than
 * carrying them, and the main process calls back into the page for them by the
 * registration's number.
 *
 * @module protocol
 */

/** A registration's number, unique within one run of the page. */
export type RegistrationId = number

/** A tab type's view, less the function a web view names its address with. */
export type ViewDeclarationData =
  | { kind: 'page'; keys?: string[]; focusOnShow?: boolean; drawsBar?: boolean }
  | { kind: 'web'; keys?: string[] | 'all'; stylesheet?: string; transparent?: boolean }

export type Registration =
  | {
      kind: 'taskType'
      id: RegistrationId
      type: { id: string; label: string; description?: string; hasActions: boolean }
    }
  | {
      kind: 'tabType'
      id: RegistrationId
      type: {
        id: string
        label: string
        agentDescription?: string
        /** The payload's schema as JSON Schema; the main process checks payloads against it. */
        payloadSchema?: Record<string, unknown>
        view?: ViewDeclarationData
        hasPinnedUrl: boolean
        hasMenu: boolean
        hasOnStop: boolean
        hasOnClose: boolean
      }
    }
  | { kind: 'fileViewer'; id: RegistrationId; viewer: FileViewerContribution }
  | { kind: 'bookmarks'; id: RegistrationId; bookmarks: BookmarkContribution[] }
  | { kind: 'viewConnector'; id: RegistrationId; tabType: string }
  | { kind: 'rpc'; id: RegistrationId; method: string }
  | { kind: 'protocol'; id: RegistrationId; scheme: string }
  | {
      kind: 'schedule'
      id: RegistrationId
      job: { id: string; intervalMs: number; initialDelayMs?: number }
    }

/** A request as `fetch` makes it, for the main process to make on the page's behalf. */
export type FetchRequest = {
  url: string
  method: string
  headers: [string, string][]
  body: Uint8Array | null
}

export type FetchResponse = {
  url: string
  status: number
  statusText: string
  headers: [string, string][]
  body: Uint8Array
}

/** What the page asks of the main process. Each answers with the value named beside it. */
export type PageRequest =
  | { type: 'ready' } // → void
  | { type: 'api.call'; method: string; input: unknown } // → the method's output
  | { type: 'storage.get'; key: string } // → unknown
  | { type: 'storage.set'; key: string; value: unknown } // → void
  | { type: 'storage.delete'; key: string } // → void
  | { type: 'storage.keys'; prefix?: string } // → string[]
  | { type: 'secrets.set'; name: string; value: string } // → SecretSnapshot
  | { type: 'secrets.delete'; name: string } // → void
  | { type: 'register'; registration: Registration } // → void
  | { type: 'dispose'; id: RegistrationId } // → void
  | { type: 'bookmarks.set'; id: RegistrationId; bookmarks: BookmarkContribution[] } // → void
  | { type: 'bookmarks.changed' } // → void
  | { type: 'extensions.call'; extensionId: string; method: string; input: unknown } // → unknown
  | { type: 'openExternal'; url: string } // → void
  | { type: 'process.run'; command: string; args: string[]; options?: ProcessOptions } // → ProcessResult
  | { type: 'net.fetch'; request: FetchRequest } // → FetchResponse
  | { type: 'view.post'; connectionId: number; message: unknown } // → void
  | { type: 'log'; level: 'info' | 'warn' | 'error'; args: unknown[] } // → void

/** One of the extension's secrets as the page holds it: its own, decrypted for it. */
export type SecretSnapshot = { value: string; updatedAt: string }

/** Everything the page needs to build the extension's context and load it. */
export type ActivateContext = {
  id: string
  /** Where the page imports the extension's main half from. */
  mainUrl: string
  dataDir: string
  secretsAvailable: boolean
  secrets: Record<string, SecretSnapshot>
}

/** A task's button, less the function it runs. */
export type TaskActionData = {
  id: string
  label: string
  icon?: TaskActionIcon
  enabled?: boolean
  hint?: string
  confirm?: { message: string; detail?: string; button: string }
}

export type TabMenuItemData = { label: string; enabled?: boolean } | { type: 'separator' }

export type ProtocolRequest = {
  url: string
  method: string
  headers: [string, string][]
  body: Uint8Array | null
}

export type ProtocolResponse = {
  status: number
  statusText: string
  headers: [string, string][]
  body: Uint8Array | null
}

/** What the main process asks of the page. Each answers with the value named beside it. */
export type HostCall =
  | { type: 'activate'; context: ActivateContext } // → void
  | { type: 'deactivate' } // → void
  | { type: 'taskType.actions'; registration: RegistrationId; task: Task } // → TaskActionData[]
  | { type: 'taskType.run'; registration: RegistrationId; task: Task; actionId: string } // → void
  | { type: 'tabType.pinnedUrl'; registration: RegistrationId; tab: Tab } // → string | null
  | { type: 'tabType.menu'; registration: RegistrationId; tab: Tab } // → { token, items }
  | { type: 'tabType.menuClick'; token: number; index: number } // → void
  | { type: 'tabType.onStop'; registration: RegistrationId; tab: Tab } // → void
  | { type: 'tabType.onClose'; registration: RegistrationId; tab: Tab } // → void
  | { type: 'tabType.url'; registration: RegistrationId; tab: Tab } // → string
  | { type: 'rpc'; registration: RegistrationId; input: unknown } // → unknown
  | { type: 'protocol'; registration: RegistrationId; request: ProtocolRequest } // → ProtocolResponse
  | { type: 'job.run'; registration: RegistrationId } // → void
  | { type: 'view.connect'; registration: RegistrationId; connectionId: number; tabId: string }
  | { type: 'view.message'; connectionId: number; message: unknown }
  | { type: 'view.disconnect'; connectionId: number }
  | { type: 'api.event'; event: WorkspaceEvent }

/** Calls the page answers without being waited on. */
export const NOTIFICATIONS = new Set<HostCall['type']>([
  'view.connect',
  'view.message',
  'view.disconnect',
  'api.event'
])

/** A call and its sequence number, which the page's answer carries back. */
export type HostCallEnvelope = { seq: number; call: HostCall }

/** A failure, as the side it happened on threw it, in a form that crosses. */
export type ErrorData = { message: string; name?: string; code?: string | number }

/** The page's answer to a call: `value` when `ok`, and `error` when not. */
export type HostReply = { seq: number; ok: boolean; value?: unknown; error?: ErrorData }

/** The main process's answer to a request, shaped the same way. */
export type RequestReply = { ok: boolean; value?: unknown; error?: ErrorData }

/** What the page's bridge is, as the preload exposes it (see src/preload/extension-host.ts). */
export type ExtensionHostBridge = {
  request(request: PageRequest): Promise<unknown>
  /** Answers the main process's calls; one handler for the page's life. */
  onCall(handler: (call: HostCall) => unknown): void
}

export type { ExtensionPermissions, ProcessResult }
