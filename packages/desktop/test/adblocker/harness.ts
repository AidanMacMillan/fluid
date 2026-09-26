import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { FiltersEngine, Request } from '@ghostery/adblocker'
import { AdBlocker, ADBLOCK_SCHEME } from '../../src/main/adblocker'
import { setResponsePolicy } from '../../src/main/response-policy'
import { loadFilters, saveFilters, selectFilters } from '../../src/main/adblocker-cache'
import {
  AD_BLOCKING_SETTING,
  adBlockingSettings,
  blockingMode,
  blocksContentOn,
  exceptionHost
} from '../../src/shared/ad-blocking'
import { initDatabase, closeDatabase } from '../../src/main/db/client'
import * as settingsAPI from '../../src/main/api/settings'
import { subscribe } from '../../src/main/api/bus'

const folder = mkdtempSync(join(tmpdir(), 'fluid-adblocker-'))
app.setPath('userData', folder)
app.dock?.hide()
protocol.registerSchemesAsPrivileged([ADBLOCK_SCHEME])
const windows: BrowserWindow[] = []
const hits: string[] = []
const server = createServer((request, response) => {
  hits.push(request.url ?? '')
  response.setHeader('Content-Type', request.url === '/page' ? 'text/html' : 'text/javascript')
  response.setHeader('Content-Security-Policy', "object-src 'none'")
  response.end(
    request.url === '/page'
      ? '<!doctype html><div class="sponsor">Ad</div><div id="content">Content</div>'
      : 'window.adLoaded = true'
  )
})

async function main(): Promise<void> {
  const settings = adBlockingSettings({ enabled: true, exceptions: ['https://Example.COM/path'] })
  assert.equal(exceptionHost('HTTPS://Example.COM./path'), 'example.com')
  assert.equal(exceptionHost('file:///tmp/example'), null)
  assert.equal(exceptionHost('*.example.com'), null)
  assert.equal(blocksContentOn(settings, 'https://sub.example.com'), false)
  assert.equal(blocksContentOn(settings, 'https://notexample.com'), true)
  assert.equal(blocksContentOn(settings, 'https://example.com.evil.test'), true)
  assert.equal(blocksContentOn(settings, 'file:///tmp/example.com'), false)
  assert.equal(settings.blockTrackers, false, 'existing settings remain ads-only')
  assert.equal(blockingMode(adBlockingSettings(null)), 'ads')
  assert.equal(
    blockingMode(adBlockingSettings({ enabled: false, blockTrackers: true })),
    'trackers'
  )
  assert.equal(
    blockingMode(adBlockingSettings({ enabled: true, blockTrackers: true })),
    'ads-and-trackers'
  )
  assert.equal(blockingMode(adBlockingSettings({ enabled: false, blockTrackers: false })), null)
  assert.equal(
    blocksContentOn(
      { ...settings, enabled: false, blockTrackers: true },
      'https://sub.example.com'
    ),
    false
  )
  const cache = join(folder, 'filters', 'ads.bin')
  const snapshot = join(__dirname, '../../resources/adblocker/ads.json.gz')
  const bundled = await loadFilters(cache, snapshot)
  assert(bundled.engine.getFilters().networkFilters.length > 1000)
  assert(bundled.engine.resources.getScriptlet('set'), 'bundled scriptlet resources load')
  assert(bundled.engine.resources.getResource('noop.js'), 'bundled redirects load')
  const youtubeFilters = bundled.engine.getCosmeticsFilters({
    url: 'https://www.youtube.com/watch?v=test',
    hostname: 'www.youtube.com',
    domain: 'youtube.com'
  })
  assert(youtubeFilters.scripts.length > 0, 'YouTube player rules resolve to executable scripts')
  const cached = await loadFilters(cache, '/missing-snapshot')
  assert.equal(
    cached.engine.getFilters().networkFilters.length,
    bundled.engine.getFilters().networkFilters.length
  )
  assert(Math.abs(cached.updatedAt - bundled.updatedAt) < 10, 'caching preserves snapshot age')
  await saveFilters(cache, FiltersEngine.parse('/ad.js$script'))
  assert(
    (await loadFilters(cache, snapshot)).engine.resources.getScriptlet('set'),
    'previously saved caches without resources are repaired'
  )
  writeFileSync(cache, 'damaged cache')
  assert((await loadFilters(cache, snapshot)).engine.getFilters().networkFilters.length > 1000)
  const tracking = await loadFilters(
    join(folder, 'filters', 'trackers.bin'),
    join(__dirname, '../../resources/adblocker/trackers.json.gz')
  )
  assert(tracking.engine.getFilters().networkFilters.length > 1000)
  const realEngines = { ads: bundled.engine, trackers: tracking.engine }
  const trackingRequest = Request.fromRawDetails({
    url: 'https://www.google-analytics.com/analytics.js',
    sourceUrl: 'https://example.com',
    type: 'script'
  })
  assert(
    tracking.engine.match(trackingRequest).match,
    'bundled tracker lists block a known analytics request'
  )
  assert(
    selectFilters(realEngines, 'ads-and-trackers')?.match(trackingRequest).match,
    'combined lists retain tracking rules'
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  let enabled = true
  let excepted = false
  const blocker = new AdBlocker(() => enabled && !excepted)
  const documentPolicies: string[] = []
  blocker.engine = FiltersEngine.parse(
    [
      '/blocked-ad.js$script',
      '/allowed-ad.js$script',
      '@@/allowed-ad.js$script',
      '127.0.0.1##.sponsor',
      "||127.0.0.1^$csp=frame-src 'none'",
      '127.0.0.1##+js(probe.js)',
      '/redirect-ad.js$script,redirect=noop.js'
    ].join('\n')
  )
  blocker.engine.updateResources(
    JSON.stringify({
      redirects: [
        {
          name: 'noop.js',
          aliases: [],
          body: 'window.redirected = true;',
          contentType: 'application/javascript'
        }
      ],
      scriptlets: [
        {
          name: 'probe.js',
          aliases: [],
          body: 'function() { window.scriptletRan = true; }',
          dependencies: []
        }
      ]
    }),
    'test'
  )
  blocker.registerIPC()

  async function page(partition?: string, attach = true): Promise<BrowserWindow> {
    const target = partition ? session.fromPartition(partition) : session.defaultSession
    target.webRequest.onResponseStarted((details) => {
      if (details.resourceType === 'mainFrame') {
        documentPolicies.push(
          Object.entries(details.responseHeaders ?? {})
            .filter(([name]) => name.toLowerCase() === 'content-security-policy')
            .flatMap(([, values]) => values)
            .join(';')
        )
      }
    })
    setResponsePolicy(target, 'existing', (details) => ({
      responseHeaders: { ...details.responseHeaders, 'X-Fluid-Policy': ['preserved'] }
    }))
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: target,
        sandbox: true,
        contextIsolation: true,
        preload: join(__dirname, '../preload/adblocker.js')
      }
    })
    windows.push(window)
    if (attach) blocker.attach(window.webContents)
    await window.loadURL(`${origin}/page`)
    return window
  }

  async function script(window: BrowserWindow, path: string): Promise<boolean> {
    return window.webContents.executeJavaScript(`new Promise(resolve => {
      const script = document.createElement('script');
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      script.src = ${JSON.stringify(`${origin}${path}`)};
      document.head.append(script);
    })`)
  }

  const first = await page()
  const second = await page('persist:profile-test')
  const privatePage = await page('incognito-test')
  assert(
    documentPolicies.every(
      (policy) => policy.includes("object-src 'none'") && policy.includes("frame-src 'none'")
    ),
    'ad-blocking CSP supplements existing policy'
  )
  for (const window of [first, second, privatePage]) {
    assert.equal(
      await script(window, '/blocked-ad.js'),
      false,
      'network ad blocked in every session'
    )
    assert.equal(await script(window, '/allowed-ad.js'), true, 'filter exceptions take precedence')
    assert.equal(await script(window, '/redirect-ad.js'), true, 'redirect resource loads')
    assert.equal(await window.webContents.executeJavaScript('window.redirected'), true)
    // Wait on the observable effect, not a fixed cosmetic-filter delay.
    assert.equal(
      await window.webContents.executeJavaScript(`new Promise(resolve => {
      const deadline = Date.now() + 3000;
      const check = () => {
        if (getComputedStyle(document.querySelector('.sponsor')).display === 'none' && window.scriptletRan) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(check, 25);
      }; check();
    })`),
      true,
      'cosmetics and scriptlets run in sandboxed browsing pages'
    )
    const headers = await window.webContents.executeJavaScript(
      `fetch('/page').then(r => Object.fromEntries(r.headers))`
    )
    assert.equal(headers['x-fluid-policy'], 'preserved')
    assert(headers['content-security-policy'].includes("object-src 'none'"))
  }
  assert(!hits.includes('/blocked-ad.js'), 'blocked requests never reach server')
  assert(!hits.includes('/redirect-ad.js'), 'redirected requests never reach server')

  // Exercise real shipped YouTube rules against deterministic player data and
  // ad markup, without relying on a live account receiving a particular ad.
  const youtubeSession = session.fromPartition('youtube-fixture')
  const youtubeHTML = `<!doctype html><script>
    const JSONPath = 'site-owned binding';
    window.ytInitialPlayerResponse = { playerAds: [{ad: true}], adPlacements: [{ad: true}], adSlots: [{ad: true}], videoDetails: {videoId: 'test'} };
    window.adsAtPlayerStartup = !!(ytInitialPlayerResponse.playerAds || ytInitialPlayerResponse.adPlacements || ytInitialPlayerResponse.adSlots);
    window.playerJSON = JSON.parse('{"adPlacements":[{"ad":true}],"videoDetails":{"videoId":"test"}}');
  </script>
  <div class="ytd-watch-flexy"><div class="ytd-watch-next-secondary-results-renderer"><ytd-ad-slot-renderer id="side-ad" class="ytd-watch-next-secondary-results-renderer">Sponsored</ytd-ad-slot-renderer></div></div>
  <div class="ytd-two-column-browse-results-renderer"><ytd-rich-grid-renderer><div id="masthead-ad" class="ytd-rich-grid-renderer">Banner</div></ytd-rich-grid-renderer></div><div id="content">Video</div>`
  youtubeSession.protocol.handle(
    'https',
    () =>
      new Response(youtubeHTML, {
        headers: {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "script-src 'unsafe-inline'"
        }
      })
  )
  const youtube = new BrowserWindow({
    show: false,
    webPreferences: {
      session: youtubeSession,
      sandbox: true,
      contextIsolation: true,
      preload: join(__dirname, '../preload/adblocker.js')
    }
  })
  windows.push(youtube)
  blocker.engine = bundled.engine
  blocker.attach(youtube.webContents)
  await youtube.loadURL('https://www.youtube.com/watch?v=test')
  assert.equal(
    await youtube.webContents.executeJavaScript('JSONPath'),
    'site-owned binding',
    'scriptlet helpers do not collide with page declarations'
  )
  assert.equal(
    await youtube.webContents.executeJavaScript('typeof window.safeSelf'),
    'undefined',
    'scriptlet helpers stay private instead of overwriting each other'
  )
  assert.equal(
    await youtube.webContents.executeJavaScript('window.adsAtPlayerStartup'),
    false,
    'YouTube scriptlets remove ad data before the first player script runs'
  )
  assert.deepEqual(
    await youtube.webContents.executeJavaScript('window.playerJSON'),
    { videoDetails: { videoId: 'test' } },
    'YouTube JSON pruning preserves video data'
  )
  assert.equal(
    await youtube.webContents.executeJavaScript(`new Promise(resolve => {
    const deadline = Date.now() + 3000;
    const check = () => {
      if (['side-ad', 'masthead-ad'].every(id => getComputedStyle(document.getElementById(id)).display === 'none')) resolve(true);
      else if (Date.now() > deadline) resolve(false);
      else setTimeout(check, 25);
    }; check();
  })`),
    true,
    'YouTube side and masthead banners are hidden'
  )
  for (const bypass of ['disabled', 'exception'] as const) {
    enabled = bypass !== 'disabled'
    excepted = bypass === 'exception'
    await youtube.loadURL('https://www.youtube.com/watch?v=test')
    assert.equal(
      await youtube.webContents.executeJavaScript('window.adsAtPlayerStartup'),
      true,
      `YouTube scriptlets respect ${bypass}`
    )
    assert.notEqual(
      await youtube.webContents.executeJavaScript(
        "getComputedStyle(document.getElementById('side-ad')).display"
      ),
      'none',
      `YouTube banners respect ${bypass}`
    )
  }
  enabled = true
  excepted = false
  blocker.engine = FiltersEngine.parse('/blocked-ad.js$script\n127.0.0.1##.sponsor')

  const appPage = await page(undefined, false)
  assert.equal(
    await script(appPage, '/blocked-ad.js'),
    true,
    'unregistered app pages are untouched'
  )
  assert.equal(
    await appPage.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('.sponsor')).display"
    ),
    'block'
  )

  enabled = false
  assert.equal(
    await script(first, '/blocked-ad.js'),
    true,
    'global disabling takes effect immediately'
  )
  await first.loadURL(`${origin}/page`)
  assert.equal(
    await first.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('.sponsor')).display"
    ),
    'block'
  )
  enabled = true
  excepted = true
  assert.equal(
    await script(second, '/blocked-ad.js'),
    true,
    'site exception bypasses network blocking'
  )
  await second.loadURL(`${origin}/page`)
  assert.equal(
    await second.webContents.executeJavaScript(
      "getComputedStyle(document.querySelector('.sponsor')).display"
    ),
    'block',
    'site exception also bypasses cosmetics'
  )
  excepted = false
  assert.equal(
    await script(second, '/blocked-ad.js'),
    false,
    'removing exception restores blocking'
  )

  const engines = {
    ads: FiltersEngine.parse('/blocked-ad.js$script\n/excepted-tracker.js$script'),
    trackers: FiltersEngine.parse('/tracking.js$script\n@@/excepted-tracker.js$script')
  }
  engines.trackers.updateResources(
    JSON.stringify({
      redirects: [
        {
          name: 'fresh.js',
          aliases: [],
          body: 'fresh resource',
          contentType: 'application/javascript'
        }
      ],
      scriptlets: []
    }),
    'newer-resource-version'
  )
  assert.equal(
    selectFilters(engines, 'ads-and-trackers', 'trackers')?.resources.getResource('fresh.js').body,
    'fresh resource',
    'independently refreshed resources merge without checksum conflicts'
  )
  for (const [mode, blocksAds, blocksTrackers] of [
    ['ads', true, false],
    ['trackers', false, true],
    ['ads-and-trackers', true, true],
    [null, false, false]
  ] as const) {
    blocker.engine = selectFilters(engines, mode)
    for (const window of [first, second, privatePage]) {
      assert.equal(await script(window, '/blocked-ad.js'), !blocksAds, `ads in ${mode} mode`)
      assert.equal(
        await script(window, '/tracking.js'),
        !blocksTrackers,
        `trackers in ${mode} mode`
      )
    }
    if (mode === 'ads-and-trackers') {
      assert.equal(
        await script(first, '/excepted-tracker.js'),
        true,
        'exceptions take precedence across subscriptions'
      )
    }
  }
  blocker.engine = selectFilters(engines, 'ads-and-trackers')
  excepted = true
  assert.equal(await script(first, '/blocked-ad.js'), true, 'site exceptions bypass ads')
  assert.equal(await script(first, '/tracking.js'), true, 'site exceptions bypass trackers')
  excepted = false

  // Exercise the shipped settings screen against real persisted settings.
  await initDatabase()
  ipcMain.on('theme:current', (event) => {
    event.returnValue = 'default'
  })
  ipcMain.handle(
    'api:call',
    async (_event, method: string, input: { key: string; value?: unknown }) => {
      if (method === 'extensions.list') return []
      if (method === 'settings.get') return settingsAPI.get(input.key)
      if (method === 'settings.set') return settingsAPI.set(input.key, input.value)
      throw new Error(`Unexpected method: ${method}`)
    }
  )
  const settingsWindow = new BrowserWindow({
    width: 700,
    height: 500,
    show: false,
    webPreferences: {
      sandbox: false,
      preload: join(__dirname, '../preload/index.js')
    }
  })
  windows.push(settingsWindow)
  const unsubscribe = subscribe((event) => settingsWindow.webContents.send('api:event', event))
  await settingsWindow.loadFile(join(__dirname, '../renderer/settings.html'))
  async function eventually(expression: string): Promise<void> {
    assert.equal(
      await settingsWindow.webContents.executeJavaScript(`new Promise(resolve => {
      const deadline = Date.now() + 3000;
      const check = () => {
        if (${expression}) resolve(true);
        else if (Date.now() > deadline) resolve(false);
        else setTimeout(check, 25);
      }; check();
    })`),
      true,
      expression
    )
  }
  await eventually(
    `Array.from(document.querySelectorAll('[role="tab"]')).some(el => el.textContent.includes('Privacy'))`
  )
  await settingsWindow.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[role="tab"]')).find(el => el.textContent.includes('Privacy')).click()`
  )
  await eventually(`document.querySelector('input[type="checkbox"]')?.disabled === false`)
  assert.equal(
    await settingsWindow.webContents.executeJavaScript(
      `document.querySelector('input[type="checkbox"]').checked`
    ),
    true
  )
  await settingsWindow.webContents.executeJavaScript(`{
    const input = document.querySelector('input[type="text"]');
    input.value = 'https://Example.com/path';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('form').requestSubmit();
  }`)
  await eventually(`document.querySelector('li')?.textContent.includes('example.com')`)
  assert.deepEqual(await settingsAPI.get(AD_BLOCKING_SETTING), {
    enabled: true,
    blockTrackers: false,
    exceptions: ['example.com']
  })
  writeFileSync(
    join(tmpdir(), 'fluid-adblocking-settings.png'),
    (await settingsWindow.webContents.capturePage()).toPNG()
  )
  const disabledSaved = new Promise<void>((resolve) => {
    const stop = subscribe((event) => {
      if (
        event.type === 'setting.changed' &&
        event.key === AD_BLOCKING_SETTING &&
        !adBlockingSettings(event.value).enabled
      ) {
        stop()
        resolve()
      }
    })
  })
  await settingsWindow.webContents.executeJavaScript(
    `document.querySelector('input[type="checkbox"]').click()`
  )
  await disabledSaved
  await eventually(
    `document.querySelector('input[type="checkbox"]')?.disabled === false && !document.querySelector('input[type="checkbox"]').checked`
  )
  assert.deepEqual(await settingsAPI.get(AD_BLOCKING_SETTING), {
    enabled: false,
    blockTrackers: false,
    exceptions: ['example.com']
  })
  assert.equal(
    await settingsWindow.webContents.executeJavaScript(
      `document.querySelector('input[name="block-trackers"]').checked`
    ),
    false,
    'tracker switch defaults off'
  )
  const trackersSaved = new Promise<void>((resolve) => {
    const stop = subscribe((event) => {
      if (
        event.type === 'setting.changed' &&
        event.key === AD_BLOCKING_SETTING &&
        adBlockingSettings(event.value).blockTrackers
      ) {
        stop()
        resolve()
      }
    })
  })
  await settingsWindow.webContents.executeJavaScript(
    `document.querySelector('input[name="block-trackers"]').click()`
  )
  await trackersSaved
  assert.deepEqual(await settingsAPI.get(AD_BLOCKING_SETTING), {
    enabled: false,
    blockTrackers: true,
    exceptions: ['example.com']
  })
  await settingsWindow.loadFile(join(__dirname, '../renderer/settings.html'))
  await eventually(
    `Array.from(document.querySelectorAll('[role="tab"]')).some(el => el.textContent.includes('Privacy'))`
  )
  await settingsWindow.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('[role="tab"]')).find(el => el.textContent.includes('Privacy')).click()`
  )
  await eventually(`document.querySelector('input[type="checkbox"]')?.disabled === false`)
  assert.equal(
    await settingsWindow.webContents.executeJavaScript(
      `document.querySelector('input[type="checkbox"]').checked`
    ),
    false,
    'global switch persists when settings reopens'
  )
  assert.equal(
    await settingsWindow.webContents.executeJavaScript(
      `document.querySelector('input[name="block-trackers"]').checked`
    ),
    true,
    'tracker switch persists independently of ads'
  )
  await settingsWindow.webContents.executeJavaScript(`document.querySelector('li button').click()`)
  await eventually(
    `document.querySelector('p')?.closest('section')?.textContent.includes('No site exceptions.')`
  )
  assert.deepEqual(await settingsAPI.get(AD_BLOCKING_SETTING), {
    enabled: false,
    blockTrackers: true,
    exceptions: []
  })
  unsubscribe()
  await closeDatabase()
  console.log(
    'PASS: network blocking, independent ad/tracker modes, exceptions, redirects, cosmetics, scriptlets, multiple sessions, private sessions, app isolation, CSP preservation, disabling, offline snapshots, cache recovery, settings UI and persistence'
  )
}

const timeout = setTimeout(() => {
  console.error('Adblocker tests timed out')
  app.exit(1)
}, 30000)
app
  .whenReady()
  .then(main)
  .then(
    () => finish(0),
    (error) => {
      console.error(error)
      finish(1)
    }
  )
function finish(code: number): void {
  clearTimeout(timeout)
  for (const window of windows) window.destroy()
  server.close()
  rmSync(folder, { recursive: true, force: true })
  app.exit(code)
}
