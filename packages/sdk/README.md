# @fluid/sdk

The shared API, types, and extension interfaces for Fluid. Start here to build
an extension or change the contract between packages.

## What extensions can add

- Task types and actions, custom tabs, bookmarks, and scheduled jobs.
- File viewers, using an extension page or Chromium's native rendering.
- Settings pages, private storage and secrets, and declared URL schemes.
- Workspace operations through `ctx.api`, with typed events and live queries.
- RPC methods for their views and other extensions.

The contracts live in [extension.ts](src/extension.ts), [api.ts](src/api.ts),
[events.ts](src/events.ts), and [models.ts](src/models.ts).

## Define an extension

Export a `defineExtension` declaration from the main entry:

```ts
import { defineExtension } from '@fluid/sdk'

export default defineExtension({
  id: 'reviews',
  name: 'Reviews',
  activate(ctx) {
    ctx.taskTypes.register({ id: 'review', label: 'Review' })
  }
})
```

Contributions are namespaced by the extension ID: this task type is
`reviews.review`. Use `ctx.api` to create or update workspace records;
`api.on` subscribes to events and `api.watch` follows query results.

Registrations are removed on deactivation. Use `ctx.onDispose` for resources
you manage, tab `onStop` to end running work, and `onClose` to remove data for a
deleted tab. Validate RPC input before using it.

## Add an interface

Register a tab type with a `payload` schema and a `view`. Add
`agentDescription` to make that type available to coding agents.

- **Page views:** export `defineViews` with a `tabs` or `files` entry whose
  `mount` function draws into the supplied element. Use the host's API, RPC,
  and view connection to communicate with the extension.
- **Web views:** supply a URL for a web application. These views have their
  own browser session and no workspace bridge.
- **Settings:** declare `settings` on the extension and provide a `settings`
  mount function in its views export.

See [view.ts](src/view.ts) for mount interfaces and
[theme.css](src/theme.css) for shared styling, exported as `@fluid/sdk/theme.css`.

## Develop a built-in extension

Use the [desktop setup](../desktop/README.md#development), then run
`pnpm --filter <package-name> typecheck` for the package you change. Built-in
extensions are trusted code bundled with the app and can use Node.js.

For a new workspace extension:

1. Create a package under `extensions/` and add it to the
   [desktop dependencies](../desktop/package.json).
2. Register its main export in `BUILT_IN` in
   [host.ts](../desktop/src/main/extensions/host.ts).
3. If it has page views, add their loader to
   [EXTENSION_VIEWS](../desktop/src/renderer/src/lib/extension-views.ts).
4. For launcher entries, new-task templates, or UI inside the app's windows,
   export `defineRendererExtension` and add it to
   [RENDERERS](../desktop/src/renderer/src/lib/extensions.svelte.ts).
   See [renderer.ts](src/renderer.ts) for those interfaces.

Package-specific development notes:
[Claude Code](../../extensions/claude-code/README.md) ·
[Terminal](../../extensions/terminal/README.md) ·
[VS Code](../../extensions/vscode/README.md) ·
[Slack](../../extensions/slack/README.md) ·
[Image](../../extensions/image/README.md) ·
[Video](../../extensions/video/README.md) ·
[HTML](../../extensions/html/README.md) ·
[PDF](../../extensions/pdf/README.md)

## Build an installable extension

Bundle the main entry as a browser ES module with a default `Extension`
export and all dependencies included. Optional views are a separate ES module
with a default `ExtensionViews` export; bundle their UI runtime, including
Svelte if used. Installed extensions have no renderer entry in the app's windows.

Place `fluid-extension.json` at the root of the output folder:

```json
{
  "id": "reviews",
  "name": "Reviews",
  "version": "0.1.0",
  "sdk": "^0.2.0",
  "main": "main.js"
}
```

Add `views.script` and optional `views.styles` paths for an interface. The full
manifest, including scheme declarations, is defined in [manifest.ts](src/manifest.ts).

Select **Settings → Extensions → Install from folder…** and choose the output
folder, or a package containing it as `dist/`. Rebuild and reinstall to update.
New URL schemes require a relaunch; other updates take effect immediately.
Removing an installed extension also deletes its private storage, secrets, and data.

Installed code runs in a sandbox without Node.js or direct disk access. Its
workspace API is restricted; see the host's
[isolation policy](../desktop/src/main/api/isolation-policy.ts). Declare any
additional permissions in the manifest:

| Permission   | Allows                                                    |
| ------------ | --------------------------------------------------------- |
| `hosts`      | HTTPS requests and web views on the listed hosts          |
| `commands`   | Named commands through `ctx.process.run`, without a shell |
| `extensions` | Calls to, and tabs from, the listed extensions            |

Commands run as the user. Installation approves the exact bundled files and
permissions; changed files require review before they can run.

## Change the SDK

Run `pnpm --filter @fluid/sdk typecheck`, then the workspace checks in the
desktop guide to catch affected consumers. Keep `SDK_VERSION` in
[manifest.ts](src/manifest.ts) aligned with [package.json](package.json).
While the major version is zero, increment the minor for breaking contract changes.
