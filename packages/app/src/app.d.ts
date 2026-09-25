import type { RateLimit } from '@cloudflare/workers-types'

// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    interface Platform {
      env: {
        /** `wrangler secret put SLACK_CLIENT_ID`. Public, since it is in every authorize URL, but kept out of the repo. */
        SLACK_CLIENT_ID: string
        /** Secret; `wrangler secret put SLACK_CLIENT_SECRET`. */
        SLACK_CLIENT_SECRET: string
        /** Secret; `wrangler secret put OAUTH_SIGNING_KEY`. Signs tickets and grants. */
        OAUTH_SIGNING_KEY: string
        OAUTH_RATE_LIMIT?: RateLimit
      }
      ctx: ExecutionContext
      caches: CacheStorage
      cf?: IncomingRequestCfProperties
    }
  }
}

export {}
