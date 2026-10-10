<script lang="ts">
  import {
    asksForInput,
    forTypedText,
    keepSelectionInView,
    launcherDetail,
    selectOnMouseMove,
    type Bookmark,
    type LauncherAlternative,
    type LauncherContext,
    type LauncherPromptEntry,
    type LauncherRow
  } from '@fluid/sdk'
  import type { LauncherChoice, LauncherMode } from '../../main/launcher-window'
  import { INCOGNITO_PROFILE_ID } from '../../main/profiles'
  import ShortcutBar from './components/ShortcutBar.svelte'
  import { fluid } from './lib/api'
  import { extensions } from './lib/extensions.svelte'
  import type { LauncherAction, LauncherOutcome, LauncherPrompt } from './lib/launcher-actions'
  import { matchesQuery } from './lib/search'
  import { displayUrl, isMultiline, looksLikeUrl, resolveInput, searchUrl } from './lib/urls'

  /**
   * The panel that opens a new tab: a field to type into, the handful of places
   * worth going in a keystroke, below a line the kinds of tab that are not
   * places at all, and below another — only once something has been typed —
   * the catalogues extensions supply (every app Okta will sign you into).
   *
   * It decides nothing about tabs. What it produces is a choice, handed back to
   * the window it opened over — that window knows which task is selected, and
   * this one deliberately does not.
   *
   * A row may ask a question instead of answering one — an extension's launcher
   * entry, asking for a link. Taking such a row puts the panel into a prompt:
   * the same field, narrowed to one thing — see `prompt` below, and
   * `LauncherEntry` in the SDK. An entry with nothing to ask opens its tab as
   * soon as it is taken, the way the app's own actions do.
   *
   * The same panel asks what a new task should be (see `LauncherMode`), and
   * offers the same rows — the difference is what taking one makes. A row's
   * tab opens in a task of its own (see `inMode`), named after what was typed
   * where there was something typed — the search, the address, the command —
   * or after the page or tab itself where there was not. And while the field
   * is empty the task panel leads with a row of its own, "New task", which is
   * what it opens on: Cmd+Shift+T and Enter is a blank task, with no tabs.
   */

  const api = window.api.launcher

  /** Which question the panel was opened to ask. Fixed for its life: see `openLauncherWindow`. */
  const requestedMode = new URLSearchParams(location.search).get('mode')
  const mode: LauncherMode =
    requestedMode === 'task' || requestedMode === 'incognito' ? requestedMode : 'tab'
  const incognito = mode === 'incognito'
  const profile = incognito ? INCOGNITO_PROFILE_ID : null

  if (mode === 'task') document.title = 'New task'
  if (incognito) document.title = 'New incognito tab'

  /**
   * How a row's icon is drawn, and what separates the rows that stand for an
   * app from the rows that stand for an act. A bookmark carries the real logo, which is a picture in the brand's colours and has to
   * stay one; what is left — a search, an address, a terminal — is a Phosphor
   * glyph, drawn as a CSS mask so it takes the row's own text colour.
   *
   * Logos arrive as `data:` URLs, so the launcher still loads nothing from
   * anywhere (see the CSP in src/renderer/launcher.html): an extension bundles
   * its bookmarks' icons rather than pointing at the sites'.
   */
  type RowIcon = { kind: 'glyph'; className: string } | { kind: 'favicon'; src: string }

  /** A single thing the list offers. The row draws it; Enter takes its `choice`. */
  type Choice = {
    key: string
    label: string
    supportsMultiline: boolean
    /** The dimmer half of the row: the address or folder, or empty for nothing to add. */
    detail: string
    icon: RowIcon
    /**
     * Which band of the panel this row is in, and the only thing the dividers
     * are drawn from: a line falls wherever one band gives way to the next.
     *
     * `go` is everywhere worth going — what was typed, then the bookmarks.
     * `do` is the tabs that are not places at all. `catalogue` is the
     * search-only bookmarks — the Okta apps — last because they are the longest
     * and the least curated: searched into rather than read down, and the rows
     * above should keep their place when it fills.
     */
    section: 'go' | 'do' | 'catalogue'
    /** What Enter does here: hand back a choice, or open a second step. */
    outcome: LauncherOutcome
  }

  let query = $state('')
  const multiline = $derived(isMultiline(query))

  /**
   * The question the panel is asking, or null while it is the search field it
   * usually is. Set by taking a row whose outcome is a prompt, and cleared by
   * backing out of one.
   */
  let prompt = $state<LauncherPrompt | null>(null)

  /** The wording for that question. Null in the ordinary case. */
  // Extensions are followed from here too: the panel is a window of its own,
  // and the rows they add come and go with them.
  if (!incognito) extensions.start()

  /** The first line of what was typed, which is all a task's name has room for. */
  function firstLine(text: string): string {
    return text.split(/[\r\n]/)[0]
  }

  /**
   * What taking a row answers with, for the question this panel is asking. The
   * new-tab panel hands back the page or tab as it is; the new-task panel wraps
   * the same page or tab in a task of its own, called `title` (or, with none,
   * left to the default — see `createTask`). Anything that is not a page or a
   * tab is already an answer to a question about tasks.
   */
  function inMode(choice: LauncherChoice, title?: string): LauncherChoice {
    if (mode !== 'task') return choice
    if (choice.kind === 'url') {
      const tab = { type: 'browser', title: null, payload: { url: choice.url } }
      return { kind: 'task', task: { title, tabs: [tab] } }
    }
    if (choice.kind === 'extension-tab') {
      return {
        kind: 'task',
        task: { title: title ?? choice.tab.title ?? undefined, tabs: [choice.tab] }
      }
    }
    return choice
  }

  /**
   * An extension's entry, whichever panel it is for. A new-tab entry answers
   * with a tab and a new-task entry with a task, but the rows, the prompts and
   * the parsing are the same, so both are drawn from this — and `take` is where
   * they differ, turning what the extension answers into what the panel hands
   * back.
   */
  type Entry = {
    /** `extensionId.entryId`, the way a prompt names one. */
    key: string
    row: LauncherRow
    prompt: LauncherPromptEntry['prompt'] | null
    parse: ((text: string) => unknown | null) | null
    alternatives: LauncherAlternative[]
    /**
     * Asks the extension what to open, for what was typed if the entry asked
     * for anything. Null for a user who decided against it on the way.
     */
    take: (value: unknown) => Promise<LauncherChoice | null>
  }

  /**
   * Every running extension's entries for this panel, but for the ones only offered for typed text.
   *
   * The task panel offers the same ones, each starting a task on the tab it
   * would have opened. An extension that has something more specific to say
   * about what the task is — a new-task entry with the same id, like a Slack
   * thread named after what it says — is left to say it in that entry's place,
   * and one with no tab of its own to offer is added after the rest.
   */
  const entries = $derived.by<Entry[]>(() => {
    if (incognito) return []

    const own = extensions.launcherEntries().flatMap(({ extensionId, entry, host }): Entry[] =>
      forTypedText(entry)
        ? []
        : [
            {
              key: `${extensionId}.${entry.id}`,
              row: entry,
              prompt: entry.prompt ?? null,
              parse: entry.parse ?? null,
              alternatives: mode === 'task' ? [] : (entry.alternatives ?? []),
              take: async (value: unknown): Promise<LauncherChoice | null> => {
                const launcherHost = { ...host, launcher: context }
                const tab = asksForInput(entry)
                  ? await entry.open(value, launcherHost)
                  : await entry.open(launcherHost)
                return tab ? inMode({ kind: 'extension-tab', tab }) : null
              }
            }
          ]
    )
    if (mode !== 'task') return own

    const tasks = extensions.newTaskEntries().flatMap(({ extensionId, entry, host }): Entry[] =>
      forTypedText(entry)
        ? []
        : [
            {
              key: `${extensionId}.${entry.id}`,
              row: entry,
              prompt: entry.prompt ?? null,
              parse: entry.parse ?? null,
              alternatives: [],
              take: async (value: unknown): Promise<LauncherChoice | null> => {
                const launcherHost = { ...host, launcher: context }
                const task = asksForInput(entry)
                  ? await entry.open(value, launcherHost)
                  : await entry.open(launcherHost)
                return task ? { kind: 'task', task } : null
              }
            }
          ]
    )
    return [
      ...own.map((found) => tasks.find(({ key }) => key === found.key) ?? found),
      ...tasks.filter(({ key }) => !own.some((found) => found.key === key))
    ]
  })

  /** The entries that ask for a line before they open anything. */
  const prompting = $derived(
    entries.flatMap((entry) =>
      entry.prompt && entry.parse ? [{ ...entry, prompt: entry.prompt, parse: entry.parse }] : []
    )
  )

  const asking = $derived.by(() => {
    const found = prompting.find((candidate) => candidate.key === prompt)
    return found ? { ...found.row, ...found.prompt } : null
  })

  /**
   * The row Enter would open, as an index into `choices`. Moved by the arrow
   * keys and by the pointer, and put back to the top on every keystroke: the
   * list is rebuilt as the query filters it, so a selection that survived would
   * be on a different row than the one it was put on — and the top row is the
   * one the query itself just produced.
   */
  let selected = $state(0)

  /**
   * Whether the selection has been moved since the field was last typed in. The
   * top row is highlighted from the start, but a row nobody chose is not an
   * answer: Enter on a fresh new-tab panel opens nothing, not whatever happens
   * to be first in the list. (The task panel's first row is a real one, "New
   * task", so there the highlighted row is always an answer.)
   */
  let moved = $state(false)

  /**
   * Nothing has been asked of the panel yet: an empty field, not in a prompt,
   * and no row chosen. The one state in which Enter does not take the
   * highlighted row, and only the new-tab panel has it.
   */
  const idle = $derived(mode === 'tab' && prompt === null && query.trim() === '' && !moved)

  /**
   * The task panel's first row while nothing is typed, and the one it opens on:
   * a task with no tabs in it. Gone as soon as there is text, when the first
   * row is what that text produces.
   */
  const blank = $derived<Choice | null>(
    mode === 'task' && query.trim() === ''
      ? {
          key: 'blank',
          supportsMultiline: false,
          label: 'New task',
          detail: '',
          icon: { kind: 'glyph', className: 'icon-[ph--plus]' },
          section: 'go',
          outcome: { kind: 'choice', choice: { kind: 'task', task: {} } }
        }
      : null
  )

  /**
   * Every bookmark there is: the user's own and whatever enabled extensions
   * supply, kept current while the panel is open.
   */
  let bookmarks = $state<Bookmark[]>([])
  $effect(() => fluid.watch('bookmarks.list', {}, (list) => (bookmarks = list)))

  /**
   * The bookmarks worth showing for what has been typed so far. A catalogue
   * marked search-only stays out of the way until something is typed — it is
   * the reason the panel has to stay quiet when it opens, and the reason it can
   * be long — and is matched on its label and keywords rather than its address:
   * a catalogue's addresses tend to share everything but an id.
   */
  const matches = $derived(
    multiline
      ? []
      : bookmarks.filter((bookmark) =>
          bookmark.searchOnly
            ? query.trim() !== '' &&
              matchesQuery(query, [bookmark.label, ...(bookmark.keywords ?? [])])
            : matchesQuery(query, [bookmark.label, bookmark.url, ...(bookmark.keywords ?? [])])
        )
  )

  /**
   * The current project's folder, which is where a new terminal, a new session
   * and an editor all start. Null until the answer lands — the panel opens and
   * is typed into faster than a round trip, so the rows that depend on it have
   * to read as themselves without it (see `LauncherContext` in the SDK).
   */
  let root = $state<string | null>(null)

  $effect(() => {
    void fluid.projects.active().then((project) => {
      root = project?.root ?? null
    })
  })

  /** What an extension's entry is told about where the panel was opened. */
  const context = $derived<LauncherContext>({ projectRoot: root })

  /** Each running extension's launcher entries. */
  const actions = $derived(
    entries
      .filter(({ row }) => !multiline || row.supportsMultiline === true)
      .filter(({ row }) =>
        matchesQuery(query, [row.label, launcherDetail(row, context), ...(row.keywords ?? [])])
      )
      .map(({ row, key, prompt }): LauncherAction => ({
        id: key,
        label: row.label,
        supportsMultiline: row.supportsMultiline === true,
        detail: launcherDetail(row, context),
        icon: row.icon,
        outcome: prompt ? { kind: 'prompt', prompt: key } : { kind: 'extension-action', entry: key }
      }))
  )

  /**
   * The rows either panel offers for what has been typed, just under the one
   * the text itself produced — a search (see `NewTaskTypedEntry` and
   * `LauncherTypedEntry` in the SDK). Each reads as the text, with the entry's
   * own name beside it. The task panel starts a task named after the text on
   * the tab the entry opens, unless a new-task entry with the same id has its
   * own idea of the task.
   */
  type TypedEntry = {
    key: string
    row: LauncherRow
    take: (text: string) => Promise<LauncherChoice | null>
  }

  const typedEntries = $derived.by<TypedEntry[]>(() => {
    if (incognito) return []

    const own = extensions
      .launcherEntries()
      .flatMap(({ extensionId, entry, host }): TypedEntry[] =>
        forTypedText(entry)
          ? [
              {
                key: `${extensionId}.${entry.id}`,
                row: entry,
                take: async (text) => {
                  const tab = await entry.open(text, { ...host, launcher: context })
                  return tab ? inMode({ kind: 'extension-tab', tab }, firstLine(text)) : null
                }
              }
            ]
          : []
      )
    if (mode !== 'task') return own

    const tasks = extensions
      .newTaskEntries()
      .flatMap(({ extensionId, entry, host }): TypedEntry[] =>
        forTypedText(entry)
          ? [
              {
                key: `${extensionId}.${entry.id}`,
                row: entry,
                take: async (text) => {
                  const task = await entry.open(text, { ...host, launcher: context })
                  return task ? { kind: 'task', task } : null
                }
              }
            ]
          : []
      )
    return [
      ...own.map((found) => tasks.find(({ key }) => key === found.key) ?? found),
      ...tasks.filter(({ key }) => !own.some((found) => found.key === key))
    ]
  })

  const forTyped = $derived.by<Choice[]>(() => {
    const text = query.trim()
    if (text === '') return []
    return typedEntries
      .filter(({ row }) => !multiline || row.supportsMultiline === true)
      .map(({ key, row }) => ({
        key: `typed:${key}`,
        supportsMultiline: row.supportsMultiline === true,
        label: text,
        detail: row.label,
        icon: { kind: 'glyph', className: row.icon },
        section: 'go',
        outcome: { kind: 'typed', entry: key, text }
      }))
  })

  /**
   * What typing into the field offers, above the bookmarks. An address goes
   * straight there; anything else is searched for, which is what the field does
   * by default and the reason Enter on a fresh panel needs nothing else.
   * The task panel's rows are these same ones, taken as a task named after the
   * text (see `inMode`).
   */
  const typed = $derived.by<Choice[]>(() => {
    const text = query.trim()
    if (text === '') return []

    // Before the address test, because an extension's link — a permalink into
    // a chat app, say — passes that too, and opening one as a page could put the
    // user in front of a sign-in wall for somewhere they are already signed in.
    const recognised: Choice[] = []
    for (const { row, key, parse } of prompting) {
      if (multiline && row.supportsMultiline !== true) continue
      const value = parse(text)
      if (value === null) continue
      recognised.push({
        key,
        supportsMultiline: row.supportsMultiline === true,
        label: row.label,
        detail: launcherDetail(row, context),
        icon: { kind: 'glyph', className: row.icon },
        section: 'go',
        outcome: { kind: 'extension', prompt: key, value }
      })
      // A recognised single-line link has one answer. Multiline text can
      // still be searched even when an extension recognises it.
      if (!multiline) return recognised
    }

    if (!multiline && looksLikeUrl(text)) {
      const url = resolveInput(text)
      if (!url) return []
      return [
        {
          key: 'open',
          supportsMultiline: false,
          label: displayUrl(url),
          detail: '',
          icon: { kind: 'glyph', className: 'icon-[ph--arrow-square-out]' },
          section: 'go',
          outcome: {
            kind: 'choice',
            choice: inMode({ kind: 'url', url, profile }, displayUrl(url))
          }
        }
      ]
    }

    return [
      ...recognised,
      {
        key: 'search',
        supportsMultiline: true,
        label: text,
        detail: 'Search Google',
        icon: { kind: 'glyph', className: 'icon-[ph--magnifying-glass]' },
        section: 'go',
        outcome: {
          kind: 'choice',
          choice: inMode({ kind: 'url', url: searchUrl(text), profile }, firstLine(text))
        }
      }
    ]
  })

  /**
   * What the field has given the prompt so far, as the one row that would
   * answer it — or null while it has given nothing usable.
   *
   * A prompt narrows the panel to a single question, so it narrows the list to
   * a single row. There is nothing else the panel could offer at that point
   * that would not be a change of subject.
   */
  const answered = $derived.by<Choice | null>(() => {
    const found = prompting.find((candidate) => candidate.key === prompt)
    if (!found || (multiline && found.row.supportsMultiline !== true)) return null

    const value = found.parse(query.trim())
    if (value === null) return null

    return {
      key: found.key,
      supportsMultiline: found.row.supportsMultiline === true,
      label: `${mode === 'task' ? 'Start' : 'Open'} ${found.row.label.toLowerCase()}`,
      detail: launcherDetail(found.row, context),
      icon: { kind: 'glyph', className: found.row.icon },
      section: 'go',
      outcome: { kind: 'extension', prompt: found.key, value }
    }
  })

  /**
   * Everything on offer, in one list: what was typed, then what extensions
   * offer for it, then the bookmarks, then
   * the actions, then the catalogues. Flat rather than nested
   * because the arrow keys walk the whole panel — a divider is a line drawn
   * between two rows, not a border between lists you have to cross
   * deliberately.
   *
   * While a prompt is being asked it is that prompt's answer instead, and
   * nothing else. The same list in both panels: see `inMode` for what taking
   * a row makes of it.
   */
  const choices = $derived.by<Choice[]>(() =>
    prompt !== null
      ? answered
        ? [answered]
        : []
      : [
          ...(blank ? [blank] : []),
          ...typed,
          ...forTyped,
          ...matches.filter((bookmark) => !bookmark.searchOnly).map(bookmarkChoice),
          ...actions.map(actionChoice),
          ...matches.filter((bookmark) => bookmark.searchOnly).map(bookmarkChoice)
        ]
  )

  /**
   * What to say under the field when a prompt was given something it cannot
   * use. Null the rest of the time: an empty prompt says nothing, and the
   * ordinary search always has a row to offer, even if it is only a search.
   */
  const guidance = $derived(
    asking === null || answered !== null || query.trim() === ''
      ? null
      : multiline && asking.supportsMultiline !== true
        ? 'This option only supports single-line text. Go back to use a search or agent prompt.'
        : asking.rejection
  )

  function bookmarkChoice(bookmark: Bookmark): Choice {
    // A catalogue's rows go below the actions, in a section of their own, and
    // say where they come from rather than where they point: every one of them
    // is the same unreadable launch address with a different id on the end.
    const catalogue = bookmark.searchOnly === true
    return {
      key: `bookmark:${bookmark.id}`,
      supportsMultiline: false,
      label: bookmark.label,
      detail: catalogue ? (bookmark.group ?? '') : displayUrl(bookmark.url),
      icon: bookmark.icon
        ? { kind: 'favicon', src: bookmark.icon }
        : { kind: 'glyph', className: 'icon-[ph--bookmark-simple]' },
      section: catalogue ? 'catalogue' : 'go',
      outcome: {
        kind: 'choice',
        choice: inMode({ kind: 'url', url: bookmark.url, profile }, bookmark.label)
      }
    }
  }

  function actionChoice(action: LauncherAction): Choice {
    return {
      key: `action:${action.id}`,
      supportsMultiline: action.supportsMultiline,
      label: action.label,
      detail: action.detail,
      icon: { kind: 'glyph', className: action.icon },
      section: 'do',
      outcome: action.outcome
    }
  }

  /**
   * The field, so it can be given the keyboard back. Moving between the panel
   * and a prompt does not replace this element, but it does unmount the row
   * that was clicked to get there — and focus on an element that goes away
   * lands on the document, where a paste reaches nothing at all.
   */
  let field = $state<HTMLTextAreaElement | null>(null)

  $effect(() => {
    // Re-measure after typing, pasting, or returning from an extension prompt.
    void query
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`
  })

  /** Focus the field the moment the panel appears: it is what the panel is for. */
  function autofocus(node: HTMLTextAreaElement): void {
    node.focus()
  }

  function open(row: Choice | undefined): void {
    if (!row) return

    if (row.outcome.kind === 'prompt') {
      // The same field, asking something narrower. The input element is not
      // replaced, so focus stays where it already was and the user can simply
      // carry on typing — or, far more likely, paste.
      prompt = row.outcome.prompt
      query = ''
      selected = 0
      moved = false
      // Whether the row was taken with Enter or with the pointer, what happens
      // next is typing — or, far more likely, pasting.
      field?.focus()
      return
    }

    if (row.outcome.kind === 'extension') {
      void openExtensionEntry(row.outcome.prompt, row.outcome.value)
      return
    }

    if (row.outcome.kind === 'extension-action') {
      void openExtensionAction(row.outcome.entry)
      return
    }

    if (row.outcome.kind === 'typed') {
      void openTypedEntry(row.outcome.entry, row.outcome.text)
      return
    }

    api.submit(row.outcome.choice)
  }

  /** Asks an extension for what one of its entries names — a tab, or a task — and hands it over. */
  async function openExtensionEntry(key: string, value: unknown): Promise<void> {
    const found = prompting.find((candidate) => candidate.key === key)
    if (!found) return
    const choice = await found.take(value)
    if (choice) api.submit(choice)
  }

  /**
   * The same, for an entry that needs nothing typed to know its tab. One that
   * asks something else on the way — a folder, with the OS picker — may come
   * back with nothing, which leaves the panel exactly as it was: the right
   * answer to changing your mind. The panel stays up while such a picker is,
   * held open in main, since a sheet's key status arrives here as the blur that
   * usually dismisses it.
   */
  async function openExtensionAction(key: string): Promise<void> {
    const found = entries.find((candidate) => candidate.key === key)
    if (!found || found.prompt) return
    const choice = await found.take(undefined)
    if (choice) api.submit(choice)
  }

  /** Asks an extension for the task or tab it opens for what was typed, and hands it over. */
  async function openTypedEntry(key: string, text: string): Promise<void> {
    const found = typedEntries.find((candidate) => candidate.key === key)
    if (!found) return
    const choice = await found.take(text)
    if (choice) api.submit(choice)
  }

  /** Out of a prompt and back to the panel proper. */
  function back(): void {
    prompt = null
    query = ''
    selected = 0
    moved = false
    field?.focus()
  }

  /**
   * Right-clicking a row asks the question Enter answers by default — which
   * login a page should open as, or whichever other answers an extension's row
   * offers (a folder other than this project's, say).
   *
   * Handed to the main process whole rather than answered here. The menu has to
   * be a native one, because this window is sized to the panel inside it and
   * anything drawn in the document would be clipped by the window's own edge a
   * row or two down — and a native menu over this window can count as looking
   * away, which is what closes the panel. So the panel asks the question and
   * hears nothing back: whether it survives to see the answer is no longer
   * something that matters.
   *
   * Only for the rows that have a second answer. A terminal has no session to
   * be in, and an extension's row has only the ones it offers.
   */
  function pick(row: Choice, event: MouseEvent): void {
    event.preventDefault()
    if (incognito) return

    const entryKey =
      row.outcome.kind === 'extension-action'
        ? row.outcome.entry
        : row.outcome.kind === 'prompt' || row.outcome.kind === 'extension'
          ? row.outcome.prompt
          : null
    if (entryKey !== null) {
      const alternatives = entries.find((candidate) => candidate.key === entryKey)?.alternatives
      if (alternatives?.length) {
        api.chooseAlternative(
          entryKey,
          alternatives.map(({ id, label }) => ({ id, label }))
        )
      }
      return
    }

    if (row.outcome.kind !== 'choice') return
    if (row.outcome.choice.kind !== 'url') return
    api.openInProfile(row.outcome.choice.url)
  }

  /**
   * Arrow keys walk the list and Enter takes the row it lands on. Wrapped at
   * both ends, because the list is short enough that running off the bottom is
   * a way of reaching the top rather than a mistake. Escape is not here — the
   * main process closes the panel wherever focus is (see
   * src/main/launcher-window.ts), so it holds for the list as well as the field.
   *
   * Which is also why backing out of a prompt is backspace rather than escape:
   * escape already means "never mind" for the whole panel, and a key that meant
   * one thing on one screen and another thing on the next would be worse than
   * either. Backspace on an empty field is the palette idiom, and it is what
   * the hand does anyway after clearing a bad paste.
   */
  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return
    // Shift+Enter belongs to the textarea, including when there are no choices.
    if (event.key === 'Enter') {
      if (event.shiftKey) return
      event.preventDefault()
      // A new tab has nothing to open until it is told.
      if (idle) return
      open(choices[selected])
      return
    }
    if (prompt !== null && event.key === 'Backspace' && query === '') {
      event.preventDefault()
      back()
      return
    }

    if (choices.length === 0) return

    // Keep ordinary arrows for editing multiline text. Option/Alt+arrows
    // still move through the launcher's results without leaving the field.
    if (multiline && event.target === field && !event.altKey) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selected = (selected + 1) % choices.length
      moved = true
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      selected = (selected - 1 + choices.length) % choices.length
      moved = true
    }
  }

  /** What the field says it is for, while it is not asking something narrower. */
  const fieldLabel =
    mode === 'task'
      ? 'Search or enter address in a new task'
      : incognito
        ? 'Search or enter address in incognito'
        : 'Search or enter address'

  /** The panel itself, measured so the window can be sized to it. */
  let panel = $state<HTMLElement | null>(null)

  /**
   * Tells the window how tall the panel actually is. The list grows and shrinks
   * as the query filters it, and the window is sized off this rather than off a
   * guess — a panel is otherwise either clipped or trailing empty glass below
   * its last row.
   *
   * Nothing here reads the window's own height, so this cannot chase itself:
   * the panel is sized by its content, and the window follows.
   */
  $effect(() => {
    const element = panel
    if (!element) return undefined

    const report = (): void => api.resize(element.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  })
</script>

<svelte:window onkeydown={onKeydown} />

<!-- No background of its own: the window's vibrancy material, under the tint
     its body is laid with (`body[data-panel]` in main.css), is what the panel is
     made of, and anything opaque here would cover it. -->
<div bind:this={panel} class="flex max-h-[520px] flex-col text-ink-100 select-none text-on-glass">
  <!-- The field, and the whole of the panel while nothing is typed. The border
       is the only line in the panel: it is the seam between what you are saying
       and what the panel is offering back. -->
  <div class="flex shrink-0 items-start gap-2.5 border-b border-white/10 px-4 py-3.5">
    {#if asking}
      <!-- The way back, and the chip that says the field is no longer the
           search field. Both are needed: the chip alone would leave somebody
           who picked the wrong row with nothing but escape, which throws the
           whole panel away rather than the step they are in. -->
      <button
        type="button"
        onclick={back}
        aria-label="Back to everything"
        class="-ml-1.5 grid size-6 shrink-0 place-items-center rounded-md glass-control
               text-ink-400 hover:text-ink-100"
      >
        <span class="icon-[ph--caret-left] text-sm" aria-hidden="true"></span>
      </button>
      <span
        class="flex shrink-0 items-center gap-1.5 rounded-md bg-white/10 px-2 py-1
               text-[0.6875rem] font-medium text-ink-200"
      >
        <span class="{asking.icon} text-xs" aria-hidden="true"></span>
        {asking.label}
      </span>
    {:else}
      <span
        class="{incognito
          ? 'icon-[ph--detective]'
          : 'icon-[ph--magnifying-glass]'} shrink-0 text-base text-ink-500"
        aria-hidden="true"
      ></span>
    {/if}
    <textarea
      use:autofocus
      bind:this={field}
      bind:value={query}
      oninput={() => {
        selected = 0
        moved = false
      }}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      rows="1"
      aria-label={asking?.placeholder ?? fieldLabel}
      placeholder={asking?.placeholder ?? fieldLabel}
      class="w-full min-w-0 cursor-text resize-none overflow-y-auto bg-transparent text-sm text-ink-50 outline-none
             placeholder:text-ink-500"
    ></textarea>
  </div>

  <!-- Scrolls rather than growing without end: the window caps the panel's
       height (see MAX_HEIGHT in src/main/launcher-window.ts), and a list that
       outgrew that cap would otherwise be cut off with no way to reach the rest. -->
  {#if guidance}
    <!-- The whole of the panel below the field while what was typed into a
         prompt is not what it asks for. -->
    <p class="px-4 py-3 text-[0.6875rem] leading-relaxed text-ink-500">{guidance}</p>
  {/if}

  <!-- Nothing at all rather than an empty box: a list with no rows in it is
       still a strip of padding under the field, which reads as the panel having
       lost something. -->
  {#if choices.length > 0}
    <ul
      use:keepSelectionInView
      aria-label={mode === 'task' ? 'New task' : incognito ? 'Open in incognito' : 'Open'}
      class="flex max-h-96 min-h-0 flex-col gap-0.5 overflow-y-auto p-1.5"
    >
      {#each choices as choice, index (choice.key)}
        <!-- The seam between one band of the panel and the next, and the whole of
           what marks them apart — the same line the sidebar draws between a
           task's pinned tabs and the rest. Drawn on the first row below it
           rather than after the last row above it, so a query that empties a
           whole band leaves no line hanging over nothing. -->
        {#if index > 0 && choice.section !== choices[index - 1].section}
          <li class="mx-1 my-1.5 h-px bg-white/10" role="separator"></li>
        {/if}

        <li>
          <!-- Mouse movement and arrow keys share one selection and highlight. -->
          <button
            type="button"
            aria-current={index === selected}
            use:selectOnMouseMove={() => {
              selected = index
              moved = true
            }}
            onclick={() => open(choice)}
            oncontextmenu={(event) => pick(choice, event)}
            class="flex w-full items-center gap-2.5 rounded-lg glass-control px-2.5 py-2 text-left"
          >
            {#if choice.icon.kind === 'favicon'}
              <!-- Dimmed rather than tinted. A glyph can take the row's text
                 colour and still be itself; a favicon cannot, so the step back
                 an unselected row takes has to be made out of opacity.

                 `object-contain` because half the catalogue's logos are
                 wordmarks, not marks — Okta draws its tiles wide, and a 420x71
                 strip stretched into a square box is the brand rendered as a
                 smear. Letterboxed it is at least the right shape and the right
                 colour, which is all a 16px row was ever going to carry. -->
              <img
                src={choice.icon.src}
                alt=""
                class="size-4 shrink-0 object-contain {index === selected
                  ? 'opacity-100'
                  : 'opacity-65'}"
              />
            {:else}
              <span
                class="{choice.icon.className} shrink-0 text-base {index === selected
                  ? 'text-ink-200'
                  : 'text-ink-500'}"
                aria-hidden="true"
              ></span>
            {/if}
            <span class="min-w-0 flex-1 truncate text-xs text-ink-100">{choice.label}</span>
            {#if choice.detail}
              <span class="max-w-[40%] truncate text-[0.6875rem] text-ink-500">{choice.detail}</span
              >
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <ShortcutBar
    hints={[
      { keys: ['up', 'down'], label: 'Navigate' },
      ...(idle ? [] : [{ keys: ['Enter'], label: 'Select' }]),
      ...(asking ? [{ keys: ['Backspace'], label: 'Back' }] : []),
      { keys: ['Esc'], label: 'Close' }
    ]}
  />
</div>
