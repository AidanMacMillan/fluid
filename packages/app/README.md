# @fluid/app

A SvelteKit app on Cloudflare Workers that handles Slack OAuth for the desktop.
It holds the Slack client secret and keeps no persistent storage.

## Local development

After the [repository setup](../desktop/README.md#development), run these commands
from `packages/app`:

```bash
cp .dev.vars.example .dev.vars   # fill in the three values
pnpm dev                         # Vite with Worker bindings
pnpm preview                     # build and run under wrangler dev
pnpm typecheck
```

For end-to-end sign-in, use the preview server and launch the desktop from the
repository root with `FLUID_APP_URL=http://localhost:8787 pnpm dev`. Use the
actual preview port if it differs, and register its `/slack/callback` URL in
Slack's redirect URLs.

## Slack app configuration

1. Add the deployed Worker's `/slack/callback` URL under **OAuth & Permissions →
   Redirect URLs**.
2. Add the **User Token Scopes** listed in
   [slack-scopes.ts](../../extensions/slack/src/main/slack-scopes.ts); leave bot scopes empty.
3. Keep token rotation off until refresh support is implemented.
4. Leave distribution off for an app used only by its owning workspace.

## Request flow

| Route                 | Responsibility                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `GET /slack/connect`  | Sign the desktop's PKCE challenge, state, and loopback port into a ticket; redirect to Slack. |
| `GET /slack/callback` | Validate the ticket and redirect to the desktop's loopback listener with a signed grant.      |
| `POST /slack/token`   | Validate the grant and PKCE verifier, then exchange the code for a user token.                |

The shared contract is [oauth.ts](../../extensions/slack/src/shared/oauth.ts).
Tickets and grants expire after ten minutes. The token returns directly to the
desktop; it does not pass through the browser.

## Deployment

From this package directory:

```bash
pnpm wrangler login
pnpm wrangler secret put SLACK_CLIENT_ID
pnpm wrangler secret put SLACK_CLIENT_SECRET
openssl rand -base64 32 | pnpm wrangler secret put OAUTH_SIGNING_KEY
pnpm deploy
```

Set the desktop's `FLUID_APP_URL` to the deployed origin; its current default is
a placeholder. Rotating `OAUTH_SIGNING_KEY` cancels in-flight sign-ins without
affecting issued tokens. Keep invocation logging disabled in
[wrangler.jsonc](wrangler.jsonc), since callback URLs contain authorization codes.
