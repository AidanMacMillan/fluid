import { error } from '@sveltejs/kit'

export type OAuthEnv = {
  clientId: string
  clientSecret: string
  signingKey: string
}

/**
 * The Worker's configuration, or a 500 when any of it is missing. A Worker
 * that half-works — signing with an empty key, say — is worse than one that
 * refuses, so nothing is defaulted.
 */
export function oauthEnv(platform: App.Platform | undefined): OAuthEnv {
  const env = platform?.env
  if (!env?.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET || !env.OAUTH_SIGNING_KEY) {
    error(500, 'The Slack connection is not configured.')
  }
  return {
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    signingKey: env.OAUTH_SIGNING_KEY
  }
}
