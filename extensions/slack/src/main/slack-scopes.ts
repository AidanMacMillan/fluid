/**
 * The permissions the app asks Slack for, and what each one buys.
 *
 * A module of its own, with no imports, for the same reason slack-links.ts is
 * one: the settings panel lists these, and the renderer can only import from
 * the main process at all where the module is pure. Anything reaching through
 * `slack.ts` would drag the database, the vault and half of Electron into the
 * renderer bundle.
 *
 * It is worth listing them in the interface rather than in a README, because a
 * token with the wrong permissions does not look like a permissions problem. A
 * thread missing `users:read` draws perfectly, with every name an id and every
 * face a grey letter, and nothing anywhere says why.
 */

/**
 * Every user token scope the app asks for, grouped by what the group buys.
 *
 * All of them are *user* scopes, which in Slack's install screen is the second
 * column — the one headed "User Token Scopes". Granting the same names in the
 * bot column produces a working app that cannot do a single thing here.
 *
 * The four `:history` scopes read the four kinds of conversation and the four
 * `:read` scopes name them; both sets are listed in full because which one a
 * given thread needs depends on where it was posted, and discovering that one
 * refusal at a time is a miserable way to spend an afternoon.
 *
 * Deliberately absent: `channels:write` and its three siblings, which
 * `conversations.mark` needs to stop a thread read here from staying unread in
 * Slack. They also permit renaming and archiving channels, which is a great
 * deal of authority to hand over for a read receipt — so the app asks for that
 * courtesy to fail instead (see `markRead` in slack.ts).
 */
export const SLACK_USER_SCOPE_GROUPS: readonly { buys: string; scopes: readonly string[] }[] = [
  {
    buys: 'Reading a thread',
    scopes: ['channels:history', 'groups:history', 'im:history', 'mpim:history']
  },
  {
    buys: 'Naming the channel it is in',
    scopes: ['channels:read', 'groups:read', 'im:read', 'mpim:read']
  },
  { buys: 'Names, faces and the mention picker', scopes: ['users:read'] },
  { buys: 'Naming the groups a message flags', scopes: ['usergroups:read'] },
  { buys: 'Custom emoji and shared files', scopes: ['emoji:read', 'files:read'] },
  { buys: 'Reacting and replying as you', scopes: ['reactions:write', 'chat:write'] }
]

/** The same list, flat, for pasting into Slack. */
export const SLACK_USER_SCOPES: readonly string[] = SLACK_USER_SCOPE_GROUPS.flatMap(
  (group) => group.scopes
)

/**
 * The scopes that can be missing while a thread still appears to work, and
 * what each costs — phrased for somebody deciding whether they care.
 *
 * Reading the messages is deliberately absent: those scopes vary by the kind of
 * conversation, and a thread that has been drawn at all already had the right
 * one.
 */
const DEGRADES_QUIETLY: readonly { scope: string; buys: string }[] = [
  { scope: 'users:read', buys: "people's names and pictures" },
  { scope: 'usergroups:read', buys: 'the names of the groups a message flags' },
  { scope: 'emoji:read', buys: "the workspace's own emoji" },
  { scope: 'files:read', buys: 'files shared into a thread' },
  { scope: 'reactions:write', buys: 'reacting' },
  { scope: 'chat:write', buys: 'replying' }
]

/**
 * Which of those `granted` does not include, for a thread in `channelId`.
 *
 * Pure, and given the granted list rather than reading it, so the renderer can
 * call it too and so it can be reasoned about without a token.
 */
export function missingFrom(
  granted: readonly string[],
  channelId?: string
): { scope: string; buys: string }[] {
  // The conversation's own kind decides which read scope names it, the same way
  // it decides which history scope reads it.
  const naming = channelId?.startsWith('D')
    ? 'im:read'
    : channelId?.startsWith('G')
      ? 'groups:read'
      : 'channels:read'

  return [...DEGRADES_QUIETLY, { scope: naming, buys: "the channel's name" }].filter(
    (entry) => !granted.includes(entry.scope)
  )
}
