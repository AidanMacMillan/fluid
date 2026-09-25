# Fluid

A desktop workspace, built with Electron, Svelte and TypeScript.

## Packages

| Package                        | Path                     | What it is                                                                                                    |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `@fluid/desktop`               | `packages/desktop`       | The app: main process, preload and renderer. Owns the database and the API.                                   |
| `@fluid/sdk`                   | `packages/sdk`           | The contract between the app and its extensions: the API's methods, its events, and `defineExtension`.        |
| `@fluid/app`                   | `packages/app`           | The web side, a SvelteKit app on Cloudflare Workers. For now, the server half of connecting Slack over OAuth. |
| `@fluid/extension-slack`       | `extensions/slack`       | Slack threads in tabs, read and replied to as the user, and the client other extensions reach Slack through.  |
| `@fluid/extension-claude-code` | `extensions/claude-code` | Claude Code sessions in tabs, and the MCP tools that let them act on the task they sit in.                    |
| `@fluid/extension-vscode`      | `extensions/vscode`      | Folders open in the user's own VS Code, as tabs: the web workbench their install serves.                      |
| `@fluid/extension-image`       | `extensions/image`       | The viewer for image file tabs, to zoom into and pan around.                                                  |
| `@fluid/extension-video`       | `extensions/video`       | The player for video file tabs.                                                                               |
| `@fluid/extension-html`        | `extensions/html`        | HTML file tabs, rendered natively in a throwaway session and read at a chosen width.                          |
| `@fluid/extension-pdf`         | `extensions/pdf`         | PDF file tabs, in Chromium's own viewer.                                                                      |
| `@fluid/extension-terminal`    | `extensions/terminal`    | Terminal tabs: a shell behind each one, which outlives its view and closes its tab when it exits.             |

## Development

```bash
pnpm install
pnpm dev         # run the app
pnpm typecheck   # every package
pnpm lint
```

For GitHub-hosted Mac releases, signing setup, and automatic updates, see
[the release guide](docs/releases.md).

Database migrations are generated from `packages/desktop`:

```bash
pnpm --filter @fluid/desktop db:generate
```

## Architecture

### The workspace API

Everything the app does to its data goes through one API, defined in
`packages/sdk/src/api.ts` and implemented in `packages/desktop/src/main/api`:

- **Namespaces:** spaces, projects, tasks, notes, tabs, files, bookmarks,
  profiles, settings, notifications, extensions and ui.
- **Input:** every method takes a single object, validated against a zod schema
  before anything runs.
- **Events:** every write announces what changed as a typed event (see
  `packages/sdk/src/events.ts`).
- **Callers:** the same implementation serves two kinds of caller.
  - The app's windows, over IPC (`window.fluid`, wrapped by
    `src/renderer/src/lib/api.ts`).
  - Extensions, in-process (`ctx.api`). This includes Claude Code sessions,
    whose MCP tools are the Claude Code extension's
    (`extensions/claude-code/src/main/tools.ts`).

```ts
const task = await api.tasks.create({ projectId, title: 'Review' })
await api.tabs.open({ taskId: task.id, tab: { type: 'browser', payload: { url } } })

api.on('task.updated', ({ task, previous }) => {
  /* … */
})
const stop = api.watch('tasks.list', { projectId, status: 'open' }, (tasks) => draw(tasks))
```

A tab can report work going on in it with `tabs.setActivity`. `working` puts a
yellow dot on its row. `waiting` puts a blue one there until the work moves on,
and `done` puts a blue one there until the user has the tab open. Each task's
tab in the strip shows its tabs' dots rolled into one, with blue winning. Claude
Code tabs set it for each turn and while waiting on an approval or a question.
Terminals set it for each command.

Closing a tab, settling a task or deleting one stops whatever its tabs were
running. `src/main/api/teardown.ts` does this in reaction to the events, so
every caller gets the same cleanup.

### Extensions

An extension is a `defineExtension({ id, activate(ctx) })` in its main-process
half, plus an optional `defineRendererExtension(...)` for the windows.

Through `ctx`, an extension gets:

- the API;
- private storage and secrets, and a data folder of its own;
- scheduled jobs;
- task types, tab types and bookmarks it can register — a tab type can hook
  `onStop` (its task was settled, or it is closing) and `onClose` (its rows are
  gone), declare a zod `payload` schema the app checks every new tab against,
  and offer itself to agents with an `agentDescription` (Claude Code's
  `open_tab` tool opens any type that does);
- file viewers: media types it draws file tabs of (`ctx.fileViewers`), in a
  page of its own or by asking the app to render the file natively. A file no
  running extension claims says it cannot be shown;
- RPC methods for its own interface and for other extensions, and
  `ctx.extensions.call` to reach another's. An extension that reads Slack does
  it this way, through the Slack extension's typed client in
  `extensions/slack/src/api.ts`, and never holds its token;
- URL schemes it declared.

A tab type registered with a `view` is drawn in a view of its own, of one of
two kinds. A `page` view is a separate page, in its own process, that mounts the
extension's `ExtensionView` (exported from its `./views`) and talks to the app
through a bridge. A `web` view is a web application the extension names the
address of — VS Code's workbench, served by a process the extension runs — in a
persisted session of the extension's own, held to its origin, with the keys and
stylesheet its type asks for.

Its renderer half can add launcher entries that ask for a line of input
(`prompt` and `parse`) or open their tab as soon as they are taken. An entry's
detail and tab can depend on the active project's folder, and its right-click
menu can offer `alternatives`; `host.chooseFolder()` asks for a folder.

It can add kinds of task to the new-task panel (Cmd+Shift+T, or the plus at
the end of the task strip) the same way, as `newTask` entries. Those answer
with a `NewTaskTemplate` — a title, a task type, facts and the tabs it opens
with — rather than a tab. The panel always leads with a blank task, which is
where it opens, so Cmd+Shift+T and Enter is still a blank task.

Its settings are a section of the settings window, listed below the app's own
sections. The section is a page of the extension's: its `Extension` sets
`settings`, and its views' `settings` draws the page, which the app lays over
the panel. A renderer half has no settings of its own, so built-in and
installed extensions do settings the same way.

Everything it registers is held in memory and taken back when it is disabled,
so nothing it contributes outlives it.

### Built-in and installed extensions

A built-in extension is one of the workspace's packages, compiled into the app
and run in its main process, as trusted as the app's own code: see `BUILT_IN`
in `packages/desktop/src/main/extensions/host.ts` and `RENDERERS` in
`packages/desktop/src/renderer/src/lib/extensions.svelte.ts`.

An installed extension is built on its own and lives in the app's data folder,
`installed-extensions/<id>/` under Electron's `userData`
(`~/Library/Application Support/Fluid` on macOS). The folder holds:

- `fluid-extension.json`, the manifest (`ExtensionManifest` in the SDK): its
  id, name, version, the SDK range it works with, its `permissions`, and the
  files below;
- its main half, a browser ES module whose default export is its `Extension`,
  with everything it uses bundled in;
- optionally its view half, an ES module whose default export is its
  `ExtensionViews`, with its own copy of Svelte, and a stylesheet.

Install one with **Install from folder…** in Settings → Extensions: pick the
built folder, or the package it was built in if that has a `dist/`. Installed
rows have **Show folder** and **Remove**, which also deletes everything the
extension stored (its storage, secrets and data folder), so nothing is left
for the next extension installed under the same id. Installing, updating and removing
take effect straight away, except for an extension declaring a URL scheme it
didn't have when the app started, which waits for a relaunch.

#### What an installed extension can do

It is not trusted like the app's own code:

- **It runs only once you've approved its exact files.** The app reads the
  folder whole into memory, hashes every file, and runs and serves only that
  copy. Installing through the app approves it; so does **Review…** on a
  folder the app found but didn't install, or one whose files changed. The
  approval is kept in the encrypted secret vault, which other programs can't
  write to, so dropping a folder into the data folder doesn't make it run.
- **Its main half runs in a sandboxed page with no Node** (see
  `src/main/extensions/isolation`). It can't touch the disk, start processes or
  read another extension's data. Stopping, updating or removing it closes the
  page, so none of its code keeps running.
- **Everything beyond the workspace needs a permission** in its manifest, and
  the install sheet lists them:
  - `hosts`: where `fetch` may go, and where a `web` tab view may point (https
    only, in sessions with none of your cookies; each redirect is checked
    again);
  - `commands`: what `ctx.process.run` may run (by name, on PATH, no shell,
    with a minimal environment). A command runs as you, so the install sheet
    says so;
  - `extensions`: which other extensions it may call, or open tabs of.
- **The workspace API is narrowed** for it and its views (see
  `src/main/api/isolation-policy.ts`): no importing files from disk, no app
  settings, no turning extensions on or off, no wiping profiles or deleting
  projects and spaces.
- **Its pages are locked down**: no frames, no peer-to-peer connections, no
  permission prompts, and links out of them open only web pages and email.
  Its URL schemes must start with its id and a dash (`acme-media` for `acme`), and are
  served to its own pages only, never the app's windows.

It has no renderer half: it can't put components into the app's windows.
Everything it draws is in pages of its own: tab and file views, and its
settings section. Its stylesheet builds against `@fluid/sdk/theme.css`, which
names the app's colours and the utilities extensions draw with, so it follows
the user's theme. The app refuses an extension built for another SDK than
`SDK_VERSION`, which goes up whenever the contract changes in a way an
extension built earlier would break on.

`pnpm --filter @fluid/desktop test:isolation` runs the sandbox's test in
Electron: a probe extension that tries every way out, through the real page
and proxy.
