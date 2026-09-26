# @fluid/extension-vscode

Embeds the workbench served by the user's VS Code installation. Follow the
[shared development setup](../../packages/sdk/README.md#develop-a-built-in-extension)
with VS Code installed locally. The first launch may download its web server.

## Working on the integration

- [server.ts](src/main/server.ts) discovers the CLI, starts `code serve-web`,
  and manages the shared server's port and connection token.
- [workspaces.ts](src/main/workspaces.ts) creates and removes per-tab workspace files.
- [glass.ts](src/main/glass.ts) styles the embedded workbench.
- [renderer/index.ts](src/renderer/index.ts) handles folder selection and launcher entries.

Keep the localhost origin stable across launches: the workbench's sign-in and
settings are stored against it. The server is shared by all editor tabs and
stops when the extension is disabled or the app quits.

Check two folders in separate tabs, keyboard shortcuts, Settings Sync sign-in,
and persistence after restart. Closing one tab should remove its workspace file
without interrupting the other editor.
