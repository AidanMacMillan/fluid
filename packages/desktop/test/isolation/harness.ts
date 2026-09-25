/**
 * The installed-extension sandbox, tested in Electron: run by run.mjs, which
 * builds the app and this harness and starts it (`pnpm test:isolation`).
 *
 * It installs probe.js — an extension that tries every way out of its page it
 * can think of — through the real proxy, sessions, preload and page, with a
 * fake context standing in for the app, and checks that what it may do works
 * and what it may not is refused. Also the pieces around it: snapshots, the
 * manifest's rules, the command runner and the API policy.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, protocol, webContents as allWebContents } from 'electron'
import {
  INSTALLED_SCHEME_PRIVILEGES,
  manifestOf,
  publishSnapshot,
  snapshotFolder,
  permissionsOf
} from '../../src/main/extensions/installed'
import { isolatedExtension } from '../../src/main/extensions/isolation/proxy'
import {
  EXTENSION_HOST_PRELOAD,
  extensionHostUrl,
  fetchFor,
  hostPartition,
  prepareHostSession
} from '../../src/main/extensions/isolation/sessions'
import type { FetchResponse } from '../../src/main/extensions/isolation/protocol'
import { runCommand } from '../../src/main/extensions/commands'
import { checkIsolatedCall, hears, isolate, mayReach } from '../../src/main/api/isolation-policy'
import { installedFileUrl } from '../../src/main/extensions/installed'

const userData = mkdtempSync(join(tmpdir(), 'fluid-harness-'))
app.setPath('userData', userData)
app.dock?.hide()
protocol.registerSchemesAsPrivileged([
  INSTALLED_SCHEME_PRIVILEGES,
  { scheme: 'probe-media', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const results: Record<string, unknown> = {}
let failures = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  results[name] = ok ? 'PASS' : { FAIL: detail }
  if (!ok) failures++
}

async function main(): Promise<void> {
  // --- Snapshots ---------------------------------------------------------
  const folder = join(userData, 'installed-extensions', 'probe')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'main.mjs'), readFileSync(join(__dirname, 'probe.mjs')))
  writeFileSync(
    join(folder, 'fluid-extension.json'),
    JSON.stringify({
      id: 'probe',
      name: 'Probe',
      version: '1.0.0',
      sdk: '^0.2.0',
      main: 'main.mjs',
      schemes: [{ scheme: 'probe-media', privileges: { standard: true } }],
      permissions: {
        hosts: ['api.allowed.test', '*.wild.test'],
        commands: ['echo'],
        extensions: ['friend']
      }
    })
  )
  writeFileSync(join(folder, '.DS_Store'), 'finder noise')
  const snapshot = snapshotFolder(folder)
  const manifest = manifestOf(snapshot)
  check('snapshot ignores dotfiles', !snapshot.files.has('.DS_Store'))
  writeFileSync(join(folder, '.DS_Store'), 'more finder noise')
  check('digest stable across dotfile changes', snapshotFolder(folder).digest === snapshot.digest)
  writeFileSync(join(folder, 'extra.js'), 'x')
  check('digest changes when a file is added', snapshotFolder(folder).digest !== snapshot.digest)
  rmSync(join(folder, 'extra.js'))
  const linked = join(userData, 'linked')
  mkdirSync(linked)
  symlinkSync('/etc/hosts', join(linked, 'hosts'))
  try {
    snapshotFolder(linked)
    check('symlinks refused', false)
  } catch (e) {
    check('symlinks refused', /link/.test(String(e)))
  }
  try {
    manifestOf({
      digest: '',
      bytes: 0,
      files: new Map([
        [
          'fluid-extension.json',
          Buffer.from(
            JSON.stringify({
              ...manifest,
              schemes: [{ scheme: 'x', privileges: { bypassCSP: true } }]
            })
          )
        ]
      ])
    })
    check('bypassCSP refused', false)
  } catch {
    check('bypassCSP refused', true)
  }
  try {
    manifestOf({
      digest: '',
      bytes: 0,
      files: new Map([
        ['fluid-extension.json', Buffer.from(JSON.stringify({ ...manifest, main: '../x.mjs' }))]
      ])
    })
    check('escaping paths refused', false)
  } catch {
    check('escaping paths refused', true)
  }
  try {
    manifestOf({
      digest: '',
      bytes: 0,
      files: new Map([
        [
          'fluid-extension.json',
          Buffer.from(JSON.stringify({ ...manifest, permissions: { commands: ['/bin/sh'] } }))
        ]
      ])
    })
    check('command paths refused in manifest', false)
  } catch {
    check('command paths refused in manifest', true)
  }

  const withSchemes = (schemes: unknown): boolean => {
    try {
      manifestOf({
        digest: '',
        bytes: 0,
        files: new Map([
          ['fluid-extension.json', Buffer.from(JSON.stringify({ ...manifest, schemes }))],
          ['main.mjs', Buffer.from('')]
        ])
      })
      return true
    } catch {
      return false
    }
  }
  check('scheme file refused', !withSchemes([{ scheme: 'file' }]))
  check('scheme https refused', !withSchemes([{ scheme: 'https' }]))
  check('scheme without its id refused', !withSchemes([{ scheme: 'media' }]))
  check('scheme of another id refused', !withSchemes([{ scheme: 'slack-media' }]))
  check('scheme with its id accepted', withSchemes([{ scheme: 'probe-media' }]))

  // --- Commands ------------------------------------------------------------
  const echoed = await runCommand('echo', ['a b', '$HOME', ';', 'rm'])
  check('commands run without a shell', echoed.stdout === 'a b $HOME ; rm\n', echoed)
  try {
    await runCommand('definitely-not-a-command-xyz', [])
    check('missing command rejects', false)
  } catch (e) {
    check('missing command rejects', (e as { code?: string }).code === 'ENOENT', e)
  }
  try {
    await runCommand('sleep', ['5'], { timeoutMs: 200 })
    check('timeout kills', false)
  } catch (e) {
    check('timeout kills', (e as { code?: string }).code === 'ETIMEDOUT', e)
  }
  const input = await runCommand('cat', [], { input: 'piped' })
  check('stdin is written', input.stdout === 'piped', input)
  process.env.FLUID_TEST_SECRET = 'do-not-leak'
  const minimal = await runCommand('env', [], {}, { minimalEnvironment: true })
  check(
    'installed commands get a minimal environment',
    !minimal.stdout.includes('do-not-leak') && minimal.stdout.includes('PATH='),
    minimal.stdout.slice(0, 200)
  )
  const full = await runCommand('env', [])
  check('built-in commands keep the environment', full.stdout.includes('do-not-leak'))

  // --- API policy ------------------------------------------------------------
  isolate('probe', { extensions: ['friend'], hosts: ['api.allowed.test', '*.wild.test'] })
  const refused = async (method: string, input: unknown): Promise<boolean> => {
    try {
      await checkIsolatedCall('probe', method, input)
      return false
    } catch {
      return true
    }
  }
  check('policy refuses files.import', await refused('files.import', { path: '/etc/hosts' }))
  check(
    'policy refuses settings.set',
    await refused('settings.set', { key: 'extensions.slack.enabled', value: false })
  )
  check(
    'policy refuses extensions.setEnabled',
    await refused('extensions.setEnabled', { id: 'slack', enabled: false })
  )
  check(
    'policy refuses calling an undeclared extension',
    await refused('extensions.call', { extensionId: 'slack', method: 'reply' })
  )
  check(
    'policy allows calling a declared extension',
    !(await refused('extensions.call', { extensionId: 'friend', method: 'ping' }))
  )
  check(
    'policy refuses opening a terminal tab',
    await refused('tabs.open', {
      taskId: 't',
      tab: { type: 'terminal.shell', payload: { command: 'rm -rf ~' } }
    })
  )
  check(
    'policy allows its own tabs',
    !(await refused('tabs.open', { taskId: 't', tab: { type: 'probe.pane', payload: {} } }))
  )
  check(
    'policy allows browser tabs',
    !(await refused('tabs.open', {
      taskId: 't',
      tab: { type: 'browser', payload: { url: 'https://x.test' } }
    }))
  )
  check('policy allows tasks.list', !(await refused('tasks.list', { projectId: 'p' })))
  check('policy: settings events not heard', !hears('probe', { type: 'setting.changed' }))
  check('policy: other events heard', hears('probe', { type: 'task.created' }))
  check('policy: may reach a declared host', mayReach('probe', 'https://api.allowed.test/x'))
  check('policy: may reach a wildcard host', mayReach('probe', 'https://deep.wild.test/'))
  check('policy: may not reach the bare wildcard domain', !mayReach('probe', 'https://wild.test/'))
  check('policy: may not reach another host', !mayReach('probe', 'https://evil.test/'))
  check('policy: may not reach over http', !mayReach('probe', 'http://api.allowed.test/'))
  check('policy: may not reach another port', !mayReach('probe', 'https://api.allowed.test:444/'))
  check(
    'policy ignores built-ins',
    await (async () => {
      try {
        await checkIsolatedCall('slack', 'files.import', {})
        return true
      } catch {
        return false
      }
    })()
  )

  // --- The network, for real (opt in: it needs the internet) ---------------
  if (process.env.LIVE_NETWORK) {
    const redirect = await fetchFor('probe', {
      url: 'https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F&status_code=302',
      method: 'GET',
      headers: [],
      body: null
    })
    check(
      'live redirect comes back unfollowed',
      redirect.status === 302 &&
        redirect.headers.some(([n, v]) => n === 'location' && v === 'https://example.com/'),
      redirect.status
    )
    const page = await fetchFor('probe', {
      url: 'https://example.com/',
      method: 'GET',
      headers: [],
      body: null
    })
    check('live request answers', page.status === 200 && page.body.byteLength > 0, page.status)
  }

  // --- The sandboxed page ----------------------------------------------------
  publishSnapshot('probe', snapshot)
  prepareHostSession('probe')

  const registered: Record<string, unknown[]> = {
    taskTypes: [],
    tabTypes: [],
    bookmarks: [],
    jobs: [],
    connectors: [],
    protocols: []
  }
  const rpc = new Map<string, (input: unknown) => unknown>()
  const storage = new Map<string, unknown>()
  const disposers: (() => unknown)[] = []
  const opened: string[] = []
  const eventListeners = new Set<(event: unknown) => void>()
  let crashed: string | null = null
  const disposable = { dispose: () => {} }
  const ctx = {
    id: 'probe',
    api: {
      call: async (method: string, input: unknown) => ({ method, input }),
      onAny: (listener: (event: unknown) => void) => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      }
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => void storage.set(key, value),
      delete: async (key: string) => void storage.delete(key),
      keys: async () => [...storage.keys()]
    },
    secrets: {
      get: () => null,
      set: () => {},
      delete: () => {},
      has: () => false,
      status: () => ({ available: true, configured: true, updatedAt: '2026-01-01T00:00:00.000Z' })
    },
    dataDir: join(userData, 'data'),
    schedule: (job: unknown) => {
      registered.jobs.push(job)
      return disposable
    },
    bookmarks: {
      provide: (provider: () => unknown) => {
        registered.bookmarks.push(provider)
        return disposable
      },
      changed: () => {}
    },
    taskTypes: {
      register: (type: unknown) => {
        registered.taskTypes.push(type)
        return disposable
      }
    },
    tabTypes: {
      register: (type: unknown) => {
        registered.tabTypes.push(type)
        return disposable
      }
    },
    fileViewers: { register: () => disposable },
    views: {
      onConnect: (tabType: string, listener: unknown) => {
        registered.connectors.push({ tabType, listener })
        return disposable
      }
    },
    rpc: {
      handle: (method: string, handler: (input: unknown) => unknown) => {
        rpc.set(method, handler)
        return disposable
      }
    },
    extensions: {
      call: async (id: string, method: string, input: unknown) =>
        `${id}.${method}(${JSON.stringify(input)})`
    },
    protocols: {
      handle: (scheme: string, handler: unknown) => {
        registered.protocols.push({ scheme, handler })
        return disposable
      }
    },
    openExternal: async (url: string) => void opened.push(url),
    process: {
      run: async () => {
        throw new Error('not used')
      }
    },
    onDispose: (dispose: () => unknown) => void disposers.push(dispose),
    log: {
      info: (...a: unknown[]) => console.log('[probe]', ...a),
      warn: (...a: unknown[]) => console.log('[probe:warn]', ...a),
      error: (...a: unknown[]) => console.log('[probe:error]', ...a)
    }
  }

  const extension = isolatedExtension({
    manifest,
    permissions: permissionsOf(manifest),
    pageUrl: extensionHostUrl(),
    preload: EXTENSION_HOST_PRELOAD,
    mainUrl: installedFileUrl('probe', manifest.main),
    partition: hostPartition('probe'),
    secrets: () => ({ token: { value: 's3cret', updatedAt: '2026-01-01T00:00:00.000Z' } }),
    secretsAvailable: () => true,
    runCommand,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = (
        body: string,
        status = 200,
        headers: [string, string][] = []
      ): FetchResponse => ({
        url: request.url,
        status,
        statusText: 'OK',
        headers: [['content-type', 'text/plain'], ...headers] as [string, string][],
        body: new TextEncoder().encode(body)
      })
      if (url.pathname === '/hello')
        return text(
          `hello ${request.method} ${new TextDecoder().decode(request.body ?? new Uint8Array())}`
        )
      if (url.pathname === '/redirect-in') return text('', 302, [['location', '/hello']])
      if (url.pathname === '/redirect-out')
        return text('', 302, [['location', 'https://evil.test/steal']])
      return text('not found', 404)
    },
    onCrash: (reason) => {
      crashed = reason
    },
    devTools: false
  })

  await extension.activate(ctx as never)
  check(
    'activation reports settings',
    extension.settings?.label === 'Probe settings',
    extension.settings
  )
  check('activation reports description', extension.description === 'Tries every way out.')

  const globals = (await rpc.get('globals')!(undefined)) as Record<string, string>
  check('no require in page', globals.require === 'undefined', globals)
  check('no process in page', globals.process === 'undefined', globals)
  check('no Buffer in page', globals.buffer === 'undefined', globals)

  check('rpc round trip', JSON.stringify(await rpc.get('echo')!({ a: 1 })) === '{"echoed":{"a":1}}')

  const probe = (await rpc.get('probe')!(undefined)) as Record<
    string,
    { ok: boolean; value?: unknown; error?: string; code?: unknown }
  >
  const expectOk = (name: string, value?: unknown): void =>
    check(
      `probe ${name}`,
      probe[name]?.ok === true &&
        (value === undefined || JSON.stringify(probe[name].value) === JSON.stringify(value)),
      probe[name]
    )
  const expectBlocked = (name: string): void =>
    check(`probe ${name} blocked`, probe[name]?.ok === false, probe[name])
  expectOk('fetchAllowed', { status: 200, text: 'hello POST x' })
  expectOk('fetchRedirectInside', { status: 200, text: 'hello GET ' })
  expectBlocked('fetchRedirectOut')
  expectOk('fetchWildcard', 200)
  expectBlocked('fetchDenied')
  expectBlocked('fetchHttp')
  expectBlocked('fetchPort')
  expectBlocked('fetchFile')
  expectBlocked('xhr')
  expectBlocked('image')
  expectBlocked('websocket')
  expectBlocked('importRemote')
  expectBlocked('importData')
  expectBlocked('eval')
  expectBlocked('newFunction')
  expectBlocked('iframe')
  expectBlocked('worker')
  check(
    'probe frameAppPage blocked',
    probe.frameAppPage?.ok === false || probe.frameAppPage?.value === 'undefined',
    probe.frameAppPage
  )
  expectOk('runAllowed', 'hi $HOME\n')
  expectBlocked('runDenied')
  expectBlocked('runPath')
  expectOk('callAllowed', 'friend.ping(1)')
  expectBlocked('callDenied')
  expectOk('apiCall', { method: 'tasks.list', input: { projectId: 'p1' } })
  expectOk('secret', 's3cret')
  expectOk('otherSecret', null)
  expectOk('storage', { a: 1 })
  expectBlocked('openFile')
  expectOk('openWeb')
  expectBlocked('rawBridgeRun')
  expectBlocked('rawBridgeRegisterBadBookmark')
  expectBlocked('rawBridgeRegexSchema')
  expectBlocked('peerConnection')
  check(
    'openExternal only got the web page',
    JSON.stringify(opened) === '["https://example.com"]',
    opened
  )

  // Registrations, called back through the proxy.
  const taskType = registered.taskTypes[0] as {
    id: string
    actions: (task: unknown) => Promise<{ id: string; label: string; run: () => Promise<void> }[]>
  }
  const actions = await taskType.actions({ id: 't1', title: 'Fix it' })
  check('task actions come back', actions[0]?.label === 'Go Fix it', actions)
  await actions[0].run()
  check('task action runs in the page', storage.get('ran') === 'Fix it', storage.get('ran'))

  const tabType = registered.tabTypes[0] as {
    payload: { safeParse: (v: unknown) => { success: boolean } }
    menu: (tab: unknown) => Promise<{ label?: string; click?: () => Promise<void> }[]>
  }
  check('payload schema rebuilt: accepts', tabType.payload.safeParse({ thing: 'x' }).success)
  check('payload schema rebuilt: refuses', !tabType.payload.safeParse({ thing: 1 }).success)
  const menu = await tabType.menu({ id: 'tab1' })
  await menu[0].click!()
  check('menu click runs in the page', storage.get('poked') === true)

  const bookmarks = (registered.bookmarks[0] as () => unknown[])()
  check(
    'bookmarks come through',
    JSON.stringify(bookmarks) === '[{"id":"b1","label":"Example","url":"https://example.com/"}]',
    bookmarks
  )

  const job = registered.jobs[0] as { intervalMs: number; run: () => Promise<void> }
  await job.run()
  check('scheduled job runs in the page', storage.get('ticked') === true)

  const connector = registered.connectors[0] as { tabType: string; listener: (c: unknown) => void }
  const replies: unknown[] = []
  let onMessage: ((m: unknown) => void) | null = null
  let onGone: (() => void) | null = null
  connector.listener({
    tabId: 'tab9',
    connected: true,
    post: (m: unknown) => replies.push(m),
    onMessage: (l: (m: unknown) => void) => {
      onMessage = l
      return disposable
    },
    onDisconnect: (l: () => void) => {
      onGone = l
      return disposable
    }
  })
  await new Promise((r) => setTimeout(r, 200))
  onMessage!({ ping: 1 })
  await new Promise((r) => setTimeout(r, 300))
  check(
    'view connection round trip',
    JSON.stringify(replies) === '[{"pong":{"ping":1},"tabId":"tab9"}]',
    replies
  )
  onGone!()

  const media = registered.protocols[0] as {
    scheme: string
    handler: (r: Request) => Promise<Response>
  }
  const response = await media.handler(new Request('probe-media://x/avatar.png'))
  check('protocol handled in the page', (await response.text()) === 'media:/avatar.png')

  // Everything the page ever requested went through its own session's lock.
  const host = allWebContents
    .getAllWebContents()
    .find((c) => c.getURL().includes('extension-host.html'))
  check('host page exists', host !== undefined)

  // Crash: the page dies, the host is told.
  host!.forcefullyCrashRenderer()
  await new Promise((r) => setTimeout(r, 1000))
  check('crash is reported', typeof crashed === 'string', crashed)
  check(
    'calls after a crash reject',
    await (async () => {
      try {
        await rpc.get('echo')!(1)
        return false
      } catch {
        return true
      }
    })()
  )

  // A fresh start, then a clean stop: the page goes, with everything in it.
  for (const d of disposers.splice(0)) await d()
  await extension.activate(ctx as never)
  const second = allWebContents
    .getAllWebContents()
    .filter((c) => c.getURL().includes('extension-host.html') && !c.isDestroyed())
  check('restart makes one page', second.length === 1, second.length)
  for (const d of disposers.splice(0)) await d()
  await new Promise((r) => setTimeout(r, 300))
  const left = allWebContents
    .getAllWebContents()
    .filter((c) => c.getURL().includes('extension-host.html') && !c.isDestroyed())
  check('stop closes the page', left.length === 0, left.length)
  check('onDispose ran in the page', storage.get('disposed') === true)
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (error) {
    console.log('HARNESS ERROR', error)
    failures++
  }
  for (const [name, result] of Object.entries(results))
    console.log(
      result === 'PASS' ? 'PASS' : 'FAIL',
      name,
      result === 'PASS' ? '' : JSON.stringify(result)
    )
  console.log(`${Object.keys(results).length} checks, ${failures} failed`)
  rmSync(userData, { recursive: true, force: true })
  app.exit(failures ? 1 : 0)
})
