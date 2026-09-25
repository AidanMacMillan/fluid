// An installed extension that tries every way out of its sandbox it can think
// of, for harness.ts. Its manifest (written by the harness) allows fetching
// from api.allowed.test and *.wild.test, running echo, and calling the friend
// extension; everything else it tries should be refused.
import { z } from 'zod'

const extension = {
  id: 'probe',
  name: 'Probe',
  description: 'Tries every way out.',
  settings: { label: 'Probe settings' },
  async activate(ctx) {
    ctx.rpc.handle('echo', (input) => ({ echoed: input }))
    ctx.rpc.handle('globals', () => ({
      require: typeof require,
      process: typeof process,
      buffer: typeof Buffer,
      ipc: typeof window.fluidHost
    }))
    ctx.rpc.handle('probe', async () => {
      const r = {}
      const attempt = async (name, fn) => {
        try {
          const value = await Promise.race([
            fn(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('never settled')), 3000))
          ])
          r[name] = { ok: true, value }
        } catch (e) {
          r[name] = { ok: false, error: String(e?.message ?? e), code: e?.code }
        }
      }
      await attempt('fetchAllowed', async () => {
        const res = await fetch('https://api.allowed.test/hello', { method: 'POST', body: 'x' })
        return { status: res.status, text: await res.text() }
      })
      await attempt('fetchRedirectInside', async () => {
        const res = await fetch('https://api.allowed.test/redirect-in')
        return { status: res.status, text: await res.text() }
      })
      await attempt(
        'fetchRedirectOut',
        async () => (await fetch('https://api.allowed.test/redirect-out')).status
      )
      await attempt(
        'fetchWildcard',
        async () => (await fetch('https://a.b.wild.test/hello')).status
      )
      await attempt('fetchDenied', async () => (await fetch('https://evil.test/')).status)
      await attempt('fetchHttp', async () => (await fetch('http://api.allowed.test/')).status)
      await attempt('fetchPort', async () => (await fetch('https://api.allowed.test:8443/')).status)
      await attempt('fetchFile', async () => (await fetch('file:///etc/hosts')).text())
      await attempt(
        'xhr',
        () =>
          new Promise((resolve, reject) => {
            const x = new XMLHttpRequest()
            x.onload = () => resolve(x.status)
            x.onerror = () => reject(new Error('xhr blocked'))
            x.open('GET', 'https://example.com/')
            x.send()
          })
      )
      await attempt(
        'image',
        () =>
          new Promise((resolve, reject) => {
            const i = new Image()
            i.onload = () => resolve('loaded')
            i.onerror = () => reject(new Error('image blocked'))
            i.src = 'https://example.com/x.png'
          })
      )
      await attempt(
        'websocket',
        () =>
          new Promise((resolve, reject) => {
            try {
              const w = new WebSocket('wss://example.com/')
              w.onopen = () => resolve('open')
              w.onerror = () => reject(new Error('websocket blocked'))
            } catch (e) {
              reject(e)
            }
          })
      )
      await attempt('importRemote', () => import('https://example.com/x.mjs'))
      await attempt('importData', () => import('data:text/javascript,export default 1'))
      await attempt('eval', () => eval('1+1'))
      await attempt('newFunction', () => new Function('return 2')())
      await attempt(
        'iframe',
        () =>
          new Promise((resolve, reject) => {
            const f = document.createElement('iframe')
            f.src = 'https://example.com/'
            f.onload = () => {
              try {
                const href = f.contentWindow.location.href
                if (href.startsWith('chrome-error:') || href === 'about:blank')
                  reject(new Error('frame blocked'))
                else resolve(href)
              } catch (e) {
                reject(e)
              }
            }
            document.body.append(f)
            setTimeout(() => reject(new Error('iframe did not load')), 2000)
          })
      )
      await attempt(
        'worker',
        () =>
          new Promise((resolve, reject) => {
            try {
              const w = new Worker(
                URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))
              )
              w.onmessage = () => resolve('ran')
              w.onerror = () => reject(new Error('worker blocked'))
            } catch (e) {
              reject(e)
            }
          })
      )
      await attempt(
        'frameAppPage',
        () =>
          new Promise((resolve, reject) => {
            const f = document.createElement('iframe')
            f.src = location.href.replace('extension-host.html', 'index.html')
            f.onload = () => {
              try {
                resolve(typeof f.contentWindow.api)
              } catch (e) {
                reject(e)
              }
            }
            f.onerror = () => reject(new Error('frame blocked'))
            document.body.append(f)
          })
      )
      await attempt('peerConnection', () => {
        if (typeof RTCPeerConnection !== 'undefined') {
          new RTCPeerConnection()
          return 'constructed'
        }
        throw new Error('no RTCPeerConnection')
      })
      await attempt('rawBridgeRegexSchema', () =>
        window.fluidHost.request({
          type: 'register',
          registration: {
            kind: 'tabType',
            id: 998,
            type: {
              id: 'slow',
              label: 'Slow',
              payloadSchema: {
                type: 'object',
                properties: { x: { type: 'string', pattern: '^(a+)+$' } }
              },
              hasPinnedUrl: false,
              hasMenu: false,
              hasOnStop: false,
              hasOnClose: false
            }
          }
        })
      )
      await attempt(
        'runAllowed',
        async () => (await ctx.process.run('echo', ['hi', '$HOME'])).stdout
      )
      await attempt('runDenied', async () => (await ctx.process.run('ls', ['/'])).stdout)
      await attempt('runPath', async () => (await ctx.process.run('/bin/echo', ['x'])).stdout)
      await attempt('callAllowed', () => ctx.extensions.call('friend', 'ping', 1))
      await attempt('callDenied', () => ctx.extensions.call('stranger', 'ping', 1))
      await attempt('apiCall', () => ctx.api.tasks.list({ projectId: 'p1' }))
      await attempt('secret', () => ctx.secrets.get('token'))
      await attempt('otherSecret', () => ctx.secrets.get('slack:userToken'))
      await attempt('storage', async () => {
        await ctx.storage.set('k', { a: 1 })
        return ctx.storage.get('k')
      })
      await attempt('openFile', () => ctx.openExternal('file:///etc/passwd'))
      await attempt('openWeb', () => ctx.openExternal('https://example.com'))
      await attempt('rawBridgeRun', () =>
        window.fluidHost.request({ type: 'process.run', command: 'ls', args: [] })
      )
      await attempt('rawBridgeRegisterBadBookmark', () =>
        window.fluidHost.request({
          type: 'register',
          registration: {
            kind: 'bookmarks',
            id: 999,
            bookmarks: [{ id: 'x', label: 'x', url: 'file:///etc/passwd' }]
          }
        })
      )
      return r
    })
    ctx.taskTypes.register({
      id: 'review',
      label: 'Review',
      actions: (task) => [
        { id: 'go', label: `Go ${task.title}`, run: () => ctx.storage.set('ran', task.title) }
      ]
    })
    ctx.tabTypes.register({
      id: 'pane',
      label: 'Pane',
      payload: z.object({ thing: z.string() }),
      view: { kind: 'page' },
      menu: () => [
        { label: 'Poke', click: () => ctx.storage.set('poked', true) },
        { type: 'separator' }
      ]
    })
    ctx.bookmarks.provide(() => [{ id: 'b1', label: 'Example', url: 'https://example.com/' }])
    ctx.schedule({
      id: 'tick',
      intervalMs: 1000,
      initialDelayMs: 0,
      run: () => ctx.storage.set('ticked', true)
    })
    ctx.views.onConnect('pane', (connection) => {
      connection.onMessage((message) => connection.post({ pong: message, tabId: connection.tabId }))
    })
    ctx.protocols.handle(
      'probe-media',
      (request) =>
        new Response(`media:${new URL(request.url).pathname}`, {
          status: 200,
          headers: { 'content-type': 'text/plain' }
        })
    )
    ctx.onDispose(() => ctx.storage.set('disposed', true))
  }
}

export default extension
