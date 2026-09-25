import { contextBridge, ipcRenderer } from 'electron'
import type {
  ErrorData,
  ExtensionHostBridge,
  HostCall,
  HostCallEnvelope,
  PageRequest,
  RequestReply
} from '../main/extensions/isolation/protocol'

/**
 * The bridge an installed extension's main half gets, and nothing else: two
 * channels to the main process, which checks everything that comes over them
 * against the extension's permissions (see src/main/extensions/isolation).
 *
 * The page is sandboxed, so this preload reaches `electron`'s renderer modules
 * and no others — which is why it imports nothing but types.
 */

let handler: ((call: HostCall) => unknown) | null = null
/** Calls that arrived before the page said it would answer them. */
const early: HostCallEnvelope[] = []

function errorData(error: unknown): ErrorData {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return {
      message: error.message,
      name: error.name,
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {})
    }
  }
  return { message: String(error) }
}

function dispatch({ seq, call }: HostCallEnvelope): void {
  const answer = (reply: RequestReply): void => {
    // Sequence 0 is a notification, which nobody waits on.
    if (seq !== 0) ipcRenderer.send('extension-host:reply', { seq, ...reply })
  }
  Promise.resolve()
    .then(() => handler!(call))
    .then(
      (value) => answer({ ok: true, value }),
      (error: unknown) => answer({ ok: false, error: errorData(error) })
    )
}

ipcRenderer.on('extension-host:call', (_event, envelope: HostCallEnvelope) => {
  if (handler) dispatch(envelope)
  else early.push(envelope)
})

const bridge: ExtensionHostBridge = {
  request: async (request: PageRequest): Promise<unknown> => {
    const reply = (await ipcRenderer.invoke('extension-host:request', request)) as RequestReply
    if (reply.ok) return reply.value
    const error = reply.error ?? { message: 'It failed.' }
    throw Object.assign(new Error(error.message), {
      ...(error.name ? { name: error.name } : {}),
      ...(error.code !== undefined ? { code: error.code } : {})
    })
  },
  onCall: (next) => {
    if (handler) throw new Error('The page already answers calls.')
    handler = next
    for (const envelope of early.splice(0)) dispatch(envelope)
  }
}

contextBridge.exposeInMainWorld('fluidHost', bridge)
