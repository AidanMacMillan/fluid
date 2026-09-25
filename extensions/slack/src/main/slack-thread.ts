import { context } from './context'
import { slackMediaUrl } from './slack-media'
import { slackArchiveUrl } from './slack-links'
import {
  addReaction,
  conversationInfo,
  customEmoji,
  markRead,
  missingThreadScopes,
  postThreadReply,
  removeReaction,
  slackIdentity,
  threadMessages,
  userDirectory,
  usergroupDirectory,
  userInfo,
  type SlackBlock,
  type SlackFile,
  type SlackIdentity,
  type SlackMessage,
  type SlackReaction,
  type SlackRichTextBlock,
  type SlackRichTextElement,
  type SlackUser,
  type SlackUserGroup
} from './slack'

/**
 * One Slack thread, put together for the pane that draws it.
 *
 * The renderer gets a finished thing rather than a pile of Slack responses: the
 * people a message mentions are already looked up, every picture already points
 * at a URL the renderer's content security policy will actually load, and the
 * question of who "you" are is already answered. Doing that here keeps the
 * token, the network and Slack's shapes on this side of the bridge, which is
 * where they belong — and it means the pane makes one call to draw a thread
 * instead of a dozen.
 */

/**
 * The most unknown people one thread will be looked up individually. Authors
 * and mentions nearly always come out of the directory; what lands here is
 * somebody from another workspace in a shared channel. A busy thread of those
 * should cost a few requests, not a hundred.
 */
const MAX_INDIVIDUAL_LOOKUPS = 20

/** A person, as the renderer draws them. Avatars already point at our own scheme. */
export type ThreadUser = Omit<SlackUser, 'avatar' | 'avatarLarge'> & {
  /** 48px, proxied. Empty when they have no picture. */
  avatar: string
  /** 192px, proxied, for the hover card. */
  avatarLarge: string
}

/** Who posted a message, whether that is a person, an app, or nobody we can name. */
export type ThreadAuthor = {
  /** The directory id, when there is one. Absent for an app post. */
  id?: string
  name: string
  /** Proxied, or empty. */
  avatar: string
  /** An app rather than a person, which the row marks. */
  isApp: boolean
}

/** What kind of viewer a file gets, decided here so the pane does not have to guess. */
export type ThreadFileKind = 'image' | 'video' | 'other'

export type ThreadFile = {
  id: string
  name: string
  /** What the file is called out loud — Slack's own `pretty_type`, e.g. `PNG`. */
  prettyType: string
  size: number
  kind: ThreadFileKind
  /** The file itself, proxied. Absent when it cannot be fetched. */
  src?: string
  /** A preview, proxied, for an image that has one. */
  thumb?: string
  thumbWidth?: number
  thumbHeight?: number
  /** Where it lives in Slack, for opening it there. */
  permalink?: string
  /**
   * True for a file Slack will not hand over: expired, or on a plan that has
   * archived it. The row says so rather than showing a broken picture.
   */
  unavailable: boolean
}

/** An unfurled link, which is often where a message's only real content is. */
export type ThreadAttachment = {
  title?: string
  titleLink?: string
  text?: string
}

export type ThreadMessage = {
  ts: string
  /** The mrkdwn, which is what gets drawn when there are no rich text blocks. */
  text: string
  /** Preferred over `text` whenever it is here — see the note on `SlackMessage.blocks`. */
  blocks?: SlackBlock[]
  author: ThreadAuthor
  /** Whether it has been edited since it was posted. */
  edited: boolean
  reactions: SlackReaction[]
  files: ThreadFile[]
  attachments: ThreadAttachment[]
  /** `channel_join` and friends, which the pane draws as a line rather than a message. */
  subtype?: string
}

export type ThreadView = {
  channelId: string
  /** `#deploys`, or the other person's name for a direct message. Ready to draw. */
  channelLabel: string
  threadTs: string
  messages: ThreadMessage[]
  /** Everyone the thread refers to — authors, mentions, reactors — by id. */
  users: Record<string, ThreadUser>
  /**
   * Every user group the thread flags, by id. Separate from `users` because
   * Slack keeps them apart: a group id is an `S…`, it resolves through a
   * directory of its own, and a mention of one names a handle rather than a
   * person. Empty where the token cannot read them, which the pane draws as
   * the placeholder it drew before any of this — see `usergroupDirectory`.
   */
  groups: Record<string, SlackUserGroup>
  /** Who the token is, so the pane can tell the user's own reactions from everyone else's. */
  me: string
  /** The thread in Slack proper. */
  permalink: string
  /**
   * False when the thread was too long to read in full. The pane says so rather
   * than letting a truncated conversation pass for the whole of it.
   */
  complete: boolean
  /**
   * One sentence about what this thread is missing and why, or null when it is
   * missing nothing. Always about the token's scopes: those are the only thing
   * that can leave a thread looking drawn but wrong — every name an id, every
   * face a grey letter — with no error anywhere to explain it.
   */
  trouble: string | null
  /** When this was fetched, so the pane can say how stale it is. */
  fetchedAt: number
}

/** A picture on a Slack host, as something the renderer is allowed to load. */
function proxied(url: string | undefined): string {
  return url ? slackMediaUrl(url) : ''
}

function toThreadUser(user: SlackUser): ThreadUser {
  return { ...user, avatar: proxied(user.avatar), avatarLarge: proxied(user.avatarLarge) }
}

/** `<@U024BE7LH>`, which is how a mention looks in a message's plain text. */
const TEXT_MENTION = /<@([UWB][A-Z0-9]+)(?:\|[^>]*)?>/g

/**
 * `<!subteam^S0614TZR7>`, the same thing for a group. The trailing `|@handle`
 * is optional and usually absent: Slack's own client writes it, and a message
 * posted through the API — which is most of the ones that flag a group — does
 * not. That is precisely why the id has to be resolved rather than read.
 */
const TEXT_GROUP_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g

/** The ids a message refers to, kept apart by what kind of thing they name. */
type Mentioned = { users: Set<string>; groups: Set<string> }

/** Every id a rich text tree mentions, added to `into`. */
function collectBlockMentions(blocks: SlackBlock[] | undefined, into: Mentioned): void {
  for (const block of blocks ?? []) {
    if (block.type !== 'rich_text') continue
    for (const section of (block as { elements?: SlackRichTextBlock[] }).elements ?? []) {
      collectSectionMentions(section, into)
    }
  }
}

function collectSectionMentions(section: SlackRichTextBlock, into: Mentioned): void {
  for (const element of section.elements as (SlackRichTextElement | SlackRichTextBlock)[]) {
    if ('user_id' in element && typeof element.user_id === 'string') into.users.add(element.user_id)
    else if ('usergroup_id' in element && typeof element.usergroup_id === 'string') {
      into.groups.add(element.usergroup_id)
    }
    // A list's elements are sections of their own, so the walk recurses.
    else if ('elements' in element && Array.isArray(element.elements)) {
      collectSectionMentions(element as SlackRichTextBlock, into)
    }
  }
}

/** What to call a group in plain text, falling back to the id. Carries no `@`. */
function groupHandle(id: string, groups: Record<string, SlackUserGroup>): string {
  const group = groups[id]
  return group ? group.handle || group.name : id
}

/**
 * Which files Slack considers viewable. `mimetype` is the honest answer where
 * there is one; `filetype` covers the handful of cases where it is missing.
 */
function fileKind(file: SlackFile): ThreadFileKind {
  const mime = file.mimetype ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'other'
}

function toThreadFile(file: SlackFile): ThreadFile {
  // Slack marks a file it will not serve — expired, or beyond a plan's
  // retention — rather than refusing the fetch, so it is worth reading.
  const unavailable =
    file.file_access === 'check_file_info' || file.file_access === 'file_not_found'
  const kind = fileKind(file)

  return {
    id: file.id,
    name: file.title || file.name || 'Untitled',
    prettyType: file.pretty_type ?? file.filetype?.toUpperCase() ?? '',
    size: file.size ?? 0,
    kind,
    // Only fetched for the kinds that get drawn. There is no sense proxying a
    // 40MB zip nothing is going to display.
    src: unavailable || kind === 'other' ? undefined : proxied(file.url_private),
    thumb: unavailable ? undefined : proxied(file.thumb_360),
    thumbWidth: file.thumb_360_w,
    thumbHeight: file.thumb_360_h,
    permalink: file.permalink,
    unavailable
  }
}

/**
 * Who posted, resolved against the directory. An app post carries its own name
 * and icon and has no directory entry at all, which is the case the second
 * branch is for.
 */
function authorOf(
  message: SlackMessage,
  users: Record<string, SlackUser>,
  identity?: SlackIdentity
): ThreadAuthor {
  const user = message.user !== undefined ? users[message.user] : undefined
  if (user) {
    return {
      id: user.id,
      name: user.name,
      avatar: proxied(user.avatar),
      isApp: user.isBot
    }
  }

  // The directory is gone — no `users:read` — but `auth.test` names the token's
  // own handle, and in a thread you are in, a good half of the messages are
  // yours. Better half the names than none of them.
  if (identity !== undefined && message.user === identity.userId) {
    return { id: identity.userId, name: identity.user, avatar: '', isApp: false }
  }

  if (message.bot_id !== undefined || message.username !== undefined) {
    const profile = message.bot_profile
    return {
      name: message.username ?? profile?.name ?? 'App',
      avatar: proxied(profile?.icons?.image_48 ?? profile?.icons?.image_72),
      isApp: true
    }
  }

  // An id the directory does not hold and the lookup could not resolve. Drawn
  // as the id, which at least says *something* that can be searched for.
  return { id: message.user, name: message.user ?? 'Unknown', avatar: '', isApp: false }
}

/** What to call the conversation, as the header says it. */
async function channelLabel(
  channelId: string,
  users: Record<string, SlackUser>,
  identity?: SlackIdentity
): Promise<{ label: string; name: string }> {
  try {
    const channel = await conversationInfo(channelId)
    if (channel.isIm) {
      // A direct message to yourself: the directory may not hold your own
      // entry, so fall back to the name the token was issued to.
      if (channel.user !== undefined && channel.user === identity?.userId) {
        return { label: users[channel.user]?.name ?? identity.user, name: '' }
      }
      const other = channel.user !== undefined ? users[channel.user] : undefined
      return { label: other ? other.name : 'Direct message', name: '' }
    }
    if (channel.isMpim) return { label: channel.name || 'Group message', name: channel.name }
    return { label: channel.name ? `#${channel.name}` : channelId, name: channel.name }
  } catch (error) {
    // The thread is the point; a header that has to fall back to the id is a
    // much smaller loss than no thread at all.
    console.warn(`Could not read the Slack conversation ${channelId}:`, error)
    return { label: channelId, name: '' }
  }
}

/**
 * A thread, ready to draw.
 *
 * The lookups run against one directory fetched once and cached for hours (see
 * `userDirectory`), so a thread of forty messages between eight people costs
 * one request for the messages and nothing else on any pass after the first.
 */
export async function readThread(channelId: string, threadTs: string): Promise<ThreadView> {
  const [identity, { messages, complete }] = await Promise.all([
    slackIdentity(),
    threadMessages(channelId, threadTs)
  ])

  // Everyone the thread refers to at all: who wrote each message, who each
  // message mentions, and who reacted to it — the last because a reaction pill
  // names its reactors on hover.
  const referenced: Mentioned = { users: new Set(), groups: new Set() }
  for (const message of messages) {
    if (message.user !== undefined) referenced.users.add(message.user)
    for (const reaction of message.reactions ?? []) {
      for (const user of reaction.users) referenced.users.add(user)
    }
    collectBlockMentions(message.blocks, referenced)
    for (const match of (message.text ?? '').matchAll(TEXT_MENTION)) referenced.users.add(match[1])
    for (const match of (message.text ?? '').matchAll(TEXT_GROUP_MENTION)) {
      referenced.groups.add(match[1])
    }
  }

  const [directory, groupDirectory] = await Promise.all([
    userDirectory().catch((error) => {
      console.warn('Could not read the Slack directory:', error)
      return {} as Record<string, SlackUser>
    }),
    // Only fetched at all when something in the thread flags a group, which
    // most threads never do.
    referenced.groups.size === 0
      ? Promise.resolve({} as Record<string, SlackUserGroup>)
      : usergroupDirectory().catch((error) => {
          console.warn('Could not read the Slack user groups:', error)
          return {} as Record<string, SlackUserGroup>
        })
  ])

  // Anybody the directory has never heard of — a guest from another workspace,
  // most often — fetched one at a time and only up to a point.
  const unknown = [...referenced.users].filter((id) => directory[id] === undefined)
  const users: Record<string, SlackUser> = {}
  for (const id of unknown.slice(0, MAX_INDIVIDUAL_LOOKUPS)) {
    const found = await userInfo(id)
    if (found) users[found.id] = found
  }
  for (const id of referenced.users) {
    const found = directory[id] ?? users[id]
    if (found) users[id] = found
  }

  // Narrowed to what this thread flags rather than sent whole: the directory is
  // the workspace's, and the renderer only has these to draw.
  const groups: Record<string, SlackUserGroup> = {}
  for (const id of referenced.groups) {
    const found = groupDirectory[id]
    if (found) groups[id] = found
  }

  const { label } = await channelLabel(channelId, users, identity)

  return {
    channelId,
    channelLabel: label,
    threadTs,
    messages: messages.map((message) => ({
      ts: message.ts,
      text: message.text ?? '',
      blocks: message.blocks,
      author: authorOf(message, users, identity),
      edited: message.edited !== undefined,
      reactions: message.reactions ?? [],
      files: (message.files ?? []).map(toThreadFile),
      attachments: (message.attachments ?? []).map((attachment) => ({
        title: attachment.title,
        titleLink: attachment.title_link,
        text: attachment.text
      })),
      subtype: message.subtype
    })),
    users: Object.fromEntries(Object.entries(users).map(([id, user]) => [id, toThreadUser(user)])),
    groups,
    me: identity.userId,
    permalink: slackArchiveUrl(identity.url, { channelId, threadTs }),
    complete,
    trouble: troubleWith(channelId),
    fetchedAt: Date.now()
  }
}

/**
 * What to say when the token cannot do everything this pane assumes.
 *
 * Read off the scopes Slack reports rather than guessed at from symptoms, so it
 * names the exact lines to add — and says nothing at all when there is nothing
 * to say, which is the common case and the one that must stay silent.
 */
function troubleWith(channelId: string): string | null {
  const missing = missingThreadScopes(channelId)
  if (missing.length === 0) return null

  const list = missing.map((entry) => entry.scope).join(', ')
  const costs =
    missing.length === 1
      ? missing[0].buys
      : `${missing
          .slice(0, -1)
          .map((entry) => entry.buys)
          .join(', ')} and ${missing[missing.length - 1].buys}`

  return (
    `Your Slack token is missing ${list}, so ${costs} ${missing.length === 1 ? 'is' : 'are'} ` +
    'unavailable. Add the scope' +
    (missing.length === 1 ? '' : 's') +
    ' under User Token Scopes in your Slack app, reinstall it, and paste the new token into settings.'
  )
}

/**
 * What a tab needs to know about a thread before it can name itself — fetched
 * when the tab is opened, and stored in its payload so that the row has
 * something to draw on every launch after this one.
 */
export type ThreadSummary = {
  /** Ready to draw: `#deploys`, or a person's name for a direct message. */
  channelLabel: string
  authorName: string
  excerpt: string
}

/** The first line of `text`, near enough, for a row that is one line tall. */
function excerptOf(
  text: string,
  users: Record<string, SlackUser>,
  groups: Record<string, SlackUserGroup>
): string {
  return (
    text
      // A mention reads as an id otherwise, which tells the row nothing.
      .replace(TEXT_MENTION, (_match, id: string) => `@${users[id]?.name ?? id}`)
      // Before the two general rules below, which would otherwise leave a row
      // reading `!subteam^S0614TZR7` — or `@group`, where Slack wrote a label.
      .replace(TEXT_GROUP_MENTION, (_match, id: string) => `@${groupHandle(id, groups)}`)
      .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<([^|>]+)>/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
  )
}

/**
 * Names a thread without drawing it, for the moment a tab is created. Every
 * failure here is survivable: the tab opens either way and the pane will say
 * what went wrong with far more room than a sidebar row has.
 */
export async function summariseThread(
  channelId: string,
  threadTs: string
): Promise<ThreadSummary | null> {
  try {
    const [identity, { messages }] = await Promise.all([
      slackIdentity(),
      threadMessages(channelId, threadTs)
    ])
    const first = messages[0]
    const directory = await userDirectory().catch(() => ({}) as Record<string, SlackUser>)
    // A plain `includes` rather than the regex: `test` on a global one carries
    // `lastIndex` between calls, and this text goes through it twice.
    const groups = (first?.text ?? '').includes('<!subteam^')
      ? await usergroupDirectory().catch(() => ({}) as Record<string, SlackUserGroup>)
      : {}
    const { label } = await channelLabel(channelId, directory, identity)

    return {
      channelLabel: label,
      authorName: authorOf(first ?? { ts: threadTs }, directory, identity).name,
      excerpt: excerptOf(first?.text ?? '', directory, groups)
    }
  } catch (error) {
    console.warn(`Could not summarise the Slack thread ${channelId}/${threadTs}:`, error)
    return null
  }
}

/**
 * The workspace's people, for the composer's mention picker. Sorted by name and
 * stripped of the deactivated and the bots: what this feeds is a list of people
 * to address, and neither of those can be addressed usefully.
 */
export async function mentionableUsers(): Promise<ThreadUser[]> {
  const directory = await userDirectory()
  return Object.values(directory)
    .filter((user) => !user.deleted && !user.isBot)
    .map(toThreadUser)
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** The workspace's own emoji, name → a URL the renderer may load. */
export async function threadEmoji(): Promise<Record<string, string>> {
  const emoji = await customEmoji()
  return Object.fromEntries(Object.entries(emoji).map(([name, url]) => [name, proxied(url)]))
}

/**
 * Adds or removes one of the user's reactions, and answers with the message's
 * reactions as they now stand — read back rather than guessed at, so that two
 * people reacting at once cannot leave the pane showing a count nobody has.
 */
export async function toggleReaction(
  channelId: string,
  messageTs: string,
  name: string,
  on: boolean
): Promise<void> {
  if (on) await addReaction(channelId, messageTs, name)
  else await removeReaction(channelId, messageTs, name)
}

/** Posts a reply, as the user. The text already carries mentions as ids. */
export async function replyToThread(
  channelId: string,
  threadTs: string,
  text: string
): Promise<void> {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('Nothing to send.')
  await postThreadReply(channelId, threadTs, trimmed)
}

/**
 * Tells Slack the conversation has been read up to here, so a thread read in
 * this app does not keep its unread badge in the real client.
 */
export async function markThreadRead(channelId: string, messageTs: string): Promise<void> {
  await markRead(channelId, messageTs)
}

/**
 * Opens the thread in Slack itself.
 *
 * A `slack:` deep link rather than the web address, so it lands in the desktop
 * client the user already has open instead of a browser tab asking them to sign
 * in again. The web address is the fallback for a machine with no Slack app: the
 * OS refuses a scheme nothing has registered, and `openExternal` reports that by
 * rejecting.
 */
export async function openThreadInSlack(
  channelId: string,
  threadTs: string,
  messageTs?: string
): Promise<void> {
  const identity = await slackIdentity()
  const ts = messageTs ?? threadTs
  const deepLink =
    `slack://channel?team=${encodeURIComponent(identity.teamId)}` +
    `&id=${encodeURIComponent(channelId)}&message=${encodeURIComponent(ts)}` +
    (ts === threadTs ? '' : `&thread_ts=${encodeURIComponent(threadTs)}`)

  try {
    await context().openExternal(deepLink)
  } catch {
    await context().openExternal(slackArchiveUrl(identity.url, { channelId, threadTs, messageTs }))
  }
}
