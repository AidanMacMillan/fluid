import { INCOGNITO_PROFILE_ID } from './profiles'

/**
 * A browsing context: the space a page is in, crossed with the profile it runs
 * as. Together they name a Chromium storage partition, and so a cookie jar.
 *
 * Profiles alone were not enough. A profile is a slot to grab for the length of
 * a piece of work (see src/main/profiles.ts), and there are five of them — so
 * two projects that both reach for the default profile are the same visitor to
 * every site they share, whether or not they have anything to do with each
 * other. A space is the partition above that: work in one space cannot see the
 * logins of work in another, whichever profile either of them is using.
 *
 * The pair is what identifies a session, not either half. The default profile
 * in the personal space and the default profile in the default space are two
 * unrelated visitors; so are the red profile in each.
 *
 * Kept free of imports beyond `profiles` on purpose, and free of electron
 * entirely: the renderer names these contexts and the main process opens
 * sessions for them, so this module has to be loadable from both sides.
 */

/**
 * The space every project starts in, and the one the app had before spaces
 * existed.
 *
 * A fixed id rather than a flag on the row, because it is read in two places
 * that cannot ask the database: `partitionFor` below, which is a pure string
 * function called while a view is being constructed, and the renderer, which
 * knows a project's space id and nothing else about it. It is also what makes
 * the default space undeleteable without a column saying so.
 *
 * Written by resources/migrations/0000_baseline.sql. If this changes, that
 * changes with it — and every login in the app moves to a new partition.
 */
export const DEFAULT_SPACE_ID = '00000000-0000-0000-0000-000000000000'

/** Whether this is the space everything was in before spaces existed. */
export function isDefaultSpace(space: string | null): boolean {
  return space === null || space === DEFAULT_SPACE_ID
}

/** Which login a page is, in full: where it is, and who it is there. */
export type BrowsingContext = {
  /** The space's id, or null for the default space. The two mean the same. */
  space: string | null
  /** The profile's id, or null for the default profile. */
  profile: number | null
}

/**
 * Whether two contexts name the same session — compared through the partition
 * rather than field by field, because the partition is what a session actually
 * is, and null and `DEFAULT_SPACE_ID` are two spellings of the same space.
 */
export function sameBrowsingContext(a: BrowsingContext, b: BrowsingContext): boolean {
  return partitionFor(a.space, a.profile) === partitionFor(b.space, b.profile)
}

/**
 * The Chromium partition a browsing context's pages run in, or undefined for
 * the default profile of the default space — which is the app's own session,
 * the one every tab used before any of this existed and the one nearly every
 * tab still uses.
 *
 * The default space deliberately keeps the partition names it had before it was
 * a space at all. Spaces arrived after people were signed into things; naming
 * the partitions differently would have been a silent, unexplained sign-out of
 * every profile in the app.
 *
 * `persist:` is what makes a partition survive a restart. Incognito is the one
 * profile that deliberately does without it — in every space, since an
 * ephemeral session in the personal space should no more be the default
 * space's than a persisted one would be.
 */
export function partitionFor(space: string | null, profile: number | null): string | undefined {
  // The prefix that makes a space's sessions its own. Empty for the default
  // space, which is what keeps its partition names exactly as they were.
  const scope = isDefaultSpace(space) ? '' : `space-${space}-`

  if (profile === null) return scope === '' ? undefined : `persist:${scope}default`
  // No `persist:` prefix, which is the whole of what makes incognito what it
  // is: Chromium keeps an unprefixed partition in memory, so there is no
  // directory to delete and nothing to be recovered from disk afterwards.
  if (profile === INCOGNITO_PROFILE_ID) return `${scope}incognito`
  return `persist:${scope}profile-${profile}`
}

/** Every partition a space can hold a login in, for clearing one out. */
export function partitionsOfSpace(space: string, profiles: readonly number[]): string[] {
  const partitions = [partitionFor(space, null), ...profiles.map((id) => partitionFor(space, id))]
  return partitions.filter((partition): partition is string => partition !== undefined)
}
