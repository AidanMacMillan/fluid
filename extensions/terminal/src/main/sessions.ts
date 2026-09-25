import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import type { Client, TabActivity, ViewConnection } from '@fluid/sdk'
import {
  isTerminalTab,
  type MainMessage,
  type TerminalTabPayload,
  type ViewMessage
} from '../shared/tab'
import { context } from './context'
import { integrationEnv } from './integration'

/**
 * The shells behind terminal tabs.
 *
 * A terminal tab is a tab with a real process on the other side of it, and the
 * process belongs here rather than in the tab's view for the same reason a
 * browser tab's page does — the view is a sandboxed web page, and spawning a
 * login shell is not a thing a web page gets to do. What crosses the view's
 * connection is bytes in both directions and nothing else.
 *
 * A session outlives its view. A view can be let go of at any moment — pushed
 * out of the warm set, or the window reloaded — and the shell carries on;
 * the next view to connect is handed what it printed while nobody was
 * watching, and picks up from there.
 *
 * The other direction does not hold: a tab does not outlive its shell. When a
 * shell stops on its own — the user typed `exit`, or pressed Ctrl-D — the tab
 * is closed behind it, so the row goes the way it does in a terminal emulator.
 * An exit this extension caused closes nothing, because the tab it would name
 * is already going; see `Session.ended`.
 */

/**
 * How much of each session's output is kept for replay. The buffer is what
 * makes a background terminal worth having: without it, a view built for a
 * build that is still running would show a blank screen with the build behind
 * it.
 *
 * It is not the scrollback — xterm keeps that for as long as the view is up.
 * This is only what a view that has just been built needs in order to look
 * like the one that was let go of, so a screenful and a generous margin is the
 * whole requirement.
 */
const MAX_REPLAY_BYTES = 256 * 1024

/**
 * How long output is gathered before being sent across. A shell printing fast —
 * a build, a `cat` of something large — produces hundreds of small reads a
 * second, and one message per read is what makes a terminal feel like it is
 * struggling. A frame's worth per message costs nothing visible and turns that
 * into sixty.
 */
const FLUSH_MS = 8

/**
 * How long a change to where the shell is, or what it is running, waits
 * before it is written into the tab. Long enough that an `ls` has been and gone
 * before its row would have said so — a row flickering through every quick
 * command is noise — and short enough that a command that is still running
 * names its row before anyone has looked for it.
 */
const SYNC_MS = 150

/**
 * The longest escape sequence held over from one read to the next while its
 * end is still to come. Well past any command line anyone types; a sequence
 * that is longer than this is not one of the ones read here.
 */
const MAX_OSC_BYTES = 16 * 1024

type Session = {
  pty: IPty
  /** Output held for replay, oldest first. Whole chunks, so nothing is cut mid-sequence. */
  replay: string[]
  replayBytes: number
  /** The view drawing this shell, if one is connected. */
  view: ViewConnection | null
  /** Output waiting out `FLUSH_MS` before it is sent. Only gathered while a view is connected. */
  pending: string[]
  flush: ReturnType<typeof setTimeout> | null
  /**
   * Whether this extension ended the shell rather than the user: a tab being
   * closed or its task settled, the extension being disabled, or the app
   * quitting. Such an exit closes nothing, because the tab it would name is
   * already on its way out or is meant to stay.
   */
  ended: boolean
  /** Set once the shell has stopped; the session stays until its tab has gone. */
  exited: boolean
  /** Where the shell last said it was. */
  cwd: string
  /** The command line the shell last said it had started, until its prompt comes back. */
  running: string | null
  /**
   * What the tab's row should say about the shell's work: working while a
   * command runs, done once one has finished (see `TabActivity`). Written with
   * the rest in `sync`, so a command that is over before the write goes out —
   * nearly every one typed at a prompt — lands as done without ever having
   * shown as working.
   */
  activity: TabActivity | null
  /**
   * Whether `activity` has moved since it was last written. Kept rather than
   * comparing with the tab: the window takes `done` off a tab once it has been
   * seen, and that is not the shell's news to put back — while a second
   * command finishing is, even though it says `done` again.
   */
  activityChanged: boolean
  /** The start of an escape sequence whose end has not been read yet. */
  oscCarry: string
  /** Waiting out `SYNC_MS` before `cwd` and `running` are written into the tab. */
  syncTimer: ReturnType<typeof setTimeout> | null
  /** A write into the tab is under way; `resync` asks it to go round again. */
  syncing: boolean
  resync: boolean
}

/** tab id → its shell. Sessions outlive their views; only a tab stopping ends one. */
const sessions = new Map<string, Session>()

/**
 * node-pty, loaded the first time a terminal is actually asked for. It is a
 * native module built against Electron's own ABI (see `install-app-deps` in
 * the app's package.json postinstall), and a build that did not happen should
 * cost the user a terminal tab that will not open — not an extension that will
 * not activate.
 */
let pty: typeof import('node-pty') | null = null
let ptyError: string | null = null

function loadPty(): typeof import('node-pty') | null {
  if (pty || ptyError) return pty
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pty = require('node-pty') as typeof import('node-pty')
  } catch (error) {
    ptyError = error instanceof Error ? error.message : String(error)
    context().log.error('Failed to load node-pty:', error)
  }
  return pty
}

/** The user's shell, or the platform's default when the environment names none. */
export function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC ?? 'powershell.exe'
  }
  return process.env.SHELL ?? '/bin/zsh'
}

/**
 * Whether the shell is started as a login shell. On macOS an app launched from
 * the Dock inherits `launchd`'s environment rather than a terminal's, so
 * everything the user's profile puts on `PATH` — homebrew, nvm, asdf, the
 * project's own tooling — is simply absent unless the shell reads that profile
 * itself. This is the difference between a terminal that works and one where
 * half the commands are not found.
 *
 * Elsewhere the desktop session has already supplied that environment, and a
 * login shell would only re-read the wrong file for bash (`.bash_profile`
 * rather than `.bashrc`).
 */
function shellArgs(): string[] {
  return process.platform === 'darwin' ? ['-l'] : []
}

/**
 * The environment the shell starts in: this process's, less the parts that are
 * about *this* process being Electron, plus what a terminal is expected to say
 * about itself. Anything inherited that says "you are inside Node" leads tools
 * to re-enter the app's own binary instead of running.
 */
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  delete env.NODE_OPTIONS

  // What the programs on the other side read to decide what they may draw.
  // xterm.js renders a 256-colour terminal with 24-bit colour support, and
  // saying so is what gets syntax highlighting and progress bars rather than
  // the plain-teletype fallback.
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // Says which terminal a program is talking to, for the few that care.
  env.TERM_PROGRAM = 'fluid'
  return env
}

/**
 * A directory that exists, falling back to home for one that has since gone —
 * a volume that is not mounted, a checkout that was deleted. That is not the
 * user changing their mind about where the tab is, so the payload keeps its
 * answer and only this one shell starts at home.
 */
function usableCwd(cwd: string | undefined): string {
  if (cwd) {
    try {
      if (statSync(cwd).isDirectory()) return cwd
    } catch {
      // Nothing there at all.
    }
  }
  return homedir()
}

/** A size a pty will take: whole cells, and at least one of each. */
function cells(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function send(view: ViewConnection, message: MainMessage): void {
  view.post(message)
}

/**
 * Takes a newly connected view. Nothing is sent until it asks to `open`, which
 * it does once it has measured itself, so a shell started for it is started
 * at the size it will be read at.
 */
export function connectView(view: ViewConnection): void {
  const { tabId } = view

  view.onMessage((raw) => {
    const message = raw as ViewMessage
    switch (message?.type) {
      case 'open':
        void open(view, cells(message.cols), cells(message.rows))
        return
      case 'input':
        if (typeof message.data === 'string') write(tabId, message.data)
        return
      case 'resize':
        resize(tabId, cells(message.cols), cells(message.rows))
        return
    }
  })

  view.onDisconnect(() => {
    const session = sessions.get(tabId)
    if (session?.view !== view) return
    session.view = null
    // Output gathered for a view that has gone is already in the replay.
    if (session.flush !== null) clearTimeout(session.flush)
    session.flush = null
    session.pending = []
  })
}

/**
 * Attaches `view` to its tab's shell, starting one if this is the first time —
 * which is either a tab that has just been made or one whose shell went with
 * the last run of the app. Either way what the view is sent is everything it
 * needs to look the way the last one did.
 */
async function open(view: ViewConnection, cols: number, rows: number): Promise<void> {
  const { tabId } = view
  const existing = sessions.get(tabId)
  if (existing) return attach(existing, view, cols, rows)

  const module = loadPty()
  if (!module) {
    const message = `The terminal backend could not be loaded. ${ptyError ?? ''}`.trim()
    return send(view, { type: 'failed', message })
  }

  const tab = await context().api.tabs.get({ id: tabId })
  if (!view.connected) return
  if (!tab || !isTerminalTab(tab)) {
    return send(view, { type: 'failed', message: 'This tab no longer exists.' })
  }
  // A second view can have asked while the tab was being read — a page
  // reloaded under the first — and got here first.
  const raced = sessions.get(tabId)
  if (raced) return attach(raced, view, cols, rows)

  const shell = tab.payload.shell || defaultShell()

  const env = shellEnv()
  let child: IPty
  try {
    child = module.spawn(shell, shellArgs(), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: usableCwd(tab.payload.cwd),
      env: { ...env, ...integrationEnv(shell, env) }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    context().log.error(`Failed to start ${shell}:`, error)
    return send(view, { type: 'failed', message: `Could not start ${shell}. ${message}` })
  }

  const session: Session = {
    pty: child,
    replay: [],
    replayBytes: 0,
    view: null,
    pending: [],
    flush: null,
    ended: false,
    exited: false,
    cwd: tab.payload.cwd,
    running: null,
    activity: null,
    activityChanged: false,
    oscCarry: '',
    syncTimer: null,
    syncing: false,
    resync: false
  }
  sessions.set(tabId, session)
  // A command the tab was left saying it ran belongs to a shell that has
  // gone — the app quit under it — and this one has not started anything.
  if (tab.payload.running) scheduleSync(tabId, session)

  child.onData((data) => {
    record(session, data)
    readMarks(tabId, session, data)
  })
  child.onExit(() => {
    // A shell this extension ended has nothing to tell anyone.
    if (session.ended) return

    // Whatever the shell printed on its way out belongs on screen before the
    // tab goes.
    flushNow(session)
    session.exited = true
    // The tab goes with its shell, whether or not anyone is looking at it —
    // the shell that ended need not be the one on screen, or even in the task
    // that is. Closing it stops it (see `onStop`), which is what finally drops
    // the session.
    void context()
      .api.tabs.close({ id: tabId })
      .catch((error: unknown) => context().log.error('Failed to close an exited terminal:', error))
  })

  attach(session, view, cols, rows)

  // Typed ahead: the shell reads it once it has started, as it would have
  // read the user typing before the first prompt was drawn.
  if (tab.payload.command) child.write(`${tab.payload.command}\r`)
  // A one-off goes after the tab's standing command, and is written off the
  // tab straight away rather than after the usual pause: a relaunch that came
  // before the write landed would type it again.
  if (tab.payload.run) {
    child.write(`${tab.payload.run}\r`)
    void sync(tabId, session)
  }
}

/** Hands `view` the replay, and from then on the shell's output as it comes. */
function attach(session: Session, view: ViewConnection, cols: number, rows: number): void {
  if (session.flush !== null) clearTimeout(session.flush)
  session.flush = null
  session.pending = []
  session.view = view

  // The view that just attached may be a different size than the one that
  // left, so the shell is told before it prints anything else.
  if (!session.exited) resizeSession(session, cols, rows)
  send(view, { type: 'ready', replay: session.replay.join('') })
}

/** Holds a chunk for replay and queues it for the view. */
function record(session: Session, data: string): void {
  session.replay.push(data)
  session.replayBytes += data.length
  // Whole chunks are dropped rather than the buffer being cut to length: a cut
  // through the middle of an escape sequence replays as garbage on screen.
  while (session.replayBytes > MAX_REPLAY_BYTES && session.replay.length > 1) {
    session.replayBytes -= session.replay.shift()!.length
  }

  if (!session.view) return
  session.pending.push(data)
  if (session.flush === null) {
    session.flush = setTimeout(() => flushNow(session), FLUSH_MS)
  }
}

function flushNow(session: Session): void {
  if (session.flush !== null) {
    clearTimeout(session.flush)
    session.flush = null
  }
  if (session.pending.length === 0 || !session.view) return

  const data = session.pending.join('')
  session.pending = []
  send(session.view, { type: 'output', data })
}

/**
 * Reads what the shell reports about itself out of what it prints: where it
 * is (OSC 7) and what it is running (OSC 133; see ./integration.ts). Read here
 * rather than in the view, so a row keeps up with a shell in the background
 * that nothing is drawing.
 *
 * Only the reports are taken; the output is untouched, and xterm ignores both
 * sequences. A sequence cut in two by the read boundary is held over and
 * finished with the next read.
 */
function readMarks(tabId: string, session: Session, data: string): void {
  const text = session.oscCarry + data
  session.oscCarry = ''
  let from = 0
  for (;;) {
    const start = text.indexOf('\x1b]', from)
    if (start === -1) break
    const body = start + 2
    const end = oscEnd(text, body)
    if (!end) {
      if (text.length - start <= MAX_OSC_BYTES) session.oscCarry = text.slice(start)
      return
    }
    if (!end.aborted) readMark(tabId, session, text.slice(body, end.index))
    from = end.index + end.length
  }
  // The escape that begins the next one, with the rest still to come.
  if (text.endsWith('\x1b')) session.oscCarry = '\x1b'
}

/**
 * Where an OSC sequence's body ends: at BEL, at ST (ESC and a backslash), or cut short by
 * any other escape, in which case it is not a sequence at all. Null while the
 * end has not been printed yet.
 */
function oscEnd(
  text: string,
  from: number
): { index: number; length: number; aborted: boolean } | null {
  for (let i = from; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x07) return { index: i, length: 1, aborted: false }
    if (code !== 0x1b) continue
    if (i + 1 === text.length) return null
    return text[i + 1] === '\\'
      ? { index: i, length: 2, aborted: false }
      : { index: i, length: 0, aborted: true }
  }
  return null
}

function readMark(tabId: string, session: Session, body: string): void {
  const split = body.indexOf(';')
  if (split === -1) return
  const id = body.slice(0, split)
  const rest = body.slice(split + 1)

  if (id === '7') {
    const cwd = pathFromFileUrl(rest)
    if (cwd && cwd !== session.cwd) {
      session.cwd = cwd
      scheduleSync(tabId, session)
    }
    return
  }

  if (id !== '133') return
  const [kind, ...params] = rest.split(';')
  let running = session.running
  if (kind === 'A' || kind === 'D') {
    // The prompt is back, or the command has said it is done.
    running = null
  } else if (kind === 'C') {
    // A command has started. Without its command line — a shell integrated
    // by something other than this extension — there is nothing to name it by.
    const encoded = params.find((param) => param.startsWith('cmdline_url='))
    if (encoded === undefined) return
    running = commandLine(encoded.slice('cmdline_url='.length))
  }
  if (running === session.running) return
  // Only a change between running something and not: one command giving way
  // to the next without a prompt between them is still work under way.
  if (running === null || session.running === null) {
    session.activity = running === null ? 'done' : 'working'
    session.activityChanged = true
  }
  session.running = running
  scheduleSync(tabId, session)
}

/**
 * A command line as a row can show it: on one line, and without the spacing
 * it was typed with. Null for one that says nothing, or one that will not
 * decode.
 */
function commandLine(encoded: string): string | null {
  try {
    const line = decodeURIComponent(encoded).replace(/\s+/g, ' ').trim()
    return line === '' ? null : line
  } catch {
    return null
  }
}

/**
 * The path in a `file://` URL, which is how a shell reports where it is. The
 * host is whatever machine it is on and is dropped: these are always local,
 * and the path is the whole of the news.
 */
function pathFromFileUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : null
  } catch {
    return null
  }
}

function scheduleSync(tabId: string, session: Session): void {
  if (session.syncTimer !== null) return
  session.syncTimer = setTimeout(() => {
    session.syncTimer = null
    void sync(tabId, session)
  }, SYNC_MS)
}

/**
 * Writes where the shell is and what it is running into its tab, which is
 * what names its row and what a restored tab opens in — and takes off a
 * one-off command the shell has already typed (see `TerminalTabPayload.run`). One write at a time,
 * each reading the tab afresh, so neither half of the payload is written back
 * over with what it said before; and only when something has actually
 * changed, since each write is an update every window hears about.
 */
async function sync(tabId: string, session: Session): Promise<void> {
  if (session.syncing) {
    session.resync = true
    return
  }
  session.syncing = true
  const { api, log } = context()
  try {
    do {
      session.resync = false
      if (session.ended) return
      const tab = await api.tabs.get({ id: tabId })
      if (!tab || !isTerminalTab(tab) || session.ended) return
      const { cwd, running, activity } = session
      if (session.activityChanged) {
        session.activityChanged = false
        await api.tabs.setActivity({ id: tabId, activity })
      }
      if (
        tab.payload.cwd === cwd &&
        (tab.payload.running ?? null) === running &&
        tab.payload.run === undefined
      ) {
        continue
      }
      // A one-off command is only ever on a tab until its shell has typed it,
      // which a shell with a session has — so every write here takes it off.
      const rest = { ...tab.payload, cwd }
      delete rest.run
      await api.tabs.update({ id: tabId, payload: withRunning(rest, running) })
    } while (session.resync)
  } catch (error) {
    log.error('Failed to update a terminal tab:', error)
  } finally {
    session.syncing = false
  }
}

function withRunning(payload: TerminalTabPayload, running: string | null): TerminalTabPayload {
  const rest = { ...payload }
  delete rest.running
  return running ? { ...rest, running } : rest
}

/**
 * Takes the command off a tab whose shell is not running it any more, so its
 * row goes back to its folder.
 */
async function forgetRunning(api: Client, tabId: string): Promise<void> {
  const tab = await api.tabs.get({ id: tabId })
  if (!tab || !isTerminalTab(tab) || !tab.payload.running) return
  await api.tabs.update({ id: tabId, payload: withRunning(tab.payload, null) })
}

/**
 * The same for every terminal in an open task, when the extension starts: a
 * command a tab still names was running in a shell that went with the last
 * run of the app, and a row should not say `pnpm dev` over a shell that has
 * not started. Settled tasks' terminals were put right as they settled.
 */
export async function forgetStaleCommands(): Promise<void> {
  const { api, log } = context()
  try {
    const projects = await api.projects.list({})
    const tasks = await Promise.all(
      projects.map((project) => api.tasks.list({ projectId: project.id, status: 'open' }))
    )
    const tabs = await Promise.all(tasks.flat().map((task) => api.tabs.list({ taskId: task.id })))
    await Promise.all(
      tabs
        .flat()
        .filter((tab) => isTerminalTab(tab) && tab.payload.running && !sessions.has(tab.id))
        .map((tab) => forgetRunning(api, tab.id))
    )
  } catch (error) {
    log.error('Failed to clear the commands of terminals that have stopped:', error)
  }
}

/** Keystrokes, and anything else the view has for the shell's standard input. */
function write(tabId: string, data: string): void {
  const session = sessions.get(tabId)
  if (!session || session.exited) return
  session.pty.write(data)
}

/**
 * Tells the shell how big its window is. Programs that draw a full screen —
 * an editor, a pager, anything with a progress bar — redraw off this, so it is
 * sent whenever the view is measured rather than only when it settles.
 */
function resize(tabId: string, cols: number, rows: number): void {
  const session = sessions.get(tabId)
  if (!session || session.exited) return
  resizeSession(session, cols, rows)
}

function resizeSession(session: Session, cols: number, rows: number): void {
  try {
    session.pty.resize(cols, rows)
  } catch (error) {
    // The shell can exit between the measurement and this call.
    context().log.error('Failed to resize a terminal:', error)
  }
}

/**
 * Ends a session and forgets it. Called when a terminal tab stops — closed, or
 * its task settled — which includes a tab being closed *because* its shell
 * exited, where there is nothing left to kill and this only drops what is held.
 */
export function destroyTerminal(tabId: string): void {
  const session = sessions.get(tabId)
  if (!session) return
  const { api, log } = context()
  endSession(tabId, session)
  // A settled task's row should read as its folder, not as a command that
  // is no longer running in it.
  if (session.running) {
    void forgetRunning(api, tabId).catch((error: unknown) =>
      log.error('Failed to clear a stopped terminal:', error)
    )
  }
}

function endSession(tabId: string, session: Session): void {
  sessions.delete(tabId)

  // Before the kill below, so the exit it provokes is recognised as this
  // extension's doing rather than taken for a shell the user walked out of.
  session.ended = true

  if (session.flush !== null) clearTimeout(session.flush)
  if (session.syncTimer !== null) clearTimeout(session.syncTimer)
  if (session.exited) return

  try {
    session.pty.kill()
  } catch (error) {
    // Already gone; the exit handler simply never had anything to report.
    context().log.error('Failed to kill a terminal:', error)
  }
}

/**
 * Kills every session. The shells are children of the app's process and would
 * otherwise be reparented and left running with nothing attached to them.
 *
 * The tabs are left naming whatever was running: this is the app quitting or
 * the extension going, neither of which waits for a write, and the next start
 * puts them right (see `forgetStaleCommands`).
 */
export function destroyAllTerminals(): void {
  for (const [tabId, session] of [...sessions]) endSession(tabId, session)
}
