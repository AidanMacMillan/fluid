import {
  Menu,
  nativeImage,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type NativeImage
} from 'electron'
import {
  DEFAULT_PROFILE_NAME,
  PROFILES,
  REUSABLE_PROFILES,
  isEphemeralProfile,
  profileName,
  type Profile,
  type ProfileColor
} from './profiles'

/**
 * The menu that picks a browsing profile.
 *
 * Native, and popped from here, for a reason that holds everywhere it is used:
 * a browser tab is a `WebContentsView` composited above the window's own page,
 * so nothing the renderer draws can cover one — a menu drawn in the document
 * would slide underneath the very page it was opened next to. The launcher has
 * the same problem from the other end: its window is sized to the panel inside
 * it, so a menu in that document would be clipped by the window's edge. A
 * native menu is the only surface that is above both.
 *
 * The cost is that a colour can only arrive as pixels, which is what `swatch`
 * is for.
 */

/** What the menu was opened on, which is only the wording of its rows. */
export type ProfileVerb = 'open' | 'reopen'

export type ProfilePickOptions = {
  verb: ProfileVerb
  /** The profile the thing is in now. Ticked, and the only one resettable. */
  current?: number | null
  /** Whether to offer emptying the current profile. Off unless asked for. */
  allowReset?: boolean
}

/**
 * What the user settled on. `reset` is deliberately not done here: emptying a
 * profile asks for confirmation and then reloads pages, and this module's job
 * ends at reporting the choice.
 */
export type ProfileChoice =
  { kind: 'profile'; profile: number | null } | { kind: 'reset'; profile: number }

/**
 * The colours a profile is drawn in, as the flat fill of a swatch. The renderer
 * keeps its own copy of these for the tab indicator (see
 * src/renderer/src/lib/profile-colors.ts) — one list is CSS and the other is
 * pixels in a bitmap, and neither medium should have to go through the other.
 * If one moves, move both.
 */
const SWATCH_COLORS: Record<ProfileColor, string> = {
  red: '#f87171',
  blue: '#60a5fa',
  orange: '#fb923c',
  green: '#4ade80',
  purple: '#c084fc',
  grey: '#a1a1aa'
}

/** Each swatch is built once and reused for the life of the app. */
const swatches = new Map<string, NativeImage>()

/**
 * A filled dot to stand beside a profile's name. Menu items take an image and
 * nothing else — there is no way to colour a label — so the colour has to
 * arrive as pixels.
 *
 * Drawn as a bitmap rather than parsed from an SVG: a 12×12 circle is a couple
 * of lines of arithmetic, and `createFromBuffer` takes exactly the BGRA those
 * lines produce.
 */
function swatch(color: string): NativeImage {
  const cached = swatches.get(color)
  if (cached) return cached

  const size = 12
  const radius = size / 2
  const red = parseInt(color.slice(1, 3), 16)
  const green = parseInt(color.slice(3, 5), 16)
  const blue = parseInt(color.slice(5, 7), 16)

  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // From the centre of the pixel, so the edge comes out even all round.
      const dx = x + 0.5 - radius
      const dy = y + 0.5 - radius
      const distance = Math.sqrt(dx * dx + dy * dy)
      // One pixel of feathering at the rim: a hard cut at this size reads as a
      // ragged square rather than as a dot.
      const alpha = Math.round(255 * Math.min(1, Math.max(0, radius - distance)))
      const offset = (y * size + x) * 4
      pixels[offset] = blue
      pixels[offset + 1] = green
      pixels[offset + 2] = red
      pixels[offset + 3] = alpha
    }
  }

  const image = nativeImage.createFromBuffer(pixels, { width: size, height: size, scaleFactor: 1 })
  swatches.set(color, image)
  return image
}

/**
 * The rows themselves, for a menu somebody else is building — the page's own
 * right-click menu, which offers this as a submenu under a link.
 *
 * Every profile carries its name as well as its swatch. The colour is what
 * identifies a profile on a tab row, but a list of six unlabelled dots would be
 * unreadable, and two of these five are the pair colour-blind readers are least
 * able to tell apart.
 */
export function profileMenuItems(
  options: ProfilePickOptions,
  choose: (choice: ProfileChoice) => void
): MenuItemConstructorOptions[] {
  const current = options.current ?? null

  const row = (profile: Profile): MenuItemConstructorOptions => ({
    label: profile.name,
    icon: swatch(SWATCH_COLORS[profile.color]),
    type: 'checkbox' as const,
    checked: current === profile.id,
    click: () => choose({ kind: 'profile', profile: profile.id })
  })

  const incognito = PROFILES.filter((profile) => profile.ephemeral === true)

  const items: MenuItemConstructorOptions[] = [
    {
      label: DEFAULT_PROFILE_NAME,
      // A tick rather than a disabled row: the current profile is still a
      // legitimate thing to choose, and choosing it is simply a no-op.
      type: 'checkbox',
      checked: current === null,
      click: () => choose({ kind: 'profile', profile: null })
    },
    { type: 'separator' },
    ...REUSABLE_PROFILES.map(row),
    // Below a line of its own: incognito is a different kind of thing from the
    // five above it, not a sixth slot. Those are places to come back to; this
    // one is empty again the moment its last tab closes.
    { type: 'separator' },
    ...incognito.map(row)
  ]

  // Only for the profile the thing is actually in: a menu offering to clear
  // them all would be offering to sign the user out of work they cannot see.
  // Never for incognito, which has nothing to reset — it is already emptied by
  // closing its tabs, and an item promising otherwise would suggest it held
  // something worth clearing.
  if (options.allowReset && current !== null && !isEphemeralProfile(current)) {
    items.push(
      { type: 'separator' },
      {
        label: `Reset ${profileName(current)}…`,
        click: () => choose({ kind: 'reset', profile: current })
      }
    )
  }

  return items
}

/**
 * Pops the menu at the cursor and answers what was chosen, or null if it was
 * dismissed. Dismissal has to be told apart from a choice: the default profile
 * is itself a choice, and it is the one `null` would otherwise be confused for.
 */
export function popupProfileMenu(
  window: BrowserWindow | null,
  options: ProfilePickOptions
): Promise<ProfileChoice | null> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (choice: ProfileChoice | null): void => {
      if (settled) return
      settled = true
      resolve(choice)
    }

    const menu = Menu.buildFromTemplate(profileMenuItems(options, settle))

    // A choice settles this from the item's own click handler; the close
    // callback is only here to answer for a menu that was dismissed. Which of
    // the two runs first is not something Electron promises — so rather than
    // depend on an order, the dismissal is deferred a turn, and a click that
    // lands in the same turn as the close wins whichever way round they came.
    // Getting this wrong would be invisible: the menu would work, and picking
    // a profile would silently do nothing.
    const close = (): void => {
      setTimeout(() => settle(null), 0)
    }

    // Deliberately no `x`/`y`, for the reason `attachContextMenu` gives: the
    // coordinates a renderer has are its own, and `popup` measures from the
    // window. Left out, the menu opens at the cursor, which is where it was
    // going anyway.
    if (window && !window.isDestroyed()) menu.popup({ window, callback: close })
    else menu.popup({ callback: close })
  })
}
