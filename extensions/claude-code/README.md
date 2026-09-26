# @fluid/extension-claude-code

Claude Code session management, conversation UI, and MCP tools for the current
task. Use the [shared development setup](../../packages/sdk/README.md#develop-a-built-in-extension)
and a local Claude Code installation signed in through the CLI.

## Where to work

| Area                                         | Source                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| Local CLI discovery and compatibility checks | [main/cli.ts](src/main/cli.ts)                                           |
| Session lifecycle and approvals              | [main/sessions.ts](src/main/sessions.ts)                                 |
| Task-scoped MCP tools                        | [main/tools.ts](src/main/tools.ts)                                       |
| Turn and event mapping                       | [main/turns.ts](src/main/turns.ts), [main/events.ts](src/main/events.ts) |
| Attachments and cleanup                      | [main/attachments.ts](src/main/attachments.ts)                           |
| Conversation components                      | [views/components](src/views/components)                                 |
| Messages exchanged with the view             | [shared/protocol.ts](src/shared/protocol.ts)                             |

The Agent SDK's manifest sets the minimum supported CLI version. Fluid uses the
local executable and Claude Code's stored transcripts; it keeps tab metadata and
attachments separately.

## Verification

Run the CLI discovery regression checks from the repository root:

```bash
pnpm --filter @fluid/desktop test:claude-cli
```

In the app, check a new turn, approval and question responses, interruption, and
resuming a session after restart. Changes to task tools should also be checked
against the session's task boundary; attachment changes should cover tab deletion.
