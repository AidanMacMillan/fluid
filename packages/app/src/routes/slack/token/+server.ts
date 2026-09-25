import { json } from '@sveltejs/kit'
import {
  CALLBACK_PATH,
  VERIFIER_PATTERN,
  type OAuthError,
  type TokenRequest
} from '@fluid/extension-slack/oauth'
import { oauthEnv } from '$lib/server/env'
import { readGrant } from '$lib/server/flow'
import { sameString, sha256 } from '$lib/server/signed'
import { exchangeCode } from '$lib/server/slack'
import type { RequestHandler } from './$types'

/**
 * Step 4: the desktop redeems its code. Called by the extension's main process,
 * never by a page, so there are no CORS headers and none are wanted.
 *
 * The code is only sent to Slack once the grant proves the Worker saw this very
 * code arrive for this challenge, and the verifier proves the caller is who made
 * the challenge.
 */
export const POST: RequestHandler = async ({ request, url, platform }) => {
  const env = oauthEnv(platform)
  const body = parse(await request.json().catch(() => null))
  if (!body) return refuse(400, 'invalid_request', 'Expected a code, a grant and a verifier.')

  const grant = await readGrant(body.grant, env.signingKey)
  if (!grant || !sameString(await sha256(body.code), grant.codeHash)) {
    return refuse(400, 'invalid_grant', 'This sign-in has expired. Start again.')
  }
  if (!sameString(await sha256(body.verifier), grant.challenge)) {
    return refuse(400, 'invalid_verifier', 'This sign-in was not started here. Start again.')
  }

  const exchange = await exchangeCode(env, body.code, `${url.origin}${CALLBACK_PATH}`)
  if (!exchange.ok) return json(exchange.error, { status: exchange.status })
  return json(exchange.response)
}

function parse(input: unknown): TokenRequest | null {
  if (typeof input !== 'object' || input === null) return null
  const { code, grant, verifier } = input as Record<string, unknown>
  if (typeof code !== 'string' || code === '' || code.length > 512) return null
  if (typeof grant !== 'string' || grant === '' || grant.length > 2048) return null
  if (typeof verifier !== 'string' || !VERIFIER_PATTERN.test(verifier)) return null
  return { code, grant, verifier }
}

function refuse(status: number, error: string, message: string): Response {
  const body: OAuthError = { error, message }
  return json(body, { status })
}
