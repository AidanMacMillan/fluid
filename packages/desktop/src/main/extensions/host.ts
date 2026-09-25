import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { app, protocol, session, shell, type CustomScheme } from 'electron'
import { z } from 'zod'
import type {
  Disposable,
  Extension,
  ExtensionContext,
  ExtensionInfo,
  FileViewerContribution,
  FileViewerInfo,
  ScheduledJob,
  TabTypeContribution,
  TabTypeInfo
} from '@fluid/sdk'
import claudeCode from '@fluid/extension-claude-code'
import html from '@fluid/extension-html'
import image from '@fluid/extension-image'
import pdf from '@fluid/extension-pdf'
import slack from '@fluid/extension-slack'
import terminal from '@fluid/extension-terminal'
import video from '@fluid/extension-video'
import vscode from '@fluid/extension-vscode'
import { emit } from '../api/bus'
import {
  fileViewerList,
  provideBookmarks,
  registerFileViewer,
  registerTabType,
  registerTaskType,
  registerViewConnector,
  setExtensionOrder,
  tabTypeList,
  taskTypeList,
  whenContributionsChange
} from '../api/contributions'
import { ApiError } from '../api/errors'
import { isolate, release } from '../api/isolation-policy'
import { localClient } from '../api/router'
import { getSetting, setSetting } from '../db/settings'
import { extensionPartition, extensionWebPartition } from '../extension-views'
import { applyPagePolicy } from '../page-policy'
import {
  deleteExtensionStorage,
  deleteExtensionValue,
  extensionKeys,
  getExtensionValue,
  setExtensionValue
} from '../db/extension-storage'
import {
  deleteExtensionSecrets,
  deleteSecret,
  extensionSecretName,
  extensionSecrets,
  getSecret,
  isSecretStorageAvailable,
  secretStatus,
  setSecret
} from '../secrets'
import { approve, forget, isApproved, wasApproved } from './approvals'
import { runCommand } from './commands'
import {
  folderFor,
  installedFileUrl,
  installedOrigin,
  installedViewCode,
  manifestOf,
  permissionsOf,
  publishSnapshot,
  readCandidate,
  removeFolder,
  scanInstalled,
  snapshotFolder,
  startsWithoutRelaunch,
  takenScheme,
  withdrawSnapshot,
  writeIntoPlace,
  type Candidate,
  type Installed
} from './installed'
import { isolatedExtension } from './isolation/proxy'
import {
  EXTENSION_HOST_PRELOAD,
  extensionHostUrl,
  fetchFor,
  hostPartition,
  prepareHostSession,
  prepareViewSession,
  prepareWebSession
} from './isolation/sessions'

/**
 * Running extensions.
 *
 * Two kinds. Built-in ones are the workspace's own packages, compiled into the
 * app and run in its main process: they are the app's own code. Installed ones
 * are folders in the app's data folder (see ./installed.ts), which run only
 * once the user has approved exactly their files (see ./approvals.ts), and
 * then in a sandboxed page of their own, held to the permissions their
 * manifest asks for (see ./isolation). Either kind reaches the app only
 * through the SDK, and the host runs both the same way from here: an installed
 * extension is an `Extension` whose context is its page's, by proxy.
 *
 * Each is enabled unless the user turned it off, and
 * activating it is handing it an `ExtensionContext` (see the SDK). Everything
 * it registers through that context is remembered here, so disabling it can
 * take every piece back again: its task and tab types, file viewers,
 * bookmarks, schedules, RPC methods and protocols. Its storage, secrets and
 * data folder stay, for when it is enabled again.
 *
 * An extension that throws while activating is left inactive, with the error
 * kept for the settings window to show; the others carry on. So is an
 * installed one that could not be loaded at all, and one waiting for the
 * user's approval is listed without being started.
 */

const BUILT_IN: Extension[] = [slack, claudeCode, vscode, terminal, image, video, html, pdf]

/** The installed extensions' manifests, read before anything else here needs them. */
function scan(): ReturnType<typeof scanInstalled> {
  return scanInstalled({
    ids: BUILT_IN.map((extension) => extension.id),
    schemes: BUILT_IN.flatMap((extension) => (extension.schemes ?? []).map((s) => s.scheme))
  })
}

setExtensionOrder(BUILT_IN.map((extension) => extension.id))

/**
 * Whether an address is one an extension may hand to the OS: a web page or an
 * app's own scheme (`zoommtg://…`), but never a local file or a script.
 */
function opensExternally(url: string): boolean {
  try {
    return !['file:', 'javascript:', 'data:', 'vbscript:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

/** How long after activation a scheduled job first runs, unless it says otherwise. */
const DEFAULT_INITIAL_DELAY_MS = 5_000

type Running = {
  disposables: Disposable[]
  onDispose: (() => void | Promise<void>)[]
  rpc: Map<string, (input: unknown) => unknown>
}

type Entry = {
  extension: Extension
  enabled: boolean
  running: Running | null
  error: string | null
  source: 'built-in' | 'installed'
  /** Where an installed extension that could be loaded came from. */
  installed?: Installed
  /** An installed extension's own version, from its manifest. */
  version?: string
  /** Installed in this run, and waiting for a relaunch to start (see `installExtension`). */
  pendingRelaunch?: boolean
  /** Found in the data folder but not approved, or changed since it was (see ./approvals.ts). */
  needsApproval?: 'new' | 'changed'
  /**
   * Why an installed folder cannot be loaded at all — a bad manifest, another
   * SDK. Listed as its error from the start, and never activated: there is
   * nothing to run, and nothing to report as a failure.
   */
  problem?: string
}

const entries = new Map<string, Entry>(
  BUILT_IN.map((extension) => [
    extension.id,
    { extension, enabled: true, running: null, error: null, source: 'built-in' }
  ])
)

/**
 * Stands in for an installed extension that could not be loaded, so it is
 * listed with the rest and says why. Turning it on only says why again.
 */
function unloadable(id: string, name: string, reason: string): Extension {
  return {
    id,
    name,
    activate: () => {
      throw new Error(reason)
    }
  }
}

/**
 * Stands in for an installed extension waiting for the user's approval. Nothing
 * of its own runs; it is listed so the user can approve it or remove it.
 */
function awaitingApproval(id: string, name: string): Extension {
  return unloadable(id, name, 'Approve it in Settings → Extensions before it can run.')
}

/**
 * An installed extension as the host runs it: in its sandboxed page, with its
 * files served out of the snapshot the user approved.
 */
function isolated(installed: Installed): Extension {
  const { manifest, snapshot } = installed
  const { id } = manifest
  publishSnapshot(id, snapshot)
  return isolatedExtension({
    manifest,
    permissions: permissionsOf(manifest),
    pageUrl: extensionHostUrl(),
    preload: EXTENSION_HOST_PRELOAD,
    mainUrl: installedFileUrl(id, manifest.main),
    partition: hostPartition(id),
    secrets: () => extensionSecrets(id),
    secretsAvailable: isSecretStorageAvailable,
    runCommand: (command, args, options) =>
      runCommand(command, args, options, { minimalEnvironment: true }),
    fetch: (request) => fetchFor(id, request),
    onCrash: (reason) => {
      const entry = entries.get(id)
      if (!entry?.running) return
      console.error(`[${id}] ${reason}`)
      void deactivate(entry).then(() => {
        entry.error = reason
        announce()
      })
    },
    devTools: is.dev
  })
}

/** Adds an installed extension's entry, approved or waiting to be. */
function addEntry(installed: Installed, enabled: boolean, pendingRelaunch = false): Entry {
  const { id, name, version } = installed.manifest
  const approved = isApproved(id, installed.snapshot.digest)
  // The API holds it to its permissions from the moment it is listed, so no
  // page of its can reach further even before its main half starts.
  isolate(id, permissionsOf(installed.manifest))
  const entry: Entry = {
    extension: !approved
      ? awaitingApproval(id, name)
      : pendingRelaunch
        ? unloadable(id, name, 'Relaunch the app to finish installing it.')
        : isolated(installed),
    enabled,
    running: null,
    error: null,
    source: 'installed',
    installed,
    version,
    ...(pendingRelaunch ? { pendingRelaunch } : {}),
    ...(!approved
      ? { needsApproval: wasApproved(id) ? ('changed' as const) : ('new' as const) }
      : {})
  }
  entries.set(id, entry)
  return entry
}

/**
 * Lists every installed extension after the built-in ones, and the folders
 * that cannot be one. Once, as the extensions start.
 */
function addInstalled(): void {
  const { installed, problems } = scan()
  for (const found of installed) addEntry(found, true)
  for (const problem of problems) {
    if (entries.has(problem.id)) continue
    entries.set(problem.id, {
      extension: unloadable(problem.id, problem.name, problem.reason),
      enabled: true,
      running: null,
      error: problem.reason,
      source: 'installed',
      version: problem.version,
      problem: problem.reason
    })
  }
  setExtensionOrder([...entries.keys()])
}

const enabledKey = (id: string): string => `extensions.${id}.enabled`

/**
 * An extension's own folder. Not `extensions/`: on a case-insensitive disk that
 * is Chromium's `Extensions`, which it keeps in the same directory.
 */
export const dataDirFor = (id: string): string =>
  join(app.getPath('userData'), 'extension-data', id)

/**
 * The schemes every extension declares. Read before the app is ready, when
 * schemes have to be registered — long before any extension activates.
 */
export function extensionSchemes(): CustomScheme[] {
  const declared = [
    ...BUILT_IN.flatMap((extension) => extension.schemes ?? []),
    ...scan().installed.flatMap(({ manifest }) => manifest.schemes ?? [])
  ]
  return declared.map(({ scheme, privileges }) => ({ scheme, privileges }))
}

/**
 * Where an installed extension's views load its view module and stylesheet
 * from. Null for a built-in one, whose views are compiled into the app, and
 * for one with no views.
 */
export function viewCodeFor(id: string): { script: string; styles?: string } | null {
  const entry = entries.get(id)
  return entry?.installed && !entry.needsApproval ? installedViewCode(entry.installed) : null
}

/** Whether an extension is running and asked for a section of the settings window. */
export function hasSettings(id: string): boolean {
  const entry = entries.get(id)
  return entry?.running != null && entry.extension.settings !== undefined
}

function announce(): void {
  emit({ type: 'extensions.changed' })
}

function contextFor(entry: Entry, running: Running): ExtensionContext {
  const { id } = entry.extension
  const track = (disposable: Disposable): Disposable => {
    running.disposables.push(disposable)
    return disposable
  }
  const tag = `[${id}]`
  const declaredSchemes = new Set((entry.extension.schemes ?? []).map((s) => s.scheme))

  return {
    id,
    api: localClient({ kind: 'extension', extensionId: id }),

    storage: {
      get: async <T>(key: string) => (await getExtensionValue(id, key)) as T | undefined,
      set: (key, value) => setExtensionValue(id, key, value),
      delete: (key) => deleteExtensionValue(id, key),
      keys: (prefix) => extensionKeys(id, prefix)
    },

    dataDir: dataDirFor(id),

    secrets: {
      get: (name) => getSecret(extensionSecretName(id, name)) ?? null,
      set: (name, value) => setSecret(extensionSecretName(id, name), value),
      delete: (name) => deleteSecret(extensionSecretName(id, name)),
      has: (name) => secretStatus(extensionSecretName(id, name)).configured,
      status: (name) => ({
        available: isSecretStorageAvailable(),
        ...secretStatus(extensionSecretName(id, name))
      })
    },

    schedule: (job) => track(schedule(tag, job)),

    bookmarks: {
      provide: (provider) => track(provideBookmarks(id, provider)),
      changed: () => emit({ type: 'bookmarks.changed' })
    },

    taskTypes: { register: (type) => track(registerTaskType(id, type)) },
    tabTypes: { register: (type) => track(registerTabType(id, type)) },
    fileViewers: { register: (viewer) => track(registerFileViewer(id, viewer)) },

    views: {
      onConnect: (tabType, listener) => track(registerViewConnector(`${id}.${tabType}`, listener))
    },

    rpc: {
      handle: (method, handler) => {
        if (running.rpc.has(method)) throw new Error(`${tag} ${method} is already handled.`)
        running.rpc.set(method, handler)
        return track({ dispose: () => running.rpc.delete(method) })
      }
    },

    extensions: {
      call: async <T>(extensionId: string, method: string, input?: unknown) =>
        (await callExtension(extensionId, method, input)) as T
    },

    protocols: {
      handle: (scheme, handler) => {
        if (!declaredSchemes.has(scheme)) {
          throw new Error(`${tag} ${scheme} is not one of the schemes it declared.`)
        }
        // The default session, where the app's windows load, and the
        // extension's own, where its views do. A page in any other session —
        // a browser tab's profile — does not reach it. An installed
        // extension's is served to its own views only: the app's windows are
        // the app's, and draw nothing an installed extension serves.
        const own = session.fromPartition(extensionPartition(id)).protocol
        const windows = entry.source === 'built-in' ? protocol : null
        windows?.handle(scheme, handler)
        own.handle(scheme, handler)
        return track({
          dispose: () => {
            windows?.unhandle(scheme)
            own.unhandle(scheme)
          }
        })
      }
    },

    openExternal: async (url) => {
      if (!opensExternally(url)) throw new Error(`${tag} refused to open ${url}.`)
      await shell.openExternal(url)
    },

    // The app's own code may run what it likes; an installed extension's page
    // reaches this through its proxy, which checks the command first.
    process: { run: (command, args, options) => runCommand(command, args, options) },

    onDispose: (dispose) => {
      running.onDispose.push(dispose)
    },

    log: {
      info: (...args) => console.log(tag, ...args),
      warn: (...args) => console.warn(tag, ...args),
      error: (...args) => console.error(tag, ...args)
    }
  }
}

/**
 * Runs a job on a timer, each run starting `intervalMs` after the previous one
 * ended so that runs never overlap. A run that throws is logged and the next
 * one still happens: one bad pass is not a reason to stop watching.
 */
function schedule(tag: string, job: ScheduledJob): Disposable {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const run = async (): Promise<void> => {
    timer = null
    try {
      await job.run()
    } catch (error) {
      console.error(`${tag} ${job.id} failed:`, error)
    }
    if (!stopped) timer = setTimeout(run, job.intervalMs)
  }

  timer = setTimeout(run, job.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
  return {
    dispose: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }
}

async function activate(entry: Entry): Promise<void> {
  if (entry.running || entry.needsApproval) return
  if (entry.problem) {
    entry.error = entry.problem
    return
  }
  const running: Running = { disposables: [], onDispose: [], rpc: new Map() }
  entry.running = running
  entry.error = null
  try {
    await mkdir(dataDirFor(entry.extension.id), { recursive: true })
    const own = session.fromPartition(extensionPartition(entry.extension.id))
    const schemes = (entry.extension.schemes ?? []).map((declared) => declared.scheme)
    // An installed extension's pages load its approved files out of memory,
    // over sessions that load nothing else.
    if (entry.installed) {
      prepareHostSession(entry.extension.id)
      prepareViewSession(own, entry.extension.id, schemes)
      prepareWebSession(
        session.fromPartition(extensionWebPartition(entry.extension.id)),
        entry.extension.id,
        permissionsOf(entry.installed.manifest).hosts
      )
    }
    // Its views draw from its own schemes, and from nobody else's: those are
    // not served on its session anyway (see `protocols` in `contextFor`).
    applyPagePolicy(
      own,
      'extension-view.html',
      schemes,
      entry.installed ? [installedOrigin(entry.extension.id)] : []
    )
    await entry.extension.activate(contextFor(entry, running))
  } catch (error) {
    console.error(`[${entry.extension.id}] failed to activate:`, error)
    await deactivate(entry)
    entry.error = error instanceof Error ? error.message : String(error)
  }
  announce()
}

async function deactivate(entry: Entry): Promise<void> {
  const running = entry.running
  if (!running) return
  entry.running = null
  for (const disposable of running.disposables.reverse()) {
    try {
      disposable.dispose()
    } catch (error) {
      console.error(`[${entry.extension.id}] failed to let go of something:`, error)
    }
  }
  for (const dispose of running.onDispose) {
    try {
      await dispose()
    } catch (error) {
      console.error(`[${entry.extension.id}] failed to shut down:`, error)
    }
  }
  announce()
}

/** Activates every enabled extension. Called once the database is up. */
export async function startExtensions(): Promise<void> {
  whenContributionsChange(announce)
  addInstalled()
  for (const entry of entries.values()) {
    entry.enabled = (await getSetting<boolean>(enabledKey(entry.extension.id))) !== false
    if (entry.enabled) await activate(entry)
  }
}

/**
 * Deactivates every extension at once rather than one after another, because
 * quitting does not wait for this: whatever an extension does before its first
 * `await` — killing the processes it started, say — happens before the app
 * goes, and one extension slow to let go cannot stop the next from starting to.
 */
export async function stopExtensions(): Promise<void> {
  await Promise.all([...entries.values()].map(deactivate))
}

/**
 * Each payload schema as JSON Schema, which is what crosses the API: a zod
 * schema is code, and the windows and agents reading a type's info get data.
 * Worked out once per registration, since the list is read on every change.
 */
const payloadSchemas = new WeakMap<TabTypeContribution, Record<string, unknown> | undefined>()

function payloadSchemaOf(contribution: TabTypeContribution): Record<string, unknown> | undefined {
  if (!contribution.payload) return undefined
  if (!payloadSchemas.has(contribution)) {
    let schema: Record<string, unknown> | undefined
    try {
      schema = z.toJSONSchema(contribution.payload) as Record<string, unknown>
    } catch (error) {
      // A schema with a transform or a refinement JSON Schema cannot say. The
      // payload is still checked; it just cannot be described.
      console.warn(`${contribution.id}: its payload schema cannot be described:`, error)
    }
    payloadSchemas.set(contribution, schema)
  }
  return payloadSchemas.get(contribution)
}

function tabTypeInfo(fullId: string, contribution: TabTypeContribution): TabTypeInfo {
  const payloadSchema = payloadSchemaOf(contribution)
  return {
    id: fullId,
    label: contribution.label,
    view: contribution.view ? (contribution.view.kind === 'web' ? 'web' : 'page') : null,
    drawsBar:
      contribution.view && contribution.view.kind !== 'web' && contribution.view.drawsBar
        ? true
        : undefined,
    ...(payloadSchema ? { payloadSchema } : {}),
    // Only alongside a schema, since a schema is how an agent opens one.
    ...(payloadSchema && contribution.agentDescription
      ? { agentDescription: contribution.agentDescription }
      : {})
  }
}

function fileViewerInfo(fullId: string, contribution: FileViewerContribution): FileViewerInfo {
  const { view } = contribution
  return {
    id: fullId,
    label: contribution.label,
    mimeTypes: contribution.mimeTypes,
    view:
      view.kind === 'native'
        ? { kind: 'native', resizable: view.resizable === true }
        : { kind: 'page' }
  }
}

function info(entry: Entry): ExtensionInfo {
  const { id, name, description, settings } = entry.extension
  return {
    id,
    name,
    description,
    enabled: entry.enabled,
    active: entry.running !== null,
    error: entry.error ?? undefined,
    source: entry.source,
    ...(entry.version ? { version: entry.version } : {}),
    ...(entry.pendingRelaunch ? { pendingRelaunch: true } : {}),
    ...(entry.needsApproval ? { needsApproval: entry.needsApproval } : {}),
    ...(entry.installed ? { permissions: permissionsOf(entry.installed.manifest) } : {}),
    ...(settings ? { settings: { label: settings.label ?? name } } : {}),
    taskTypes: taskTypeList()
      .filter((registered) => registered.extensionId === id)
      .map(({ fullId, contribution }) => ({
        id: fullId,
        label: contribution.label,
        description: contribution.description
      })),
    tabTypes: tabTypeList()
      .filter((registered) => registered.extensionId === id)
      .map(({ fullId, contribution }) => tabTypeInfo(fullId, contribution)),
    fileViewers: fileViewerList()
      .filter((registered) => registered.extensionId === id)
      .map(({ fullId, contribution }) => fileViewerInfo(fullId, contribution))
  }
}

export function listExtensions(): ExtensionInfo[] {
  return [...entries.values()].map(info)
}

function entryFor(id: string): Entry {
  const entry = entries.get(id)
  if (!entry) throw new ApiError(`No extension ${id} is installed.`)
  return entry
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionInfo> {
  const entry = entryFor(id)
  if (enabled && entry.needsApproval) {
    throw new ApiError(`Approve ${entry.extension.name} before turning it on.`)
  }
  entry.enabled = enabled
  await setSetting(enabledKey(id), enabled)
  if (enabled) await activate(entry)
  else {
    await deactivate(entry)
    entry.error = entry.problem ?? null
    announce()
  }
  return info(entry)
}

export async function callExtension(id: string, method: string, input: unknown): Promise<unknown> {
  const entry = entryFor(id)
  const handler = entry.running?.rpc.get(method)
  if (!handler) {
    throw new ApiError(
      entry.running ? `${id} has no ${method} method.` : `${entry.extension.name} is not enabled.`
    )
  }
  return handler(input)
}

// ---------------------------------------------------------------------------
// Installing while the app runs
// ---------------------------------------------------------------------------

/** A folder the user picked to install, and what installing it would replace. */
export type InstallPlan = {
  candidate: Candidate
  /** The installed extension it would replace, if there is one. */
  replaces: { name: string; version?: string } | null
}

/**
 * Reads a folder the user picked, whole, and says what installing it would do,
 * or throws why it cannot be installed at all. Nothing is written yet: the
 * window asks the user first, about exactly the files read here.
 */
export function planInstall(folder: string): InstallPlan {
  const candidate = readCandidate(folder)
  const { id } = candidate.manifest
  const existing = entries.get(id)
  if (existing?.source === 'built-in') {
    throw new ApiError(`${existing.extension.name} is built into the app, so ${id} is taken.`)
  }
  const scheme = takenScheme(candidate)
  if (scheme) throw new ApiError(`It declares the ${scheme}: scheme, which is already taken.`)
  return {
    candidate,
    replaces: existing ? { name: existing.extension.name, version: existing.version } : null
  }
}

/**
 * Installs a planned extension, replacing the one with the same id, approves
 * the files that were planned, and starts it unless the user had turned it
 * off. The old version is stopped first, so the new one registers everything
 * afresh; its storage, secrets and data folder carry over, since they belong
 * to the id. A write that fails leaves the old version installed, and running
 * if it was.
 *
 * One that declares a scheme it did not have as the app started cannot start
 * until the app relaunches, and is listed as waiting for that.
 */
export async function installExtension({ candidate }: InstallPlan): Promise<ExtensionInfo> {
  const { id } = candidate.manifest
  const existing = entries.get(id)
  const wasRunning = existing?.running != null
  if (existing) await deactivate(existing)

  let installed: Installed
  try {
    installed = writeIntoPlace(candidate)
  } catch (error) {
    if (existing && wasRunning) await activate(existing)
    throw error
  }
  approve(id, installed.snapshot.digest)

  const enabled = (await getSetting<boolean>(enabledKey(id))) !== false
  const entry = addEntry(installed, enabled, !startsWithoutRelaunch(candidate))
  setExtensionOrder([...entries.keys()])
  if (entry.enabled && !entry.pendingRelaunch) await activate(entry)
  else announce()
  return info(entry)
}

/** An installed extension waiting for approval, read again as it is now, and why it waits. */
export type ApprovalPlan = {
  installed: Installed
  reason: 'new' | 'changed'
}

/**
 * Reads an installed extension's folder again, whole, for the user to approve.
 * Read again rather than taken from when the app started, so what the user is
 * asked about is what is there now — and what is approved is exactly that.
 */
export function planApproval(id: string): ApprovalPlan {
  const entry = entryFor(id)
  if (!entry.needsApproval || !entry.installed) {
    throw new ApiError(`${entry.extension.name} is not waiting to be approved.`)
  }
  const dir = folderFor(id)
  const snapshot = snapshotFolder(dir)
  const manifest = manifestOf(snapshot)
  if (manifest.id !== id) {
    throw new ApiError(`Its folder is ${id}, but its manifest now says it is ${manifest.id}.`)
  }
  const scheme = takenScheme({ manifest })
  if (scheme) throw new ApiError(`It declares the ${scheme}: scheme, which is already taken.`)
  return { installed: { manifest, dir, snapshot }, reason: entry.needsApproval }
}

/** Approves exactly the files that were planned, and starts the extension unless it is turned off. */
export async function approveExtension({ installed }: ApprovalPlan): Promise<ExtensionInfo> {
  const { id } = installed.manifest
  const existing = entryFor(id)
  await deactivate(existing)
  approve(id, installed.snapshot.digest)
  const entry = addEntry(installed, existing.enabled, !startsWithoutRelaunch(installed))
  if (entry.enabled && !entry.pendingRelaunch) await activate(entry)
  else announce()
  return info(entry)
}

/**
 * Stops an installed extension, deletes its folder, forgets its approval, and
 * deletes everything it kept: its storage, its secrets, its data folder and
 * what its pages stored. Nothing of it is left for the next extension to be
 * installed under the same id, which could be anybody's — ids are chosen by
 * whoever builds the extension. The tasks and tabs it made are the user's,
 * and stay. Stopping it closes its page, so none of its code outlives this.
 */
export async function uninstallExtension(id: string): Promise<void> {
  const entry = entryFor(id)
  if (entry.source !== 'installed') {
    throw new ApiError(`${entry.extension.name} is built into the app and cannot be removed.`)
  }
  await deactivate(entry)
  entries.delete(id)
  removeFolder(id)
  forget(id)
  withdrawSnapshot(id)
  release(id)
  await deleteExtensionStorage(id)
  deleteExtensionSecrets(id)
  await rm(dataDirFor(id), { recursive: true, force: true })
  await Promise.all(
    [extensionPartition(id), extensionWebPartition(id)].map((partition) =>
      session.fromPartition(partition).clearStorageData()
    )
  )
  setExtensionOrder([...entries.keys()])
  announce()
}

/** An installed extension's folder, for showing in the file manager. */
export function installedFolder(id: string): string {
  const entry = entryFor(id)
  if (entry.source !== 'installed') throw new ApiError(`${entry.extension.name} is built in.`)
  return folderFor(id)
}
