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

const sdk = { ...load('../../sdk/src/renderer.ts'), ...load('../../sdk/src/relevance.ts') }
const searchEngine = load('../src/shared/search-engine.ts')
const urls = load('../src/renderer/src/lib/urls.ts', {
  '../../../shared/search-engine': searchEngine
})
const search = load('../src/renderer/src/lib/search.ts')
const { createAgentRenderer } = load('../../agent-core/src/renderer/index.ts', {
  '@fluid/sdk': sdk
})
const terminal = load('../../../extensions/terminal/src/renderer/index.ts', {
  '@fluid/sdk': sdk,
  '../shared/tab': { TERMINAL_TAB: 'terminal.shell' },
  './commands': load('../../../extensions/terminal/src/renderer/commands.ts')
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
    launcherDetail, analyseQuery, matchScore, scoreRow, displayUrl, isMultiline, looksLikeUrl, resolveInput, searchUrl,
    matchesQuery, searchEngines, INCOGNITO_PROFILE_ID } = dependencies;
  const ignoreEffect = () => {};
  ${body}
  return {
    get choices() { return choices },
    get guidance() { return guidance },
    get selected() { return selected },
    setQuery(text) { query = text; selected = 0; moved = false },
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
    searchEngines: { current: searchEngine.DEFAULT_SEARCH_ENGINE },
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
  assert.ok(launcher.choices.some((choice) => choice.key === 'typed:agent.ask'))
  assert.ok(launcher.choices.some((choice) => choice.key === 'bookmark:1'))
  assert.ok(launcher.choices.every((choice) => typeof choice.supportsMultiline === 'boolean'))
})

test('task and tab panels offer the same rows', () => {
  for (const text of ['', 'example.com', 'plain words', 'exa']) {
    const tab = setup('tab').launcher
    const task = setup('task').launcher
    tab.setQuery(text)
    task.setQuery(text)
    assert.deepEqual(
      task.choices.map((choice) => choice.key).filter((key) => key !== 'blank'),
      tab.choices.map((choice) => choice.key)
    )
  }
})

test('Enter on an empty field does nothing for a tab and starts a blank task for a task', () => {
  const tab = setup('tab')
  assert.equal(press(tab.launcher, 'Enter').defaultPrevented, true)
  assert.equal(tab.sent.length, 0)

  const task = setup('task')
  assert.equal(task.launcher.choices[0].key, 'blank')
  assert.equal(task.launcher.choices[0].label, 'New task')
  assert.equal(task.launcher.selected, 0)
  press(task.launcher, 'Enter')
  assert.deepEqual(task.sent, [{ kind: 'task', task: {} }])

  task.launcher.setQuery('words')
  assert.equal(task.launcher.choices[0].key, 'search')
  assert.equal(
    task.launcher.choices.some((choice) => choice.key === 'blank'),
    false
  )
})

test('a row chosen with the arrow keys is taken even when the field is empty', async () => {
  for (const mode of ['tab', 'task']) {
    const { launcher, sent } = setup(mode)
    press(launcher, 'ArrowDown')
    if (mode === 'tab') press(launcher, 'ArrowUp')
    press(launcher, 'Enter')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(sent.length, 1)
    if (mode === 'task') assert.equal(sent[0].task.tabs.length, 1)
  }
})

test('task panel names the task after the row taken', async () => {
  const { launcher, sent } = setup('task')
  const take = async (key, text) => {
    launcher.setQuery(text)
    launcher.open(launcher.choices.find((choice) => choice.key === key))
    await new Promise((resolve) => setImmediate(resolve))
    return sent.at(-1).task
  }
  assert.equal((await take('search', 'plain words')).title, 'plain words')
  assert.equal((await take('open', 'example.com')).title, urls.displayUrl('https://example.com'))
  assert.equal((await take('bookmark:1', 'example')).title, 'example.com')
  assert.equal((await take('typed:terminal.run', 'ls -la')).title, 'ls -la')
  const shell = await take('action:terminal.shell', 'term')
  assert.equal(shell.title, undefined)
  assert.equal(shell.tabs[0].type, 'terminal.shell')
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

/** The keys of the rows offered for `text`, best first. */
function rowsFor(text, mode = 'tab') {
  const { launcher } = setup(mode)
  launcher.setQuery(text)
  return launcher.choices.map((choice) => choice.key)
}

test('a command runs in a terminal, above the search, with no bare terminal beside it', () => {
  for (const text of [
    'ls',
    'ls -la',
    'cd src',
    'cd ..',
    'git status',
    'pnpm dev',
    'npm run build',
    'brew install jq',
    'docker compose up -d',
    './scripts/build.sh',
    '~/bin/tool --flag',
    'cat package.json | jq .name',
    'NODE_ENV=production node server.js',
    'mytool --help',
    'make build/app.o',
    'find . -name "*.ts"',
    'git commit -m "Fix the thing"'
  ]) {
    const keys = rowsFor(text)
    assert.equal(keys[0], 'typed:terminal.run', text)
    assert.ok(keys.includes('search'), text)
    assert.equal(keys.includes('action:terminal.shell'), false, text)
  }
})

test('a row matches by the starts of its words, not by letters inside them', () => {
  const editor = {
    id: 'editor',
    label: 'Editor',
    icon: 'editor-icon',
    keywords: ['elsewhere', 'command line'],
    open: async () => ({ type: 'editor.tab', title: null, payload: {} })
  }
  const offered = (text) => {
    const { launcher } = setup('tab', [{ id: 'ext', launcher: [editor] }])
    launcher.setQuery(text)
    return launcher.choices.some((choice) => choice.key === 'action:ext.editor')
  }
  assert.equal(offered('ls'), false)
  assert.equal(offered('else'), true)
  assert.equal(offered('line'), true)
  assert.equal(offered('dit'), false)
  assert.ok(rowsFor('exa').includes('bookmark:1'))
})

test('language never offers to run in a terminal', () => {
  for (const text of [
    'How do I list files?',
    'how do i list files in a folder',
    'What is the capital of France',
    'Fix the sidebar drop line',
    'make a website for my bakery',
    'open the pod bay doors',
    'find a good restaurant nearby',
    'is it going to rain tomorrow',
    'Ls the folder',
    'react hooks',
    'weather',
    'example.com',
    'https://example.com/a?b=c'
  ]) {
    assert.equal(rowsFor(text).includes('typed:terminal.run'), false, text)
  }
})

test('looking for the terminal finds it at the top, and offers nothing to run', () => {
  for (const text of ['terminal', 'Terminal', 'shell', 'zsh', 'bash']) {
    const keys = rowsFor(text)
    assert.equal(keys[0], 'action:terminal.shell', text)
    assert.equal(keys.includes('typed:terminal.run'), false, text)
  }
  // Part of the name is still the terminal, but not surer than a search.
  assert.ok(rowsFor('termi').includes('action:terminal.shell'))
})

test('a long instruction goes to an agent first; a question stays a search', () => {
  assert.equal(
    rowsFor('refactor the sidebar so the drop line only shows when valid')[0],
    'typed:agent.ask'
  )
  assert.equal(rowsFor('How do I center a div?')[0], 'search')
  assert.equal(rowsFor('ls -la').at(-1), 'typed:agent.ask')
})

test('the task panel ranks the same way', () => {
  for (const text of ['ls -la', 'terminal', 'How do I list files?']) {
    assert.deepEqual(rowsFor(text, 'task'), rowsFor(text, 'tab'))
  }
})

test("an entry's own rule can hide it, raise it, or leave it to the name match", () => {
  const rows = (score) => [
    {
      id: 'thing',
      label: 'Thing',
      icon: 'thing-icon',
      relevance: () => score,
      open: async () => ({ type: 'thing.tab', title: null, payload: {} })
    }
  ]
  const offered = (score, text) => {
    const { launcher } = setup('tab', [{ id: 'ext', launcher: rows(score) }])
    launcher.setQuery(text)
    return launcher.choices.map((choice) => choice.key)
  }
  assert.equal(offered(0, '').includes('action:ext.thing'), false)
  assert.equal(offered(1, 'anything at all')[0], 'action:ext.thing')
  assert.equal(offered(2, 'anything')[0], 'action:ext.thing')
  assert.equal(offered(null, 'nothing like it').includes('action:ext.thing'), false)
  assert.ok(offered(null, 'thi').includes('action:ext.thing'))
})

test('rules: the first rule with an opinion decides', () => {
  const rule = sdk.rules(
    sdk.when((query) => query.naturalLanguage, 0),
    sdk.when((query) => query.head === 'git', 0.9)
  )
  const score = (text) => rule(sdk.analyseQuery(text), { projectRoot: null })
  assert.equal(score('Why is git slow?'), 0)
  assert.equal(score('git log'), 0.9)
  assert.equal(score('svn log'), null)
})
