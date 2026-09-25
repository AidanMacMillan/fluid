# @fluid/app

The web side of Fluid: a SvelteKit app deployed to Cloudflare Workers. For now it
does one thing, which is the server half of connecting Slack. It holds the Slack
app's client secret so the desktop app never has to.

## The Slack flow

The desktop app never sees the client secret, and the browser never sees the
token. PKCE ties each code to the machine that started the sign-in. The contract
between the two sides lives in `extensions/slack/src/shared/oauth.ts`.

| Route                 | Called by       | Does                                                                                                                      |
| --------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /slack/connect`  | the browser     | Takes the desktop's PKCE challenge, state and loopback port, signs them into a ticket, and redirects to Slack.            |
| `GET /slack/callback` | Slack           | Checks the ticket, signs a grant that binds Slack's code to the challenge, and redirects to `http://127.0.0.1:<port>`.    |
| `POST /slack/token`   | the desktop app | Checks the grant covers this code and the verifier meets its challenge, then redeems the code and returns the user token. |

The Worker keeps no storage. Tickets and grants are HMAC-signed, expire within
ten minutes, and carry no secrets.

## Setting up the Slack app

In the Slack app's settings (api.slack.com/apps):

1. **OAuth & Permissions → Redirect URLs**: add
   `https://fluid-app.<account>.workers.dev/slack/callback`.
2. **OAuth & Permissions → User Token Scopes**: add every scope in
   `extensions/slack/src/main/slack-scopes.ts`. The Worker asks for exactly that
   list. Leave **Bot Token Scopes** empty.
3. Leave **token rotation** off. With it on, user tokens expire after 12 hours
   and nothing here refreshes them yet.
4. Leave distribution off. An undistributed app can only be installed in the
   workspace that owns it.

## Deploying

```bash
pnpm wrangler login
pnpm wrangler secret put SLACK_CLIENT_ID       # from Slack's Basic Information page
pnpm wrangler secret put SLACK_CLIENT_SECRET   # the same page
openssl rand -base64 32 | pnpm wrangler secret put OAUTH_SIGNING_KEY
pnpm deploy
```

The client ID is public, since it is in every authorize URL, but it is set as a
secret like the rest so that which Slack app this serves stays out of the repo.
Secrets also outlive `wrangler deploy`, which replaces plain vars with whatever
`wrangler.jsonc` says.

Changing `OAUTH_SIGNING_KEY` only cancels sign-ins that are in flight. Tokens
already issued are unaffected.

Observability is off in `wrangler.jsonc` on purpose: invocation logs record
request URLs, and the callback's URL carries an authorization code.

## Developing

```bash
cp .dev.vars.example .dev.vars   # then fill it in
pnpm dev                         # vite, with the Worker's bindings proxied
pnpm preview                     # the built Worker, under wrangler dev
```

To point the desktop app at a local Worker, start it with
`FLUID_APP_URL=http://localhost:8787`. For the sign-in to complete, Slack must
also accept `http://localhost:8787/slack/callback` as a redirect URL.
