# @fluid/desktop

The Electron app, built with Svelte and TypeScript. This package owns the
windows, browser sessions, local database, and extension host.

## Development

Use Node.js 24 and pnpm 12, matching CI. From the repository root:

```bash
pnpm install
pnpm dev
```

Workspace packages are bundled from source; they do not need separate builds.

```bash
pnpm typecheck   # check every workspace package
pnpm lint
pnpm build      # typecheck and build the desktop app
pnpm start      # preview the built app
```

To check only this package, run `pnpm --filter @fluid/desktop typecheck`.
Packaging, signing, and updates are covered in the [release guide](../../docs/releases.md).

## Where to work

| Area                                   | Location                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Workspace operations and change events | [src/main/api](src/main/api)                                                                       |
| Database schema and queries            | [src/main/db](src/main/db)                                                                         |
| Browser tabs and sessions              | [browser-views.ts](src/main/browser-views.ts), [profile-sessions.ts](src/main/profile-sessions.ts) |
| Extension loading and isolation        | [src/main/extensions](src/main/extensions)                                                         |
| Window bridges                         | [src/preload](src/preload)                                                                         |
| Svelte UI and client state             | [src/renderer/src](src/renderer/src)                                                               |
| Build entries and bundling             | [electron.vite.config.ts](electron.vite.config.ts)                                                 |

Route workspace changes through the API so all windows and extensions receive
consistent events. Tab and task cleanup is centralized in
[teardown.ts](src/main/api/teardown.ts). Shared contracts and extension authoring
belong in the [SDK](../sdk/README.md).

## Database changes

Edit [schema.ts](src/main/db/schema.ts), then generate and check migrations:

```bash
pnpm --filter @fluid/desktop db:generate
pnpm --filter @fluid/desktop db:check
```

Commit the generated files in [resources/migrations](resources/migrations).
The app applies them at startup to its PGlite database under Electron's
`userData/pglite` directory.

## Focused checks

Run the script relevant to the change with `pnpm --filter @fluid/desktop <script>`:

| Script           | Coverage                                             |
| ---------------- | ---------------------------------------------------- |
| `test:isolation` | Installed extension sandbox, using an Electron probe |
| `test:adblocker` | Ad blocking integration in Electron                  |
| `test:updater`   | Release and update configuration                     |

Filter snapshot maintenance is documented in
[resources/adblocker](resources/adblocker/README.md). Claude CLI checks live with
the [Claude Code extension](../../extensions/claude-code/README.md).
