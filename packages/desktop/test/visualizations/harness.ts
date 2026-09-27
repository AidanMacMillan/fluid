import { app, BrowserWindow, protocol, session } from 'electron'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createVisualizationStore } from '../../../agent-core/src/main/visualizations'
import { applyPagePolicy } from '../../src/main/page-policy'

const store = createVisualizationStore('codex-visualization')
protocol.registerSchemesAsPrivileged([
  store.declaration,
  { scheme: 'fluid-test', privileges: { standard: true, secure: true } }
])
const until = async (predicate: () => Promise<unknown>): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return
    await delay(50)
  }
  throw new Error('Timed out waiting for visualization')
}
app
  .whenReady()
  .then(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fluid-visual-browser-'))
    const window = new BrowserWindow({
      show: false,
      width: 900,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    try {
      const file = join(directory, 'fixture.html')
      await writeFile(
        file,
        `<div class="card"><h2>Interactive preview</h2><button class="btn" id="counter" onclick="this.textContent=Number(this.textContent)+1">0</button><button class="btn" id="followup" onclick="window.openai.sendFollowUpMessage({prompt:'Explain the selection'})">Ask about selection</button></div>`
      )
      const url = await store.load('tab', file, [directory])
      protocol.handle('codex-visualization', (request) => store.serve(request))
      protocol.handle('fluid-test', async (request) => {
        const path = new URL(request.url).pathname
        if (path === '/index.html')
          return new Response(
            '<!doctype html><html><head><link rel="stylesheet" href="/renderer.css"><style>body{background:#14161c;color:#e8e9ef;margin:24px;--theme-ink-200:#e8e9ef;--theme-ink-700:#454a59;color-scheme:dark}</style></head><body><script type="module" src="/renderer.js"></script></body></html>',
            { headers: { 'content-type': 'text/html' } }
          )
        if (path !== '/renderer.js' && path !== '/renderer.css')
          return new Response(null, { status: 404 })
        return new Response(await readFile(join(__dirname, path.slice(1))), {
          headers: { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/css' }
        })
      })
      applyPagePolicy(session.defaultSession, 'index.html', ['codex-visualization'])
      // Keep this regression deterministic and offline; optional CDN icons may fail.
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['https://*/*'] },
        (_details, callback) => callback({ cancel: true })
      )
      await window.loadURL(`fluid-test://host/index.html?preview=${encodeURIComponent(url)}`)
      const run = (code: string): Promise<unknown> => window.webContents.executeJavaScript(code)
      await until(
        async () =>
          (await run('document.querySelector("iframe")?.contentWindow !== undefined')) &&
          window.webContents.mainFrame.frames.length > 0
      )
      const child = window.webContents.mainFrame.frames[0]!
      await until(() => child.executeJavaScript('!!document.getElementById("counter")'))
      assert.equal(
        await child.executeJavaScript(
          'document.getElementById("counter").click(); document.getElementById("counter").textContent'
        ),
        '1'
      )
      assert.equal(await child.executeJavaScript('typeof require'), 'undefined')
      assert.equal(await child.executeJavaScript('typeof window.electron'), 'undefined')
      assert.equal(
        await child.executeJavaScript('try { parent.document.body; false } catch { true }'),
        true
      )
      assert.equal(
        await child.executeJavaScript('fetch("https://example.com").then(()=>false,()=>true)'),
        true
      )
      assert.equal(await run('document.body.textContent.includes("visualize")'), false)
      await run(
        'window.updateMessage("Before\\nvisualize{\\"path\\":\\"/fixture.html\\",\\"title\\":\\"Interactive preview\\",\\"mode\\":\\"wide\\"}\\nMore streamed prose")'
      )
      await delay(100)
      assert.equal(await run('window.testLoads'), 1, 'streamed prose must not reload the iframe')
      await child.executeJavaScript('document.getElementById("followup").click()')
      await until(() => run('document.body.textContent.includes("Use as draft")'))
      assert.equal(await run('window.testDraft'), '')
      await run(
        '[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Use as draft")).click()'
      )
      assert.equal(await run('window.testDraft'), 'Explain the selection')
      await run(
        '[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Expand")).click()'
      )
      await until(() => run('!!document.querySelector(".expanded")'))
      await writeFile(
        join(__dirname, 'preview.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      if (process.env.VISUALIZATION_SAMPLE) {
        const sample = process.env.VISUALIZATION_SAMPLE
        const sampleUrl = await store.load('sample', sample, [dirname(sample)])
        await window.loadURL(
          `fluid-test://host/index.html?preview=${encodeURIComponent(sampleUrl)}`
        )
        await until(
          async () =>
            window.webContents.mainFrame.frames.length > 0 &&
            Boolean(
              await window.webContents.mainFrame.frames[0]!.executeJavaScript(
                'document.body.children.length > 0'
              )
            )
        )
        await delay(300)
        await writeFile(
          join(__dirname, 'sample.png'),
          (await window.webContents.capturePage()).toPNG()
        )
      }
      console.log(
        'PASS: real Svelte renderer, interaction, streaming, expansion, draft bridge, parent isolation and network CSP'
      )
    } finally {
      window.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error)
      app.exit(1)
    }
  )
