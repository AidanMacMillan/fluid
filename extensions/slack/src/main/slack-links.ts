/**
 * Reading a Slack address.
 *
 * This is the only way a thread tab gets opened by hand: the user copies a
 * link out of Slack and pastes it into the launcher. It is pure string work
 * with no token behind it, which is why it sits apart from slack.ts — the
 * renderer imports it directly rather than asking across the bridge for what
 * is a regular expression.
 */

/**
 * A message's place in Slack, as a link names it.
 *
 * `threadTs` is the conversation and `messageTs` the message within it. They
 * are equal for a link to a thread's first message, which is the usual case:
 * a permalink copied from a reply carries `?thread_ts=` naming the parent, and
 * one copied from a top-level message does not, because it *is* the parent.
 */
export type SlackMessageRef = {
  channelId: string
  /** The thread's id, which is its first message's `ts`. */
  threadTs: string
  /** The message the link actually pointed at, for scrolling to it. */
  messageTs: string
}

/**
 * Slack's archive links: `/archives/C024BE7LR/p1700000000123456`.
 *
 * The `p` form is the message's `ts` with the dot taken out, so it has to be
 * put back — sixteen digits become ten, a point, and six.
 */
const ARCHIVE_PATH = /^\/archives\/([A-Z][A-Z0-9]{1,})\/p(\d{10})(\d{6})\/?$/i

/** A `ts` as a query parameter carries its dot already. */
const BARE_TIMESTAMP = /^\d{10}\.\d{1,6}$/

/**
 * What a Slack link points at, or null when it points at nothing in
 * particular — a channel with no message named, a Slack address that is not an
 * archive link at all, or something that is not a Slack address.
 *
 * Any workspace's host is accepted rather than only the one the token belongs
 * to: the check that matters is whether Slack will hand over the thread, and
 * that answer comes from Slack.
 */
export function parseSlackMessageUrl(input: string): SlackMessageRef | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }

  if (!/(^|\.)slack\.com$/i.test(url.hostname)) return null

  const match = ARCHIVE_PATH.exec(url.pathname)
  if (!match) return null

  const [, channelId, seconds, fraction] = match
  const messageTs = `${seconds}.${fraction}`

  // A reply's permalink names the thread it is in; a parent's names only
  // itself, and is its own thread.
  const threadParam = url.searchParams.get('thread_ts')
  const threadTs =
    threadParam !== null && BARE_TIMESTAMP.test(threadParam) ? threadParam : messageTs

  return { channelId: channelId.toUpperCase(), threadTs, messageTs }
}

/** Whether pasting this somewhere would open a thread rather than a page. */
export function isSlackThreadUrl(input: string): boolean {
  return parseSlackMessageUrl(input) !== null
}

/**
 * A link back to the message, for opening the thread in Slack proper.
 *
 * Built rather than fetched: `chat.getPermalink` would give the canonical one,
 * but it costs a round trip to produce a string this already knows, and the
 * form has been stable for as long as Slack has had archives.
 */
export function slackArchiveUrl(
  workspaceUrl: string,
  ref: Pick<SlackMessageRef, 'channelId' | 'threadTs'> & { messageTs?: string }
): string {
  const ts = ref.messageTs ?? ref.threadTs
  const base = `${workspaceUrl.replace(/\/$/, '')}/archives/${ref.channelId}/p${ts.replace('.', '')}`
  // The thread parameter is what makes Slack open the thread pane rather than
  // just scrolling the channel to the message.
  return ts === ref.threadTs ? base : `${base}?thread_ts=${ref.threadTs}&cid=${ref.channelId}`
}
