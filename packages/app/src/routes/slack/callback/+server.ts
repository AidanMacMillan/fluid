import { redirect } from '@sveltejs/kit'
import { LOOPBACK_PATH } from '@fluid/extension-slack/oauth'
import { oauthEnv } from '$lib/server/env'
import { issueGrant, readTicket } from '$lib/server/flow'
import { messagePage } from '$lib/server/page'
import type { RequestHandler } from './$types'

/** Slack's codes are far shorter; anything longer is not one. */
const MAX_CODE_LENGTH = 512

/**
 * Step 3: Slack has sent the browser back. The ticket says which loopback port
 * started this; the code is bound to the ticket's challenge in a grant, and the
 * browser goes on to the desktop with both.
 *
 * The destination is always 127.0.0.1 and only the port comes from the ticket,
 * which the Worker signed itself — so no request can steer a code anywhere
 * else.
 */
export const GET: RequestHandler = async ({ url, platform }) => {
  const env = oauthEnv(platform)
  const ticket = await readTicket(url.searchParams.get('state'), env.signingKey)
  if (!ticket) {
    return messagePage(
      400,
      'This sign-in has expired',
      'Go back to Fluid and choose Connect Slack in settings to start again.'
    )
  }

  const loopback = new URL(`http://127.0.0.1:${ticket.port}${LOOPBACK_PATH}`)
  loopback.searchParams.set('state', ticket.state)

  const code = url.searchParams.get('code')
  if (!code || code.length > MAX_CODE_LENGTH) {
    // Declined, most often. Passed on so the desktop can stop waiting rather
    // than sit out its timeout.
    const reason = url.searchParams.get('error') ?? ''
    loopback.searchParams.set('error', /^[a-z_]{1,64}$/.test(reason) ? reason : 'invalid_request')
    redirect(302, loopback.href)
  }

  loopback.searchParams.set('code', code)
  loopback.searchParams.set('grant', await issueGrant(code, ticket.challenge, env.signingKey))
  redirect(302, loopback.href)
}
