import { redirect } from '@sveltejs/kit'
import {
  CALLBACK_PATH,
  CHALLENGE_PATTERN,
  STATE_PATTERN,
  isValidLoopbackPort
} from '@fluid/extension-slack/oauth'
import { oauthEnv } from '$lib/server/env'
import { issueTicket } from '$lib/server/flow'
import { messagePage } from '$lib/server/page'
import { authorizeUrl } from '$lib/server/slack'
import type { RequestHandler } from './$types'

/**
 * Step 2: the desktop has opened this in the browser. Everything it sent is
 * folded into a signed ticket, which rides through Slack as `state` and is the
 * only way the callback learns where to send the browser next.
 */
export const GET: RequestHandler = async ({ url, platform }) => {
  const env = oauthEnv(platform)
  const challenge = url.searchParams.get('challenge') ?? ''
  const state = url.searchParams.get('state') ?? ''
  const port = Number(url.searchParams.get('port'))

  if (
    !CHALLENGE_PATTERN.test(challenge) ||
    !STATE_PATTERN.test(state) ||
    !isValidLoopbackPort(port)
  ) {
    return messagePage(
      400,
      'This link cannot connect Slack',
      'Go back to Fluid and choose Connect Slack in settings.'
    )
  }

  const ticket = await issueTicket({ challenge, state, port }, env.signingKey)
  redirect(302, authorizeUrl(env, `${url.origin}${CALLBACK_PATH}`, ticket))
}
