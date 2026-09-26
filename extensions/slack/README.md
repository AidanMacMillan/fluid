# @fluid/extension-slack

Slack thread tabs and the typed Slack client used by other extensions.
Use the [shared development setup](../../packages/sdk/README.md#develop-a-built-in-extension);
OAuth configuration and local server setup live in the [web app guide](../../packages/app/README.md).

## Where to work

| Area                                 | Source                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| Slack requests and caches            | [main/slack.ts](src/main/slack.ts)                                                         |
| Replies, reactions, and thread state | [main/slack-thread.ts](src/main/slack-thread.ts)                                           |
| Desktop sign-in and token storage    | [main/oauth.ts](src/main/oauth.ts), [main/token.ts](src/main/token.ts)                     |
| Authenticated media                  | [main/slack-media.ts](src/main/slack-media.ts)                                             |
| Thread UI and settings               | [renderer/components](src/renderer/components), [renderer/settings](src/renderer/settings) |
| Page mounts                          | [views/index.svelte.ts](src/views/index.svelte.ts)                                         |
| Public extension client              | [api.ts](src/api.ts)                                                                       |

Other extensions should use `slackService(ctx.extensions)` from
`@fluid/extension-slack/api`. Keep credentials in this extension's secrets;
RPC responses and media URLs must never expose the token.

Check connection and disconnection, opening a thread from a permalink, replies,
reactions, and private file previews in a test workspace. When changing scopes or
the OAuth contract, update the server consumer as well.
