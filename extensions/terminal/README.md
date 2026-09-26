# @fluid/extension-terminal

PTY-backed shell tabs. For shared setup and checks, see
[built-in extension development](../../packages/sdk/README.md#develop-a-built-in-extension).

## Working on terminals

- [sessions.ts](src/main/sessions.ts) owns `node-pty` processes, output replay,
  resizing, and tab activity.
- [integration.ts](src/main/integration.ts) adds zsh hooks for the current
  directory and command status.
- [TerminalPane.svelte](src/views/TerminalPane.svelte) draws the terminal with
  xterm.js; [shared/tab.ts](src/shared/tab.ts) defines its payload and messages.
- [renderer/index.ts](src/renderer/index.ts) supplies the launcher entry and
  sidebar presentation.

Keep processes independent of their views: switching away or reloading a view
must preserve the shell. Closing a tab or settling its task stops it; a shell
that exits closes its tab. Disabling the extension stops every shell.

After changes, check output replay, resizing, keyboard input, and working-directory
updates. Verify that `run` executes only on first start, while `command` runs
again when a shell is restored.
