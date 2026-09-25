import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { VscodeTab } from '../shared/tab'
import { context } from './context'
import { ensureWorkspaceFile } from './workspaces'

/**
 * The editor behind VS Code tabs.
 *
 * Not an imitation of VS Code and not a fork of it: the user's own installed
 * copy ships a CLI that serves the real web workbench (`code serve-web`), and
 * this starts one and hands back an address. A tab is then a web view pointed
 * at localhost — see `WebViewDeclaration` in the SDK, and ../index.ts.
 *
 * What that buys, over embedding an editor component, is everything that makes
 * VS Code worth having: the real extension marketplace, a language server per
 * language, a terminal, git, and — the reason it is worth doing this way at all
 * — Settings Sync. Signing into GitHub inside the workbench pulls down the
 * user's settings, keybindings, snippets, theme and extensions from the same
 * account their desktop VS Code syncs with, so the tab is their editor rather
 * than a fresh one that resembles it. Nothing here copies any of that across;
 * it would be a worse copy of something the editor already does properly.
 *
 * One server serves every tab, and one browser origin holds the editor's stored
 * sign-in and settings for all of them. What each tab gets of its own is a
 * workspace — see ./workspaces.ts.
 */

/** Where the server ended up, once it is answering. */
type VscodeStatus =
  /**
   * Ready. `origin` is the workbench's address, which never changes while the
   * app runs, and `token` is what every request to it has to carry.
   */
  | { ok: true; origin: string; token: string }
  /**
   * Not ready, and the message is shown as is. Two quite different failures
   * arrive this way — VS Code is not installed, or the server would not
   * start — and neither is anything the app can do something about on the
   * user's behalf, so both are worth saying plainly rather than retrying.
   */
  | { ok: false; message: string }

/**
 * Where the port and the connection token are remembered, in the extension's
 * storage.
 *
 * Both have to survive a restart, and the port especially. The workbench keeps
 * its user data — which after signing in includes the Settings Sync session
 * itself — in browser storage keyed on the origin it was served from, and the
 * origin is the port. A port picked afresh each launch would therefore be a new
 * editor each launch: signed out, default theme, no extensions. So it is chosen
 * once and kept.
 */
const PORT_KEY = 'port'
const TOKEN_KEY = 'connectionToken'

/**
 * The two names for the same interface, which have to be kept apart because the
 * server and the workbench disagree about which one they will take.
 *
 * The server is *bound* to the numeric address: `serve-web --host` parses its
 * argument as an IP and refuses a hostname outright, so `localhost` there is
 * not a slower path but a server that never starts.
 *
 * The workbench is *loaded* from the name. VS Code's GitHub authentication
 * extension decides whether it is in a CORS-free environment by matching the
 * workbench's authority against `/^localhost/`, and the numeric address fails
 * that test and takes a different path through the sign-in flow. Since signing
 * in is the whole point of this module, the view is pointed at the name the
 * extension expects.
 *
 * Both resolve to the same socket, so this costs nothing. It is only ever a
 * question of which spelling each side is willing to accept, and the answer
 * happens to be a different one on each side. The workbench's own
 * `remoteAuthority` follows whichever spelling it was loaded from, so loading
 * by name is also what keeps the origin — and with it everything the editor
 * stores — stable.
 */
const BIND_HOST = '127.0.0.1'
const HOST = 'localhost'

/**
 * How long to wait for the server to start answering.
 *
 * Generous because the first run is not a start at all: the CLI downloads the
 * web server it is about to run — some hundreds of megabytes — before it binds
 * anything. Every run after that takes a few seconds, so this is only ever the
 * budget for the first one.
 */
const READY_TIMEOUT_MS = 10 * 60 * 1000
const READY_POLL_MS = 400

/** The running server, and the address and token it was started with. */
let child: ChildProcess | undefined
let origin: string | undefined
let connectionToken: string | undefined

/**
 * The start now in flight. Every tab asks for the server as it opens, and on a
 * launch that restores four of them all four ask at once; without this they
 * would race to spawn four servers on the same port and three would lose.
 */
let starting: Promise<VscodeStatus> | undefined

/**
 * Where the user's VS Code might be, in the order worth trying.
 *
 * The CLI inside the application bundle rather than the `code` command, because
 * the command is a shim the user has to have installed by hand from inside VS
 * Code — plenty of working installs have never had it — while the bundle is
 * always there. `code` on the PATH is still tried, last, for the installs that
 * are somewhere none of this guessed.
 */
function candidateClis(): string[] {
  const home = homedir()
  if (process.platform === 'darwin') {
    return [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      join(home, 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders',
      join(
        home,
        'Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders'
      )
    ]
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData/Local')
    return [
      join(local, 'Programs/Microsoft VS Code/bin/code.cmd'),
      'C:/Program Files/Microsoft VS Code/bin/code.cmd'
    ]
  }
  return ['/usr/share/code/bin/code', '/usr/bin/code', '/snap/bin/code']
}

/** The first candidate that is actually there, or the bare command as a last resort. */
function findCli(): string | null {
  const found = candidateClis().find((path) => existsSync(path))
  if (found) return found
  // Nothing at a known path. `code` may still resolve through the PATH, and
  // spawning it is the only way to find out — a failure there is reported the
  // same way a missing install is.
  return process.platform === 'win32' ? 'code.cmd' : 'code'
}

/** A port nothing is listening on, asked of the OS rather than guessed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on('error', reject)
    probe.listen(0, BIND_HOST, () => {
      const address = probe.address()
      if (address && typeof address === 'object') {
        const { port } = address
        probe.close(() => resolve(port))
      } else {
        probe.close(() => reject(new Error('Could not find a free port')))
      }
    })
  })
}

/** The workbench's address, which is also the origin its storage is keyed on. */
function originFor(port: number): string {
  return `http://${HOST}:${port}`
}

/** What the workbench calls itself in the document it serves. */
const WORKBENCH_MARKER = 'vscode-workbench-web-configuration'

/** The cookie the server keeps a browser's connection token in. */
const TOKEN_COOKIE = 'vscode-tkn'

/**
 * Whether a server is answering on `port`, as ours, and ready to be looked at.
 *
 * All three at once, because the one request settles all three and the server
 * says something different in each case:
 *
 * - Nothing is listening: the request throws.
 * - Ours, but still starting up: `202`, with a body that is not the workbench.
 * - A VS Code server that is not ours: the token is refused with a `403`.
 * - Ours and ready: the token is accepted, and what comes back is the workbench.
 *
 * The token goes as the cookie the server would otherwise have set. A view
 * hands it over as a query parameter, and the server answers `?tkn=` with a
 * `302` that sets `vscode-tkn` and drops the parameter, keeping every other one
 * — which is what lets a tab's `?workspace=` survive the exchange. A probe has
 * no cookie jar to carry that across the redirect, so it skips the exchange and
 * presents the cookie itself.
 *
 * `200` exactly rather than any success, because `202` is a success too and is
 * precisely the case this must not accept.
 *
 * Asked before spawning as well as after, so that a server left behind by a
 * crash is adopted rather than fought with. Adopting matters more than
 * tidiness: the alternative is moving to a free port, and a new port is a new
 * origin, which signs the user out of the editor they were using a moment ago.
 */
async function answersAsOurs(port: number, token: string): Promise<boolean> {
  try {
    // By the address it is bound to rather than the name the view loads: a
    // probe keeps nothing, so the origin is no concern of its, and `localhost`
    // can resolve to the IPv6 loopback, where nothing is listening.
    const response = await fetch(`http://${BIND_HOST}:${port}/`, {
      headers: { cookie: `${TOKEN_COOKIE}=${token}` },
      redirect: 'manual'
    })
    if (response.status !== 200) return false
    // A 200 alone is still not enough — anything at all could be listening here.
    return (await response.text()).includes(WORKBENCH_MARKER)
  } catch {
    return false
  }
}

/** Polls until the server answers, or until it has had long enough not to. */
async function waitForReady(port: number, token: string, since: number): Promise<boolean> {
  while (Date.now() - since < READY_TIMEOUT_MS) {
    if (await answersAsOurs(port, token)) return true
    // A server that exited is not going to start answering, and waiting out the
    // full timeout for it would be ten minutes of nothing.
    if (child && child.exitCode !== null) return false
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
  return false
}

/**
 * Where a tab's view should point: starts the server if it is not already up,
 * and answers with the address that opens the tab's folder. Throws with what to
 * tell the user when there is nowhere — which is what the tab then says.
 *
 * Safe to call from every tab and on every launch — the first call does the
 * work and the rest wait on it — which matters because a launch restoring four
 * editor tabs asks four times at once.
 *
 * `workspace` is what makes one tab's window different from another's, and the
 * token is what makes the request acceptable at all. Both are query parameters
 * on the one origin, which is what keeps every tab sharing the editor's stored
 * sign-in and settings while none of them shares its window state.
 */
export async function editorUrl(tab: VscodeTab): Promise<string> {
  const status = await startVscodeServer()
  if (status.ok === false) throw new Error(status.message)

  let workspace: string
  try {
    workspace = await ensureWorkspaceFile(tab.id, tab.payload.folderPath)
  } catch (error) {
    throw new Error(
      `Could not prepare the workspace: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const params = new URLSearchParams({ workspace, tkn: status.token })
  return `${status.origin}/?${params.toString()}`
}

async function startVscodeServer(): Promise<VscodeStatus> {
  if (origin && connectionToken) return { ok: true, origin, token: connectionToken }
  starting ??= start().finally(() => {
    starting = undefined
  })
  return starting
}

async function start(): Promise<VscodeStatus> {
  const cli = findCli()
  if (!cli) {
    return { ok: false, message: 'Visual Studio Code is not installed.' }
  }

  const { storage, dataDir } = context()

  // Chosen once and kept, for the reason given on `PORT_KEY`.
  const token = (await storage.get<string>(TOKEN_KEY)) ?? randomBytes(20).toString('hex')
  const remembered = await storage.get<number>(PORT_KEY)

  // A server from a previous run of this app that outlived it. Adopting it
  // keeps the origin, and with it the editor's sign-in.
  if (remembered && (await answersAsOurs(remembered, token))) {
    await Promise.all([storage.set(TOKEN_KEY, token), storage.set(PORT_KEY, remembered)])
    origin = originFor(remembered)
    connectionToken = token
    return { ok: true, origin, token }
  }

  const port = remembered ?? (await freePort())
  await Promise.all([storage.set(TOKEN_KEY, token), storage.set(PORT_KEY, port)])

  const started = Date.now()
  const spawned = spawn(
    cli,
    [
      'serve-web',
      '--host',
      BIND_HOST,
      '--port',
      String(port),
      '--connection-token',
      token,
      // The terms are the VS Code Server's, and the prompt they replace is one
      // asked on a terminal nobody is looking at. Accepting on the user's
      // behalf is defensible only because the software being served is the copy
      // they installed and agreed to already.
      '--accept-server-license-terms',
      // Kept apart from the desktop app's own extension directory. The two
      // would otherwise write to the same folder whenever both are open, and
      // there is nothing to gain by sharing it: Settings Sync populates this
      // one from the user's account within moments of the first sign-in.
      '--server-data-dir',
      join(dataDir, 'server')
    ],
    // A group of its own, so the whole tree can be stopped at once (see
    // `stopTree`). Windows has no groups and is stopped another way.
    { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }
  )

  child = spawned

  // Nothing reads the server's output, but something has to drain it: a pipe
  // nobody empties fills, and a full pipe stops the process writing to it.
  spawned.stdout?.resume()
  spawned.stderr?.resume()

  // A failure to spawn arrives here rather than as a throw, and is the shape
  // `code` not being on the PATH takes.
  let spawnError: string | undefined
  spawned.on('error', (error) => {
    spawnError = error.message
  })
  spawned.on('exit', () => {
    // Only if it is still the current one: a later start has its own child, and
    // an old one exiting says nothing about it.
    if (child === spawned) {
      child = undefined
      origin = undefined
      connectionToken = undefined
    }
  })

  if (await waitForReady(port, token, started)) {
    origin = originFor(port)
    connectionToken = token
    return { ok: true, origin, token }
  }

  stopTree(spawned)
  if (child === spawned) child = undefined
  return {
    ok: false,
    message: spawnError
      ? `Could not start the VS Code server: ${spawnError}`
      : 'The VS Code server did not start.'
  }
}

/**
 * Stops the server. Called on the way out for the reason shells are killed
 * there: it is a child of this process rather than of the tabs that used it, so
 * quitting without it leaves a web server with filesystem and shell access
 * running under launchd with nothing attached to it.
 */
export function destroyVscodeServer(): void {
  if (child) stopTree(child)
  child = undefined
  origin = undefined
  connectionToken = undefined
}

/**
 * Stops a server and everything it started.
 *
 * Not `child.kill()`, which reaches only the process spawned — and that is the
 * `code` launcher, a shell script, which hands the real work to the CLI and
 * that to the `code-tunnel` binary that actually serves. Killing the script
 * leaves the server answering on the port with nothing attached to it, which
 * is the leak `destroyVscodeServer` is there to prevent. So the server runs in
 * a process group of its own and the group is what is stopped; on Windows,
 * which has no groups, `taskkill` walks the tree instead.
 */
function stopTree(process_: ChildProcess): void {
  const { pid } = process_
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGTERM')
    }
  } catch {
    // Already gone, which is what was wanted.
  }
}
