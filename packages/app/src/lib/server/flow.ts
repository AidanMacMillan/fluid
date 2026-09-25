import { sha256, sign, verify } from './signed'

/**
 * The two signed values the flow passes through the browser, and the checks
 * that make them worth trusting. See `@fluid/extension-slack/oauth` for the
 * flow as a whole.
 *
 * Each carries its kind, so a ticket can never be presented as a grant or the
 * other way round, and an expiry, so one found in a browser's history later is
 * worth nothing.
 */

/** Long enough to read Slack's consent screen; not long enough to be kept. */
const TICKET_LIFETIME_MS = 10 * 60 * 1000
/** Slack's codes last ten minutes; the extension redeems its grant in seconds. */
const GRANT_LIFETIME_MS = 5 * 60 * 1000

/**
 * Made at the start, carried through Slack as its `state`: which loopback port
 * to return to, the extension's own state to return with, and the challenge the
 * eventual verifier has to meet.
 */
export type Ticket = { challenge: string; state: string; port: number }

/**
 * Made when Slack returns, once the Worker holds both the code and the
 * challenge: the binding between the two. Without it, a code caught on its way
 * to the loopback could be redeemed alongside a challenge somebody else made,
 * and PKCE would protect nothing.
 */
export type Grant = { codeHash: string; challenge: string }

type Signed<K extends string, T> = T & { kind: K; expires: number }

async function read<K extends string, T>(
  value: string | null,
  kind: K,
  secret: string
): Promise<T | null> {
  if (!value) return null
  const payload = (await verify(value, secret)) as Signed<K, T> | null
  if (payload === null || typeof payload !== 'object') return null
  if (payload.kind !== kind) return null
  if (typeof payload.expires !== 'number' || payload.expires < Date.now()) return null
  return payload
}

export function issueTicket(ticket: Ticket, secret: string): Promise<string> {
  return sign({ ...ticket, kind: 'ticket', expires: Date.now() + TICKET_LIFETIME_MS }, secret)
}

export async function readTicket(value: string | null, secret: string): Promise<Ticket | null> {
  const ticket = await read<'ticket', Ticket>(value, 'ticket', secret)
  if (!ticket) return null
  return { challenge: ticket.challenge, state: ticket.state, port: ticket.port }
}

export async function issueGrant(code: string, challenge: string, secret: string): Promise<string> {
  const grant: Grant = { codeHash: await sha256(code), challenge }
  return sign({ ...grant, kind: 'grant', expires: Date.now() + GRANT_LIFETIME_MS }, secret)
}

export async function readGrant(value: string | null, secret: string): Promise<Grant | null> {
  const grant = await read<'grant', Grant>(value, 'grant', secret)
  if (!grant) return null
  return { codeHash: grant.codeHash, challenge: grant.challenge }
}
