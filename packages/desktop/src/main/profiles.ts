/**
 * Browsing profiles: the handful of separate logins a tab can be opened in.
 *
 * A profile is half of a Chromium storage partition — its own cookie jar,
 * localStorage, service workers and HTTP auth cache. Two tabs in different
 * profiles on the same site are two unrelated visitors, which is what makes it
 * possible to hold a staging account and a sandbox account open side by side.
 *
 * The other half is the space the tab's project is in: a profile is a session
 * within a space rather than across the app, so the same profile in two spaces
 * is two unrelated visitors as well. See src/main/browsing.ts, which is where
 * the two are crossed and where partition names are decided.
 *
 * There are five of them and they are fixed, deliberately. A profile here is a
 * slot to grab for as long as a piece of work lasts, not a thing to be named
 * and curated: what identifies one is its colour, which the tab wears. Being
 * fixed is what keeps them free of a lifecycle — nothing is created or
 * destroyed, so there is no half-deleted profile to reason about, and none of
 * Electron's awkwardness around sessions that cannot be torn down at runtime
 * ever comes up.
 *
 * Incognito is the sixth, and the one exception to all of that. It is a profile
 * like the others — a slot with a colour, that tabs are opened in — but its
 * session is held in memory rather than on disk, and it is emptied the moment
 * the last tab using it goes. What it buys is a login that cannot outlive the
 * work it was for, including by being forgotten about.
 *
 * Kept free of imports on purpose: the renderer draws these and the main
 * process opens sessions for them, so this module has to be loadable from both
 * sides.
 */

/** The colours a profile can be. One each — the colour *is* the profile. */
export type ProfileColor = 'red' | 'blue' | 'orange' | 'green' | 'purple' | 'grey'

export type Profile = {
  /** What the `tabs.profile` column holds. Null there means the default profile. */
  id: number
  /**
   * What the colour is called, for the places a colour cannot be seen: the
   * accessible name of a tab's indicator, and the label beside each swatch in
   * a menu. Never shown next to the colour on a tab row — the row has only the
   * colour, which is the point of it.
   */
  name: string
  color: ProfileColor
  /**
   * Whether the session is held in memory and emptied when the last tab in it
   * closes. True of incognito and nothing else.
   *
   * This is the flag that makes a profile a different kind of thing rather than
   * a differently coloured one: an ephemeral profile cannot be reset — it is
   * already empty by construction — and cannot be relied on to still hold a
   * login the next time it is reached for.
   */
  ephemeral?: boolean
}

/** The profile whose session dies with its last tab. */
export const INCOGNITO_PROFILE_ID = 6

export const PROFILES: readonly Profile[] = [
  { id: 1, name: 'Profile 1', color: 'red' },
  { id: 2, name: 'Profile 2', color: 'blue' },
  { id: 3, name: 'Profile 3', color: 'orange' },
  { id: 4, name: 'Profile 4', color: 'green' },
  { id: 5, name: 'Profile 5', color: 'purple' },
  { id: INCOGNITO_PROFILE_ID, name: 'Incognito', color: 'grey', ephemeral: true }
]

/** The five reusable slots, for the places incognito does not belong beside them. */
export const REUSABLE_PROFILES: readonly Profile[] = PROFILES.filter(
  (profile) => profile.ephemeral !== true
)

/** Whether this profile's session is emptied when its last tab closes. */
export function isEphemeralProfile(id: number | null): boolean {
  return profileById(id)?.ephemeral === true
}

/** What the default profile is called wherever it has to be named. */
export const DEFAULT_PROFILE_NAME = 'Default profile'

export function profileById(id: number | null): Profile | null {
  return id === null ? null : (PROFILES.find((profile) => profile.id === id) ?? null)
}

/** The name to read out for a tab in this profile, default included. */
export function profileName(id: number | null): string {
  return profileById(id)?.name ?? DEFAULT_PROFILE_NAME
}

/** Whether a stored value still names a profile. Guards rows written before a change here. */
export function isProfileId(value: unknown): value is number {
  return typeof value === 'number' && PROFILES.some((profile) => profile.id === value)
}
