import type { Handle } from '@sveltejs/kit'

/**
 * Every OAuth route is rate limited per client address, and none of what they
 * return is ever cached or framed: a response here carries a code, a grant or
 * a token, and each is for exactly one request.
 */
export const handle: Handle = async ({ event, resolve }) => {
  const oauth = event.url.pathname.startsWith('/slack/')

  if (oauth) {
    const limiter = event.platform?.env.OAUTH_RATE_LIMIT
    const address = event.request.headers.get('cf-connecting-ip') ?? event.getClientAddress()
    if (limiter && !(await limiter.limit({ key: address })).success) {
      return new Response('Too many requests. Try again in a minute.', { status: 429 })
    }
  }

  const response = await resolve(event)
  response.headers.set('Referrer-Policy', 'no-referrer')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'DENY')
  if (oauth) response.headers.set('Cache-Control', 'no-store')
  return response
}
