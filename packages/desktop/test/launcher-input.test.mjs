import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  runInNewContext(
    ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    { exports, require: (id) => dependencies[id] }
  )
  return exports
}

const sdk = load('../../sdk/src/renderer.ts')
const urls = load('../src/renderer/src/lib/urls.ts')
const search = load('../src/renderer/src/lib/search.ts')
const { createAgentRenderer } = load('../../agent-core/src/renderer/index.ts', {
  '@fluid/sdk': sdk
})
const terminal = load('../../../extensions/terminal/src/renderer/index.ts', {
  '@fluid/sdk': sdk,
  '../shared/tab': { TERMINAL_TAB: 'terminal.shell' }
}).default

// Compile the launcher's actual state and event handlers with Svelte's runes.
// Only window/DOM effects are skipped; filtering and submissions run unchanged.
const component = readFileSync(
  new URL('../src/renderer/src/LauncherApp.svelte', import.meta.url),
  'utf8'
)
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1]
const ast = ts.createSourceFile('launcher.ts', script, ts.ScriptTarget.Latest, true)
const body = ast.statements
  .filter((statement) => !ts.isImportDeclaration(statement))
  .map((statement) => statement.getFullText(ast))
  .join('\n')
  .replaceAll('$effect(', 'ignoreEffect(')
const wrapped = `export function createLauncher(dependencies) {
  const { window, location, document, extensions, asksForInput, forTypedText,
    launcherDetail, displayUrl, isMultiline, looksLikeUrl, resolveInput, searchUrl,
    matchesQuery, INCOGNITO_PROFILE_ID } = dependencies;
  const ignoreEffect = () => {};
  ${body}
  return {
    get choices() { return choices },
    get guidance() { return guidance },
    get selected() { return selected },
    setQuery(text) { query = text; selected = 0 },
    setField(element) { field = element },
    setBookmarks(list) { bookmarks = list },
    open, onKeydown
  };
}`
const output = new URL('../out-test/', import.meta.url)
mkdirSync(output, { recursive: true })
const directory = mkdtempSync(new URL('launcher-', output))
const javascript = ts.transpileModule(wrapped, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext }
}).outputText
writeFileSync(
  `${directory}/launcher.mjs`,
  compileModule(javascript, { generate: 'client' }).js.code
)
const { createLauncher } = await import(`${directory}/launcher.mjs`)
after(() => rmSync(directory, { recursive: true, force: true }))

function setup(mode = 'tab', extra = []) {
  const sent = []
  const agent = createAgentRenderer({ id: 'agent', name: 'Agent', icon: 'agent-icon' })
  const host = {
    api: { projects: { workingDirectory: async () => '/project' } },
    call: async () => 'zsh'
  }
  const contributions = [agent, terminal, ...extra]
  const entries = (kind) =>
    contributions.flatMap((extension) =>
      (extension[kind] ?? []).map((entry) => ({ entry, extensionId: extension.id, host }))
    )
  class Field {
    focus() {
      return undefined
    }
  }
  const field = new Field()
  const launcher = createLauncher({
    ...sdk,
    ...urls,
    ...search,
    window: { api: { launcher: { submit: (choice) => sent.push(choice) } } },
    location: { search: `?mode=${mode}` },
    document: {},
    extensions: {
      start() {
        return undefined
      },
      launcherEntries: () => entries('launcher'),
      newTaskEntries: () => entries('newTask')
    },
    INCOGNITO_PROFILE_ID: -1
  })
  launcher.setField(field)
  launcher.setBookmarks([{ id: 1, label: 'example.com', url: 'https://example.com' }])
  return { launcher, sent, field }
}

function press(launcher, key, options = {}) {
  const event = {
    key,
    preventDefault() {
      this.defaultPrevented = true
    },
    ...options
  }
  launcher.onKeydown(event)
  return event
}

for (const mode of ['tab', 'task', 'incognito']) {
  test(`${mode}: multiline URL-looking input only offers multiline choices`, () => {
    const { launcher } = setup(mode)
    for (const text of [
      'https://example.com\nexplain this',
      'example.com\n',
      '\nexample.com',
      'example.com\r\n'
    ]) {
      launcher.setQuery(text)
      assert.ok(launcher.choices.length > 0)
      assert.ok(launcher.choices.every((choice) => choice.supportsMultiline === true))
      assert.equal(launcher.choices[0].key, 'search')
      assert.equal(
        launcher.choices.some((choice) => choice.key.includes('terminal')),
        false
      )
      assert.equal(
        launcher.choices.some((choice) => ['page', 'open', 'named', 'blank'].includes(choice.key)),
        false
      )
      const choice = launcher.choices[0].outcome.choice
      const url = mode === 'task' ? choice.task.tabs[0].payload.url : choice.url
      assert.equal(new URL(url).searchParams.get('q'), text.trim())
    }
  })
}

for (const mode of ['tab', 'task']) {
  test(`${mode}: agent receives every line while task title uses the first line`, async () => {
    const { launcher, sent } = setup(mode)
    const text = 'Explain this code\n\nThen suggest improvements'
    launcher.setQuery(text)
    launcher.open(launcher.choices.find((choice) => choice.key === 'typed:agent.ask'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent.length, 1)
    const tab = mode === 'task' ? sent[0].task.tabs[0] : sent[0].tab
    assert.equal(tab.payload.prompt, text)
    if (mode === 'task') assert.equal(sent[0].task.title, 'Explain this code')
  })
}

test('single-line behavior returns after removing the last newline', () => {
  const { launcher } = setup()
  launcher.setQuery('https://example.com\n')
  assert.equal(launcher.choices[0].key, 'search')
  launcher.setQuery('https://example.com')
  assert.equal(launcher.choices[0].key, 'open')
  assert.ok(launcher.choices.some((choice) => choice.key === 'typed:terminal.run'))
  assert.ok(launcher.choices.some((choice) => choice.key === 'bookmark:1'))
  assert.ok(launcher.choices.every((choice) => typeof choice.supportsMultiline === 'boolean'))
  const task = setup('task').launcher
  assert.equal(task.choices[0].key, 'blank')
  task.setQuery('My task')
  assert.equal(task.choices[0].key, 'named')
})

for (const mode of ['tab', 'task']) {
  test(`${mode}: legacy entries default to single-line input without an SDK migration`, async () => {
    const received = []
    const entries = [false, true].map((typed) => ({
      id: typed ? 'typed' : 'action',
      label: 'Legacy',
      icon: 'legacy-icon',
      ...(typed ? { typed: true } : {}),
      open: async (value) => {
        const text = typed ? value : undefined
        if (!typed) assert.equal(typeof value.api.projects.workingDirectory, 'function')
        received.push(text)
        const tab = { type: 'legacy.tab', title: null, payload: { text: text ?? '' } }
        return mode === 'task' ? { title: 'Legacy', tabs: [tab] } : tab
      }
    }))
    const { launcher, sent } = setup(mode, [{ id: 'legacy', launcher: entries, newTask: entries }])
    const action = launcher.choices.find((choice) => choice.key === 'action:legacy.action')
    assert.equal(action.supportsMultiline, false)
    launcher.open(action)
    launcher.setQuery('Legacy')
    const typed = launcher.choices.find((choice) => choice.key === 'typed:legacy.typed')
    assert.equal(typed.supportsMultiline, false)
    launcher.open(typed)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(received, [undefined, 'Legacy'])
    assert.equal(sent.length, 2)
    launcher.setQuery('Legacy\nsecond line')
    assert.ok(launcher.choices.every((choice) => !choice.key.includes('legacy.')))
  })
}

for (const supportsMultiline of [false, undefined]) {
  test(`single-line parsers (${supportsMultiline}) never receive multiline text, including inside a prompt`, () => {
    const parsed = []
    const { launcher } = setup('tab', [
      {
        id: 'links',
        launcher: [
          {
            id: 'thread',
            label: 'Thread',
            icon: 'link',
            ...(supportsMultiline === undefined ? {} : { supportsMultiline }),
            prompt: { placeholder: 'Paste link', rejection: 'Invalid link' },
            parse(text) {
              parsed.push(text)
              return text.startsWith('https://') ? text : null
            },
            open: async () => null
          }
        ]
      }
    ])
    launcher.setQuery('https://example.com\n')
    assert.equal(launcher.choices[0].key, 'search')
    assert.equal(parsed.length, 0)
    launcher.setQuery('')
    launcher.open(launcher.choices.find((choice) => choice.key === 'action:links.thread'))
    launcher.setQuery('https://example.com\n')
    assert.equal(launcher.choices.length, 0)
    assert.match(launcher.guidance, /single-line/)
    assert.equal(parsed.length, 0)
    assert.equal(press(launcher, 'Enter').defaultPrevented, true)
    assert.equal(press(launcher, 'Enter', { shiftKey: true }).defaultPrevented, undefined)
  })
}

test('Shift+Enter and IME do not submit; multiline arrows edit and Alt+arrows select', () => {
  const { launcher, sent, field } = setup()
  launcher.setQuery('first')
  assert.equal(press(launcher, 'Enter', { shiftKey: true }).defaultPrevented, undefined)
  assert.equal(press(launcher, 'Enter', { isComposing: true }).defaultPrevented, undefined)
  assert.equal(sent.length, 0)
  launcher.setQuery('first\nsecond')
  assert.equal(press(launcher, 'ArrowDown', { target: field }).defaultPrevented, undefined)
  assert.equal(launcher.selected, 0)
  assert.equal(press(launcher, 'ArrowDown', { target: field, altKey: true }).defaultPrevented, true)
  assert.equal(launcher.selected, 1)
  press(launcher, 'ArrowUp', { target: field, altKey: true })
  assert.equal(press(launcher, 'Enter').defaultPrevented, true)
  assert.equal(sent.length, 1)
})

test('URL helpers treat all raw line breaks as search input', () => {
  for (const text of ['https://example.com\n', 'https://example.com\rmore', '\nlocalhost:3000']) {
    assert.equal(urls.looksLikeUrl(text), false)
    assert.equal(urls.resolveInput(text), urls.searchUrl(text))
  }
  assert.equal(urls.resolveInput('localhost:3000'), 'http://localhost:3000')
})
