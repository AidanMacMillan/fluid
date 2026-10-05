import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test, after } from 'node:test'
import ts from 'typescript'

// The module under test only needs `app.userAgentFallback` from Electron, so
// its import is swapped for a stand-in rather than launching Electron.
const output = new URL('../out-test/', import.meta.url)
mkdirSync(output, { recursive: true })
const directory = mkdtempSync(new URL('user-agent-', output))
const source = readFileSync(new URL('../src/main/user-agent.ts', import.meta.url), 'utf8')
const javascript = ts
  .transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }
  })
  .outputText.replace(/import \{ app \} from 'electron'/, 'const app = globalThis.__electronApp')
writeFileSync(`${directory}/user-agent.mjs`, javascript)
after(() => rmSync(directory, { recursive: true, force: true }))

globalThis.__electronApp = { userAgentFallback: '' }
const { chromeUserAgent, registerUserAgent } = await import(`${directory}/user-agent.mjs`)

const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

test('drops the Electron and app tokens and reduces the Chrome version', () => {
  const electron =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Fluid/0.1.3 Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36'
  assert.equal(chromeUserAgent(electron), CHROME)
})

test('leaves a UA that is already Chrome-shaped alone', () => {
  assert.equal(chromeUserAgent(CHROME), CHROME)
})

test('keeps the other platforms intact', () => {
  assert.equal(
    chromeUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Electron/44.4.5 Safari/537.36'
    ),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
  )
})

test('registers the result as the UA every session starts from', () => {
  globalThis.__electronApp.userAgentFallback = CHROME.replace('Safari/', 'Electron/44.4.5 Safari/')
  registerUserAgent()
  assert.equal(globalThis.__electronApp.userAgentFallback, CHROME)
})
