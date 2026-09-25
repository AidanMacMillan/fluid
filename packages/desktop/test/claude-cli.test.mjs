import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = ts.transpileModule(
  readFileSync(new URL('../../../extensions/claude-code/src/main/cli.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText

function setup({ binaries = {}, envPath = '/usr/local/bin', manifest = '2.1.278' } = {}) {
  const calls = []
  const mocks = {
    'node:path': path,
    'node:os': { homedir: () => '/Users/test' },
    'node:fs': {
      constants: { X_OK: 1 },
      accessSync: (file) => {
        if (!(file in binaries)) throw new Error('ENOENT')
      },
      readFileSync: () => JSON.stringify({ version: manifest })
    },
    'node:child_process': {
      execFileSync: (file, args, options) => {
        calls.push({ file, args, options })
        if (binaries[file] instanceof Error) throw binaries[file]
        return binaries[file]
      }
    }
  }
  const load = (id) => {
    if (!(id in mocks)) throw new Error(`Unexpected dependency: ${id}`)
    return mocks[id]
  }
  load.resolve = () => '/sdk/sdk.mjs'
  const exports = {}
  runInNewContext(source, {
    exports,
    require: load,
    process: { platform: 'darwin', env: { PATH: envPath } }
  })
  return { ...exports, calls, binaries }
}

test('missing CLI gives install and sign-in instructions instead of an SDK fallback', () => {
  const state = setup()
  assert.throws(() => state.claudeExecutable(), /not installed.*sign in.*Retry/)
  assert.equal(state.calls.length, 0)
})

test('finds the native installation when launched from the Dock without PATH', () => {
  const state = setup({
    envPath: '',
    binaries: { '/Users/test/.local/bin/claude': '2.1.278 (Claude Code)' }
  })
  assert.equal(state.claudeExecutable(), '/Users/test/.local/bin/claude')
  assert.equal(state.calls[0].args.join(' '), '--version')
  assert.equal(state.calls[0].options.timeout, 5000)
})

test('a stale or broken PATH entry does not shadow a compatible native installation', () => {
  for (const first of ['2.1.1 (Claude Code)', new Error('timeout'), 'invalid output']) {
    const state = setup({
      binaries: {
        '/usr/local/bin/claude': first,
        '/Users/test/.local/bin/claude': '2.2.0 (Claude Code)'
      }
    })
    assert.equal(state.claudeExecutable(), '/Users/test/.local/bin/claude')
  }
})

test('an old CLI gives update instructions', () => {
  const state = setup({ binaries: { '/usr/local/bin/claude': '2.1.271 (Claude Code)' } })
  assert.throws(() => state.claudeExecutable(), /requires Claude Code 2.1.278.*claude update/)
})

test('a broken CLI gives repair instructions', () => {
  const state = setup({ binaries: { '/usr/local/bin/claude': new Error('cannot execute') } })
  assert.throws(() => state.claudeExecutable(), /could not start.*claude --version/)
})

test('retry discovers a newly installed or updated CLI without restarting Fluid', () => {
  const state = setup()
  assert.throws(() => state.claudeExecutable(), /not installed/)
  state.binaries['/usr/local/bin/claude'] = '2.1.200 (Claude Code)'
  assert.throws(() => state.claudeExecutable(), /requires/)
  state.binaries['/usr/local/bin/claude'] = '2.1.300 (Claude Code)'
  assert.equal(state.claudeExecutable(), '/usr/local/bin/claude')
})

test('relative PATH entries cannot select an executable from the working directory', () => {
  const state = setup({
    envPath: '.:bin',
    binaries: { claude: '2.1.300', 'bin/claude': '2.1.300' }
  })
  assert.throws(() => state.claudeExecutable(), /not installed/)
  assert.equal(state.calls.length, 0)
})

test('invalid compatibility metadata fails explicitly', () => {
  const state = setup({ manifest: 'invalid' })
  assert.throws(() => state.claudeExecutable(), /compatibility information is missing/)
})
