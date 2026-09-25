import type { OAuthError, TokenResponse } from '@fluid/extension-slack/oauth'
import { SLACK_USER_SCOPES } from '@fluid/extension-slack/scopes'
import type { OAuthEnv } from './env'

/**
 * The two Slack calls the Worker makes, and the one it sends the browser to.
 *
 * Only user scopes are asked for, as `user_scope`. The plain `scope` parameter
 * is for bot scopes, and asking for none there means Slack issues no bot token
 * at all — there is nothing to keep safe that the extension does not use.
 */

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize'
const API_BASE = 'https://slack.com/api'
const REQUEST_TIMEOUT_MS = 10_000

export function authorizeUrl(env: OAuthEnv, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', env.clientId)
  url.searchParams.set('user_scope', SLACK_USER_SCOPES.join(','))
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  return url.href
}

type AccessResponse = {
  ok: boolean
  error?: string
  authed_user?: { id?: string; scope?: string; access_token?: string; token_type?: string }
  team?: { id?: string; name?: string } | null
}

export type Exchange =
  { ok: true; response: TokenResponse } | { ok: false; status: number; error: OAuthError }

/**
 * Redeems a code with the client secret. The credentials go as HTTP Basic auth,
 * which is what Slack recommends over form fields.
 *
 * Only the user token comes back out, with the few facts the extension shows;
 * the rest of Slack's answer stays here.
 */
export async function exchangeCode(
  env: OAuthEnv,
  code: string,
  redirectUri: string
): Promise<Exchange> {
  const response = await fetch(`${API_BASE}/oauth.v2.access`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.clientId}:${env.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'
    },
    body: new URLSearchParams({ code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    return failure(502, 'slack_unavailable', `Slack returned HTTP ${response.status}.`)
  }

  const body = (await response.json()) as AccessResponse
  if (!body.ok) {
    const reason = body.error ?? 'unknown_error'
    return failure(400, reason, `Slack would not complete the sign-in (${reason}).`)
  }

  const user = body.authed_user
  if (!user?.access_token || !user.id) {
    return failure(
      502,
      'no_user_token',
      'Slack did not issue a user token. Check the app asks for user token scopes.'
    )
  }

  return {
    ok: true,
    response: {
      token: user.access_token,
      scopes: (user.scope ?? '')
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope !== ''),
      userId: user.id,
      team: { id: body.team?.id ?? '', name: body.team?.name ?? null }
    }
  }
}

function failure(status: number, error: string, message: string): Exchange {
  return { ok: false, status, error: { error, message } }
}
