import { slackApi } from '../host'
import type { ThreadUser } from '../../main/slack-thread'

/**
 * The two things every Slack thread tab needs and none of them owns: the
 * workspace's people and its custom emoji.
 *
 * Both are workspace-wide, both are wanted by every pane at once, and both are
 * already cached in the main process — this is the renderer's half of that, so
 * that four open threads do not make four trips across the bridge for the same
 * list. Loaded on first use rather than at startup: an app session that never
 * opens a thread should never ask Slack for anything.
 */

const api = slackApi

class SlackWorkspace {
  /** Everyone who can be mentioned, by name. Empty until the first load lands. */
  users = $state<ThreadUser[]>([])

  /** Custom emoji: name → a URL this renderer may load. */
  emoji = $state<Record<string, string>>({})

  /** Users by id, for resolving a mention without a scan. */
  usersById = $derived(Object.fromEntries(this.users.map((user) => [user.id, user])))

  /**
   * The load in flight, or the one that finished. Held so that concurrent
   * callers — two panes opening at once, which is the normal case when a task
   * is restored — share the one request rather than racing.
   */
  private loading: Promise<void> | null = null

  /**
   * Fetches the directory and the emoji if they have not been fetched.
   *
   * A failure is swallowed rather than thrown: everything here is decoration.
   * A thread with unresolved mention ids and `:shipit:` written out in full is
   * still a thread, and a pane that refused to draw because the emoji list was
   * rate-limited would be absurd.
   */
  load(): Promise<void> {
    if (this.loading) return this.loading

    this.loading = (async () => {
      const [users, emoji] = await Promise.all([
        api.users().catch((error: unknown) => {
          console.warn('Could not load the Slack directory:', error)
          return [] as ThreadUser[]
        }),
        api.emoji().catch((error: unknown) => {
          console.warn('Could not load the Slack emoji:', error)
          return {} as Record<string, string>
        })
      ])
      this.users = users
      this.emoji = emoji
    })()

    return this.loading
  }

  /** Forgets everything, so the next pane to open asks again. For a token change. */
  reset(): void {
    this.loading = null
    this.users = []
    this.emoji = {}
  }

  /**
   * People matching what has been typed after an `@`, best first.
   *
   * Matched against both the display name and the handle, because those differ
   * for about half a workspace and the user is as likely to reach for either.
   * A match at the start of a word beats one in the middle: typing `ai` should
   * find Aidan before it finds Mikhail.
   */
  matchUsers(query: string, limit = 8): ThreadUser[] {
    const needle = query.trim().toLowerCase()
    if (needle === '') return this.users.slice(0, limit)

    const scored: { user: ThreadUser; score: number }[] = []
    for (const user of this.users) {
      const name = user.name.toLowerCase()
      const handle = user.handle.toLowerCase()
      const real = user.realName.toLowerCase()

      const score =
        name.startsWith(needle) || handle.startsWith(needle)
          ? 0
          : // The start of any word in the name: `mac` finds Aidan MacMillan.
            new RegExp(`\\b${escapeRegExp(needle)}`).test(name) || real.includes(needle)
            ? 1
            : name.includes(needle) || handle.includes(needle)
              ? 2
              : -1

      if (score >= 0) scored.push({ user, score })
    }

    return scored
      .sort(
        (left, right) => left.score - right.score || left.user.name.localeCompare(right.user.name)
      )
      .slice(0, limit)
      .map((entry) => entry.user)
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const slackWorkspace = new SlackWorkspace()

/**
 * The scheme the main process serves Slack's pictures over. Mirrors
 * `SLACK_MEDIA_SCHEME` in src/main/slack-media.ts, the same way the file
 * store's scheme is mirrored in the workspace store.
 */
export const SLACK_MEDIA_SCHEME = 'slack-media'
