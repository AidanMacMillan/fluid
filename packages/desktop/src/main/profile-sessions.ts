import { dialog, session, type BrowserWindow } from 'electron'
import { isEphemeralProfile, isProfileId, profileName } from './profiles'
import { partitionFor } from './browsing'
import { reloadViewsIn } from './browser-views'

/**
 * Emptying a browsing profile: everything the five slots accumulate, thrown
 * away so the slot can be used for something else.
 *
 * One space's copy of the slot, not the slot everywhere. A profile is a session
 * within a space (see src/main/browsing.ts), and resetting the red profile
 * while working in the personal space has no business signing anyone out of the
 * red profile at work.
 *
 * This exists because the profiles are a fixed set that gets recycled. A slot
 * still holding the login from whatever it was last used for is the one way
 * this feature can quietly do the wrong thing — you reach for red expecting a
 * fresh sign-in, and get somebody's session from a fortnight ago. Being able to
 * empty one is what makes grabbing a colour a safe thing to do.
 */

/**
 * Empties a profile, after asking. Returns whether anything was cleared.
 *
 * The confirmation is not ceremony: there is no undo, the damage is invisible
 * until the next time a page in that profile is opened, and the cost of getting
 * it wrong is every login in that slot. `clearData` covers the lot — cookies,
 * storage of every kind, caches — which is the point. Anything short of it
 * would leave a profile that is signed out in one place and signed in in
 * another, which is worse than either.
 */
export async function resetProfile(
  space: string | null,
  profile: number,
  window: BrowserWindow | null
): Promise<boolean> {
  // Checked rather than trusted: this arrives from the renderer, and every
  // number that is not a profile would otherwise open a session of its own —
  // `persist:profile-99` is a perfectly good partition name, and nothing else
  // here would notice it had been made.
  if (!isProfileId(profile)) return false
  // Incognito has nothing to reset: it is emptied by closing its last tab (see
  // `discardEphemeralProfile`), and clearing it on request would only be a
  // slower way of saying the same thing. The menu does not offer it; this is
  // for anything that asks anyway.
  if (isEphemeralProfile(profile)) return false

  const partition = partitionFor(space, profile)
  if (!partition) return false

  const name = profileName(profile)
  const question = {
    type: 'warning' as const,
    buttons: ['Reset', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Reset ${name}?`,
    detail:
      'Signs out of every site in this profile, in this space, and clears everything it has stored. The same profile in other spaces is untouched. Tabs already open in it stay open, signed out. This cannot be undone.'
  }

  // Parented to the window that asked, so it opens as a sheet on the app rather
  // than as a window of its own — the same rule the directory picker follows.
  const { response } = window
    ? await dialog.showMessageBox(window, question)
    : await dialog.showMessageBox(question)
  if (response !== 0) return false

  const target = session.fromPartition(partition)
  // In flight before the clear is in flight against data that is about to go;
  // letting those land would write some of it straight back.
  await target.closeAllConnections()
  await target.clearData()

  // The pages in this profile are still showing what they loaded while they
  // were signed in. Nothing about the clear reaches them on its own, so a tab
  // left alone would go on looking logged in until something made it ask.
  reloadViewsIn({ space, profile })
  return true
}
