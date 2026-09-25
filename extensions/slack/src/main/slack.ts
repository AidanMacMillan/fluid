import { getToken } from './token'
import { missingFrom } from './slack-scopes'

/**
 * The slice of Slack's Web API the app actually calls.
 *
 * Everything here runs on a **user** token (`xoxp-`), not a bot one, and that
 * is the single most consequential fact about this module. A bot token would be
 * cheaper to get and would read a channel perfectly well, but it cannot be the
 * user: a reaction added with one shows up as the app reacting, a reply posts
 * with the app's name and an app badge beside it, and the user's own direct
 * messages are invisible to it entirely. A thread tab is a place to *take part*
 * in a conversation, so the token has to be the user's own — see token.ts.
 *
 * What that buys, beyond identity: the app reaches exactly the conversations
 * the user reaches, with no channel needing to invite anything first.
 *
 * The token comes from the vault on every call rather than being captured once,
 * so disconnecting Slack in the settings panel takes effect at the next call
 * instead of at the next launch.
 */

const API_BASE = 'https://slack.com/api'

/**
 * Slack is a third party on the far end of a network, and a routine on a timer
 * must not be able to pile up requests that never come back.
 */
const REQUEST_TIMEOUT_MS = 15_000

/** The most `conversations.history` will return in one page. */
const MAX_PAGE_SIZE = 200

/**
 * Pages to walk before giving up on one channel, and so a ceiling of 1000
 * messages per channel per call — months of backlog for these channels, where
 * a minute's worth is nearly always none.
 *
 * It matters because Slack pages *backwards*: the first page is the newest
 * messages, and each page after it is older. Stopping early therefore leaves a
 * gap at the bottom rather than at the top, which is why the caller is told
 * whether it got the lot (see `complete`) instead of being left to assume it.
 */
const MAX_PAGES = 5

/**
 * The longest a thread is read. Threads do not page backwards the way history
 * does — `conversations.replies` returns oldest first — so this is a plain cap
 * on a conversation nobody is going to scroll to the end of anyway.
 */
const MAX_THREAD_PAGES = 10

/** Pages of `users.list`, at 200 apiece. Comfortably past any workspace we run in. */
const MAX_DIRECTORY_PAGES = 30

/**
 * How long the workspace directory and the custom emoji are trusted for. Both
 * change on the timescale of somebody joining the company, and both cost a
 * handful of round trips to rebuild, so they are fetched rarely and on demand
 * rather than kept in step.
 */
const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000

/**
 * A message as `conversations.history` and `conversations.replies` return it.
 * Only the fields the app reads are declared: Slack sends a great deal more,
 * and naming all of it here would be inventing a contract nobody checks.
 */
export type SlackMessage = {
  /** The message's timestamp, and its id within the channel. `"1789742088.627"`. */
  ts: string
  /**
   * The message as mrkdwn. Absent on some subtypes, which is part of how they
   * are recognised, and *not* the thing to render when `blocks` is present —
   * see `SlackRichTextBlock`.
   */
  text?: string
  /** Who posted. Absent for app/bot posts, which carry `bot_id` instead. */
  user?: string
  bot_id?: string
  /** The name an app posted under, when it overrode its own. */
  username?: string
  /** Avatar and name for an app post, which has no directory entry to look up. */
  bot_profile?: { name?: string; icons?: { image_48?: string; image_72?: string } }
  /**
   * How the message differs from an ordinary one — `channel_join`, a deleted
   * message's tombstone, and so on. Absent for the ordinary case.
   */
  subtype?: string
  /** Set on both a thread's parent and its replies; equal to `ts` on the parent. */
  thread_ts?: string
  /** On a parent: how many replies hang off it. Absent when there are none. */
  reply_count?: number
  /** Everyone who has replied, for the little row of faces Slack draws. */
  reply_users?: string[]
  /** Present, with a `ts` of its own, when the message has been edited. */
  edited?: { user?: string; ts?: string }
  /** Who is reacting with what. Absent when nobody has. */
  reactions?: SlackReaction[]
  /** Files shared into the message. */
  files?: SlackFile[]
  /**
   * The message as a tree, for anything posted by a modern client. Strictly
   * better than parsing `text`: a mention arrives as an element that says it is
   * a mention and carries the user id, rather than as `<@U024BE7LH>` inside a
   * string that also contains everything else.
   */
  blocks?: SlackBlock[]
  /** Unfurled links and other attachments, which can carry the only URL a message has. */
  attachments?: { title_link?: string; text?: string; title?: string }[]
}

/** One emoji on one message, and everyone who put it there. */
export type SlackReaction = {
  /** The short name, with no colons: `thumbsup`, `party-parrot`. */
  name: string
  count: number
  /** User ids. Includes the user's own when they reacted, which is how the pill knows. */
  users: string[]
}

/**
 * A file shared into a message. The URLs under `slack.com` need the token to
 * fetch and so cannot be put in an `<img src>` — see src/main/slack-media.ts,
 * which is the whole reason that module exists.
 */
export type SlackFile = {
  id: string
  name?: string
  title?: string
  mimetype?: string
  filetype?: string
  pretty_type?: string
  size?: number
  /** Authenticated. Never handed to the renderer as-is. */
  url_private?: string
  /** Where the file lives in Slack, for opening it there. Public in the sense that a browser session can follow it. */
  permalink?: string
  thumb_360?: string
  thumb_360_w?: number
  thumb_360_h?: number
  thumb_720?: string
  /** A file that lives somewhere else entirely — a Google Doc, a pasted link. */
  is_external?: boolean
  external_type?: string
  /** True for a file Slack has expired or that the token cannot see. */
  file_access?: string
}

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

/**
 * The subset of Slack's block kit the app draws. Anything else falls back to
 * the message's mrkdwn `text`, which every message still carries.
 *
 * `rich_text` is what a person's message is made of; the rest of block kit is
 * what apps build, and those are rendered from their `text` instead.
 */
export type SlackBlock = { type: 'rich_text'; elements: SlackRichTextBlock[] } | { type: string }

export type SlackRichTextBlock =
  | { type: 'rich_text_section'; elements: SlackRichTextElement[] }
  | { type: 'rich_text_preformatted'; elements: SlackRichTextElement[] }
  | { type: 'rich_text_quote'; elements: SlackRichTextElement[] }
  | {
      type: 'rich_text_list'
      style: 'bullet' | 'ordered'
      /** Nesting depth; 0 is the outermost list. */
      indent?: number
      elements: { type: 'rich_text_section'; elements: SlackRichTextElement[] }[]
    }

/** What the marks on a run of text can be. Every one is optional and they combine. */
export type SlackTextStyle = {
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
}

export type SlackRichTextElement =
  | { type: 'text'; text: string; style?: SlackTextStyle }
  | { type: 'link'; url: string; text?: string; style?: SlackTextStyle }
  | { type: 'emoji'; name: string; unicode?: string }
  | { type: 'user'; user_id: string; style?: SlackTextStyle }
  | { type: 'usergroup'; usergroup_id: string; style?: SlackTextStyle }
  | { type: 'channel'; channel_id: string; style?: SlackTextStyle }
  /** `@here`, `@channel`, `@everyone`. */
  | { type: 'broadcast'; range: string }
  | { type: string; [key: string]: unknown }

// ---------------------------------------------------------------------------
// People, places and emoji
// ---------------------------------------------------------------------------

/** A person, reduced to what a message row and a mention picker need. */
export type SlackUser = {
  id: string
  /** What to call them: their display name where they set one, else their real name. */
  name: string
  /** The `@handle`, which is what people type when they reach for somebody. */
  handle: string
  realName: string
  /** Their job title, for the hover card. Empty when they have not set one. */
  title: string
  /** 48px square. A public URL on Slack's CDN, but still served through our own scheme. */
  avatar: string
  /** 192px square, for the hover card. */
  avatarLarge: string
  isBot: boolean
  /** Deactivated. Kept in the directory so old messages still resolve to a name. */
  deleted: boolean
}

/** Where a thread lives, as much of it as the header needs. */
export type SlackConversation = {
  id: string
  /** `deploys`, with no leading hash. Empty for a direct message. */
  name: string
  isPrivate: boolean
  isIm: boolean
  isMpim: boolean
  /** The other person, for a direct message. */
  user?: string
  topic: string
}

/**
 * A user group, reduced to the two words a mention of one needs.
 *
 * There is no `usergroups.info`, so these only ever arrive as a whole list —
 * see `usergroupDirectory`.
 */
export type SlackUserGroup = {
  id: string
  /** The `@handle` people type, with no leading `@`: `integrations-team`. */
  handle: string
  /** What the handle stands for: `Integrations Team`. For the hover title. */
  name: string
  /** Disabled. Kept, so a message that flagged it last year still names it. */
  deleted: boolean
}

/** Who the stored token belongs to. */
export type SlackIdentity = {
  userId: string
  /** The `@handle` the token authenticates as. */
  user: string
  teamId: string
  /** `https://acme.slack.com`, which is where permalinks are built from. */
  url: string
}

/**
 * Reading history is a different scope for each kind of conversation, and
 * Slack's `missing_scope` never says which one it wanted. The id does: `C` is
 * a public channel, `G` a private one, `D` a direct message.
 */
function historyScopeFor(conversationId: string | undefined): string {
  if (conversationId?.startsWith('D')) return 'im:history'
  if (conversationId?.startsWith('G')) return 'groups:history'
  return 'channels:history'
}

/**
 * What one of Slack's refusals means for whoever has to go and fix it. Its
 * error codes name the check that failed rather than the thing to do, and the
 * difference between "the token is wrong" and "the app was never invited" is
 * the whole of what a log line here is worth reading for.
 *
 * Codes with nothing to add fall through to Slack's own wording, which beats
 * guessing at what a code we have never seen is trying to say.
 */
function explain(code: string, conversationId: string | undefined): string | undefined {
  switch (code) {
    case 'missing_scope':
      return (
        `the Slack app is missing the ${historyScopeFor(conversationId)} user scope — ` +
        'add it, reinstall the app, and paste the new token into settings'
      )
    case 'not_in_channel':
      return 'you are not in this channel — join it in Slack first'
    case 'channel_not_found':
      return 'no such channel, or this token cannot see it — check the id'
    case 'thread_not_found':
      return 'that thread is gone, or its first message was deleted'
    case 'message_not_found':
      return 'that message is gone'
    case 'already_reacted':
      return 'you have already reacted with that'
    case 'no_reaction':
      return 'that reaction was already gone'
    case 'invalid_name':
      return 'no emoji by that name in this workspace'
    case 'invalid_auth':
      return 'the Slack token was rejected — reconnect Slack in settings'
    case 'token_revoked':
      return 'the Slack token has been revoked — reconnect Slack in settings'
    case 'account_inactive':
      return 'the Slack account behind the token is disabled'
    case 'not_allowed_token_type':
      return 'this needs a user token (xoxp-), not a bot one — see the Slack card in settings'
    case 'ratelimited':
      return 'Slack is rate-limiting us; the next pass will pick up where this one stopped'
    default:
      return undefined
  }
}

/** Slack said no. The code is Slack's; the sentence is ours, when we have one. */
export class SlackError extends Error {
  constructor(
    readonly code: string,
    conversationId?: string
  ) {
    const explanation = explain(code, conversationId)
    super(
      explanation !== undefined ? `${explanation} (${code})` : `Slack refused the request: ${code}`
    )
    this.name = 'SlackError'
  }
}

/** Raised when nothing has been connected yet, so there is no call to make. */
export class SlackNotConnectedError extends Error {
  constructor() {
    super('Slack is not connected. Connect it in settings.')
    this.name = 'SlackNotConnectedError'
  }
}

export function slackConnected(): boolean {
  return getToken() !== undefined
}

/**
 * What the stored token is allowed to do, as Slack itself reports it on the
 * `x-oauth-scopes` header of every reply.
 *
 * Worth capturing rather than inferring. A token missing a scope does not fail
 * loudly and uniformly: `users.list` refuses outright, so every name in a
 * thread comes out as `U020N2337SR` and every face as a grey letter, while the
 * thread itself loads perfectly. Read like that, a missing scope looks like a
 * bug in this app. Read off the header, it is one sentence telling the user
 * exactly which line to add in Slack.
 *
 * Null until the first call comes back, which is the only honest answer before
 * then: nothing has asked Slack anything yet.
 */
let grantedScopes: string[] | null = null

/** What the token can do, or null before anything has been asked of it. */
export function slackGrantedScopes(): string[] | null {
  return grantedScopes
}

/**
 * Which of the scopes a thread wants the token does not carry. Empty when it
 * carries them all — and also when Slack has not yet said, since an empty list
 * of complaints is the right thing to show while the answer is unknown.
 */
export function missingThreadScopes(channelId?: string): { scope: string; buys: string }[] {
  return grantedScopes === null ? [] : missingFrom(grantedScopes, channelId)
}

/**
 * The longest we will sit out a rate limit before giving up on the call. Slack
 * asks for a wait in seconds; anything past this is long enough that failing
 * and letting the caller decide beats holding a request open.
 */
const MAX_RETRY_AFTER_MS = 10_000

type CallOptions = {
  /**
   * `POST` for anything that changes something. Reads go as `GET` with the
   * parameters in the query string, which is what Slack's read methods expect;
   * a write's payload has no business in a URL.
   */
  post?: boolean
}

async function call<T>(
  method: string,
  params: Record<string, string>,
  options: CallOptions = {}
): Promise<T> {
  const token = getToken()
  if (token === undefined) throw new SlackNotConnectedError()

  const encoded = new URLSearchParams(params)
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  // Not JSON: form encoding is the one content type every Slack method
  // accepts, and it saves having to know which of them do not.
  if (options.post) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8'

  const url = options.post ? `${API_BASE}/${method}` : `${API_BASE}/${method}?${encoded}`
  const init: RequestInit = options.post ? { method: 'POST', headers, body: encoded } : { headers }

  // Once, not in a loop: a second 429 means the limit is not about to clear,
  // and a pane polling a thread will come back around on its own anyway.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

    if (response.status === 429 && attempt === 0) {
      const wait = Number(response.headers.get('Retry-After')) * 1000
      if (Number.isFinite(wait) && wait > 0 && wait <= MAX_RETRY_AFTER_MS) {
        await new Promise((resolve) => setTimeout(resolve, wait))
        continue
      }
      throw new SlackError('ratelimited', params.channel)
    }

    // Slack names the token's scopes on every reply, which is the only way to
    // find out what it can do short of trying each thing and reading the
    // refusal — see `grantedScopes`.
    const scopes = response.headers.get('x-oauth-scopes')
    if (scopes !== null) {
      grantedScopes = scopes
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope !== '')
    }

    // Slack answers 200 with `ok: false` for its own refusals, so an HTTP error
    // here is the transport failing rather than the request being rejected.
    if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}.`)

    const payload = (await response.json()) as { ok: boolean; error?: string } & T
    // The conversation, where there is one, so a refusal can name the scope
    // Slack actually wanted rather than the one a public channel would need.
    if (!payload.ok) throw new SlackError(payload.error ?? 'unknown_error', params.channel)
    return payload
  }
}

export type ChannelHistory = {
  /** Oldest first, however many pages it took. */
  messages: SlackMessage[]
  /**
   * Whether this reaches all the way back to `after`. False means the page
   * ceiling was hit and there are older messages, between `after` and the
   * oldest here, that were not fetched — the caller has to decide what that
   * means rather than quietly treating `messages` as the whole story.
   */
  complete: boolean
}

/**
 * Messages posted to `channelId` after `after`, oldest first.
 *
 * `after` is normally the `ts` of the last message already dealt with; Slack
 * treats `oldest` as exclusive unless asked otherwise, so handing it back
 * returns only what is genuinely new.
 *
 * Slack returns newest first and pages backwards from there; both are undone
 * here so callers see one list in the order the messages were written.
 */
export async function channelMessagesSince(
  channelId: string,
  after: string
): Promise<ChannelHistory> {
  const collected: SlackMessage[] = []
  let cursor: string | undefined
  let complete = true

  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await call<{
      messages?: SlackMessage[]
      has_more?: boolean
      response_metadata?: { next_cursor?: string }
    }>('conversations.history', {
      channel: channelId,
      limit: String(MAX_PAGE_SIZE),
      oldest: after,
      ...(cursor !== undefined ? { cursor } : {})
    })

    collected.push(...(body.messages ?? []))

    cursor = body.response_metadata?.next_cursor
    if (body.has_more !== true || !cursor) break

    // More to come, and this was the last page allowed.
    if (page === MAX_PAGES - 1) complete = false
  }

  return { messages: collected.reverse(), complete }
}

/**
 * A whole thread, oldest first: the message it hangs off, then every reply.
 *
 * Slack returns the parent as the first element rather than as a field of its
 * own, and it is left there — a thread reads as one list, and the pane is the
 * place to decide that the first of them is drawn differently.
 */
export async function threadMessages(
  channelId: string,
  threadTs: string
): Promise<{ messages: SlackMessage[]; complete: boolean }> {
  const collected: SlackMessage[] = []
  let cursor: string | undefined
  let complete = true

  for (let page = 0; page < MAX_THREAD_PAGES; page++) {
    const body = await call<{
      messages?: SlackMessage[]
      has_more?: boolean
      response_metadata?: { next_cursor?: string }
    }>('conversations.replies', {
      channel: channelId,
      ts: threadTs,
      limit: String(MAX_PAGE_SIZE),
      ...(cursor !== undefined ? { cursor } : {})
    })

    collected.push(...(body.messages ?? []))

    cursor = body.response_metadata?.next_cursor
    if (body.has_more !== true || !cursor) break
    if (page === MAX_THREAD_PAGES - 1) complete = false
  }

  return { messages: collected, complete }
}

/**
 * Just the message a thread hangs off, with its reactions and the list of who
 * has replied — one page of one.
 *
 * `threadMessages` would answer the same question, but it walks the whole
 * thread to do it, and the settle routine asks this of every open task once a
 * minute. What it needs is on the parent alone: who reacted with what, and
 * whether the user has said anything in the thread themselves.
 *
 * Undefined when the thread is gone — a deleted parent, or a `ts` that never
 * named one.
 */
export async function threadParent(
  channelId: string,
  threadTs: string
): Promise<SlackMessage | undefined> {
  const body = await call<{ messages?: SlackMessage[] }>('conversations.replies', {
    channel: channelId,
    ts: threadTs,
    limit: '1'
  })
  return body.messages?.[0]
}

/** Where a conversation is, for the header above a thread. */
export async function conversationInfo(channelId: string): Promise<SlackConversation> {
  const body = await call<{
    channel: {
      id: string
      name?: string
      is_private?: boolean
      is_im?: boolean
      is_mpim?: boolean
      user?: string
      topic?: { value?: string }
    }
  }>('conversations.info', { channel: channelId })

  const channel = body.channel
  return {
    id: channel.id,
    name: channel.name ?? '',
    isPrivate: channel.is_private === true,
    isIm: channel.is_im === true,
    isMpim: channel.is_mpim === true,
    user: channel.user,
    topic: channel.topic?.value ?? ''
  }
}

/** Who the token is. Cached for the life of the process — it cannot change under us. */
let identity: SlackIdentity | undefined

export async function slackIdentity(): Promise<SlackIdentity> {
  if (identity) return identity

  const body = await call<{ user_id: string; user: string; team_id: string; url: string }>(
    'auth.test',
    {}
  )
  identity = {
    userId: body.user_id,
    user: body.user,
    teamId: body.team_id,
    // Slack hands this back with a trailing slash, which would double up in
    // every permalink built from it.
    url: body.url.replace(/\/$/, '')
  }
  return identity
}

/**
 * Tells Slack to forget the stored token, for disconnecting: removing it from
 * the vault alone would leave a grant on Slack's side that nothing here can
 * use and nobody remembers to undo. Best effort — a token Slack has already
 * dropped, or a network that is down, should not stop the disconnect.
 */
export async function revokeToken(): Promise<void> {
  if (getToken() === undefined) return
  await call('auth.revoke', {}, { post: true }).catch((error: unknown) => {
    console.warn('Could not revoke the Slack token:', error)
  })
}

/** Forgets who the token was, for a token that has just been replaced. */
export function forgetSlackCaches(): void {
  identity = undefined
  directory = undefined
  usergroups = undefined
  emoji = undefined
  // These describe the old token as much as the identity does; a new one is
  // very often a new one precisely because a scope was added.
  grantedScopes = null
}

// ---------------------------------------------------------------------------
// The workspace directory
// ---------------------------------------------------------------------------

type Cached<T> = { value: T; fetchedAt: number; inFlight?: Promise<T> }

let directory: Cached<Record<string, SlackUser>> | undefined

function toUser(raw: {
  id: string
  name?: string
  real_name?: string
  deleted?: boolean
  is_bot?: boolean
  profile?: {
    display_name?: string
    real_name?: string
    title?: string
    image_48?: string
    image_192?: string
  }
}): SlackUser {
  const profile = raw.profile ?? {}
  const realName = profile.real_name ?? raw.real_name ?? raw.name ?? raw.id
  return {
    id: raw.id,
    // Slack's own precedence: the display name is what somebody chose to be
    // called, and the real name is the fallback rather than the other way round.
    name: profile.display_name?.trim() || realName,
    handle: raw.name ?? '',
    realName,
    title: profile.title ?? '',
    avatar: profile.image_48 ?? '',
    avatarLarge: profile.image_192 ?? profile.image_48 ?? '',
    isBot: raw.is_bot === true,
    deleted: raw.deleted === true
  }
}

/**
 * Everyone in the workspace, by id.
 *
 * One list, fetched rarely, rather than a `users.info` per message: a busy
 * thread mentions the same dozen people over and over, and the directory is
 * also what the composer's mention picker searches. Concurrent callers share
 * the one request — a pane opening asks for this at the same moment its
 * composer does.
 */
export async function userDirectory(): Promise<Record<string, SlackUser>> {
  const fresh = directory && Date.now() - directory.fetchedAt < DIRECTORY_TTL_MS
  if (directory && (fresh || directory.inFlight)) {
    return directory.inFlight ?? directory.value
  }

  const request = (async () => {
    const users: Record<string, SlackUser> = {}
    let cursor: string | undefined

    for (let page = 0; page < MAX_DIRECTORY_PAGES; page++) {
      const body = await call<{
        members?: Parameters<typeof toUser>[0][]
        response_metadata?: { next_cursor?: string }
      }>('users.list', {
        limit: String(MAX_PAGE_SIZE),
        ...(cursor !== undefined ? { cursor } : {})
      })

      for (const member of body.members ?? []) users[member.id] = toUser(member)

      cursor = body.response_metadata?.next_cursor
      if (!cursor) break
    }

    directory = { value: users, fetchedAt: Date.now() }
    return users
  })()

  // Held on the old entry where there is one, so a refresh keeps serving the
  // stale directory to anything that asks while it is in flight.
  directory = {
    value: directory?.value ?? {},
    fetchedAt: directory?.fetchedAt ?? 0,
    inFlight: request
  }

  try {
    return await request
  } catch (error) {
    // A failed refresh falls back to whatever was already known rather than
    // taking the thread down with it: a message with an unresolved mention is
    // worth more than no message.
    directory = directory?.fetchedAt
      ? { value: directory.value, fetchedAt: directory.fetchedAt }
      : undefined
    if (directory) return directory.value
    throw error
  }
}

/**
 * One person, for an id the directory does not hold — somebody from another
 * workspace in a Slack Connect channel, most often. Folded into the directory
 * so the next message mentioning them costs nothing.
 */
export async function userInfo(userId: string): Promise<SlackUser | null> {
  try {
    const body = await call<{ user: Parameters<typeof toUser>[0] }>('users.info', { user: userId })
    const user = toUser(body.user)
    if (directory) directory.value[user.id] = user
    return user
  } catch (error) {
    // An id we cannot resolve is drawn as the id. Not worth failing a thread.
    console.warn(`Could not look up the Slack user ${userId}:`, error)
    return null
  }
}

// ---------------------------------------------------------------------------
// User groups
// ---------------------------------------------------------------------------

let usergroups: Cached<Record<string, SlackUserGroup>> | undefined

/**
 * Refusals of `usergroups.list` that asking again will not change: the scope is
 * absent, or the workspace's plan has no user groups in it at all. Slack has
 * more than one way of saying the second, so more than one is listed.
 *
 * They are worth telling apart from a network failure because this list is
 * fetched on a timer's schedule — see the note on caching them below.
 */
const SETTLED_USERGROUP_REFUSALS = [
  'missing_scope',
  'not_allowed_token_type',
  'paid_only',
  'plan_upgrade_required'
]

/**
 * Every user group in the workspace, by id.
 *
 * A list rather than a lookup per mention because Slack offers no lookup: a
 * `usergroup` element in a message carries nothing but `S0614TZR7`, and there
 * is no `usergroups.info` to ask about one group. Without this the renderer has
 * nothing to draw but a placeholder, which is what `@group` was.
 *
 * `include_disabled` so that a message which flagged a group still names it
 * after somebody retires the group; the list drops them otherwise.
 *
 * A refusal is cached as an empty directory, which `userDirectory` deliberately
 * does not do. The difference is that the refusals this call attracts are
 * settled facts rather than weather, and a thread pane polling on a timer
 * should not put the same settled question to Slack every pass. A new token
 * goes through `forgetSlackCaches`, which is what makes that safe.
 */
export async function usergroupDirectory(): Promise<Record<string, SlackUserGroup>> {
  if (usergroups && Date.now() - usergroups.fetchedAt < DIRECTORY_TTL_MS) return usergroups.value

  try {
    // `include_users` is left off: this is for naming a group, not for opening
    // it up, and the membership lists would dwarf everything else in the reply.
    const body = await call<{
      usergroups?: { id: string; name?: string; handle?: string; date_delete?: number }[]
    }>('usergroups.list', { include_disabled: 'true' })

    const groups: Record<string, SlackUserGroup> = {}
    for (const group of body.usergroups ?? []) {
      groups[group.id] = {
        id: group.id,
        handle: group.handle ?? '',
        name: group.name ?? group.handle ?? group.id,
        // Slack dates a deletion rather than flagging it; 0 is a live group.
        deleted: (group.date_delete ?? 0) > 0
      }
    }

    usergroups = { value: groups, fetchedAt: Date.now() }
    return groups
  } catch (error) {
    if (error instanceof SlackError && SETTLED_USERGROUP_REFUSALS.includes(error.code)) {
      usergroups = { value: {}, fetchedAt: Date.now() }
      return {}
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Emoji
// ---------------------------------------------------------------------------

let emoji: Cached<Record<string, string>> | undefined

/**
 * The workspace's custom emoji: name → image URL. Standard emoji are not in
 * here and never will be — Slack does not serve them, and they are resolved to
 * their characters in the renderer (see src/renderer/src/lib/slack-emoji.ts).
 *
 * Slack stores aliases as `alias:othername`; they are followed here so that a
 * caller only ever gets a URL or nothing.
 */
export async function customEmoji(): Promise<Record<string, string>> {
  if (emoji && Date.now() - emoji.fetchedAt < DIRECTORY_TTL_MS) return emoji.value

  const body = await call<{ emoji?: Record<string, string> }>('emoji.list', {})
  const raw = body.emoji ?? {}

  const resolved: Record<string, string> = {}
  for (const name of Object.keys(raw)) {
    // Aliases can chain. The bound is paranoia about a cycle, which Slack
    // should not produce and which would otherwise hang the loop.
    let target = name
    for (let hop = 0; hop < 5; hop++) {
      const value = raw[target]
      if (value === undefined || !value.startsWith('alias:')) break
      target = value.slice('alias:'.length)
    }
    const url = raw[target]
    // An alias pointing at a standard emoji resolves to no URL of its own; the
    // renderer's own table answers those.
    if (url !== undefined && !url.startsWith('alias:')) resolved[name] = url
  }

  emoji = { value: resolved, fetchedAt: Date.now() }
  return resolved
}

// ---------------------------------------------------------------------------
// Taking part
// ---------------------------------------------------------------------------

/** Adds one of the user's own reactions. `name` carries no colons. */
export async function addReaction(
  channelId: string,
  messageTs: string,
  name: string
): Promise<void> {
  await call('reactions.add', { channel: channelId, timestamp: messageTs, name }, { post: true })
}

export async function removeReaction(
  channelId: string,
  messageTs: string,
  name: string
): Promise<void> {
  await call('reactions.remove', { channel: channelId, timestamp: messageTs, name }, { post: true })
}

/**
 * Posts a reply into a thread, as the user.
 *
 * `text` is mrkdwn with mentions already encoded as `<@U024BE7LH>` — see the
 * composer. Slack will not turn a display name into a mention for us: the
 * `link_names` option matches handles rather than names and is unreliable
 * besides, so the ids are resolved before the text ever gets here.
 */
export async function postThreadReply(
  channelId: string,
  threadTs: string,
  text: string
): Promise<SlackMessage | null> {
  const body = await call<{ message?: SlackMessage; ts?: string }>(
    'chat.postMessage',
    {
      channel: channelId,
      thread_ts: threadTs,
      text,
      // Off, because the text already carries every mention as an id. On, it
      // would additionally try to match bare `@words`, which is how a reply
      // mentioning a product called `@mentions` pings somebody.
      link_names: 'false'
    },
    { post: true }
  )

  // Slack echoes the message back without its `ts` at the top level in some
  // shapes; both are tolerated because the next poll will fetch it properly
  // either way.
  if (!body.message) return null
  return { ...body.message, ts: body.message.ts ?? body.ts ?? '' }
}

/** The public address of one message, which is what "open in Slack" points at. */
export async function messagePermalink(channelId: string, messageTs: string): Promise<string> {
  const body = await call<{ permalink: string }>('chat.getPermalink', {
    channel: channelId,
    message_ts: messageTs
  })
  return body.permalink
}

/**
 * Marks a conversation read up to `ts`, so a thread read here does not sit
 * unread in the real Slack client. Best effort: this is a courtesy, and a
 * workspace whose token lacks the scope should not see an error about it.
 */
export async function markRead(channelId: string, messageTs: string): Promise<void> {
  try {
    await call('conversations.mark', { channel: channelId, ts: messageTs }, { post: true })
  } catch (error) {
    console.warn('Could not mark the Slack conversation read:', error)
  }
}
