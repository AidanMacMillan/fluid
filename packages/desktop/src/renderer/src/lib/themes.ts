/**
 * The themes the app can be drawn in, as the theme picker lists them.
 *
 * What each one looks like lives in src/renderer/src/assets/themes.css, under
 * `[data-theme='<id>']`; this is only what the picker needs to offer it. A new
 * theme is a block there and an entry here, in the order the cards should run:
 * the everyday themes first, then the seasonal ones.
 */

export type Theme = {
  /** The `data-theme` value, and what the setting stores. */
  id: string
  name: string
  description: string
}

export const THEMES: readonly Theme[] = [
  {
    id: 'default',
    name: 'Default',
    description: 'Neutral greys over the glass, with blue for what is loading.'
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Near-black glass, bright white text and firmer white selections.'
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Blue-black glass, moonlit text and soft violet selections.'
  },
  {
    id: 'spooktober',
    name: 'Spooktober',
    description: 'Pumpkin orange selections, ghost white text and darker glass.'
  },
  {
    id: 'frost',
    name: 'Frost',
    description: 'Cold blue-grey glass, snow white text and icy silver selections.'
  },
  {
    id: 'blossom',
    name: 'Blossom',
    description: 'Soft neutral glass with cherry blossom pink wherever something lights up.'
  }
]

export const DEFAULT_THEME = 'default'

/** Where the choice is kept. Keep in sync with THEME_SETTING_KEY in src/main/theme.ts. */
export const THEME_SETTING_KEY = 'appearance.theme'

/** The theme the page is drawn in right now — whatever the preload last stamped on the root. */
export function currentTheme(): string {
  return document.documentElement.dataset.theme || DEFAULT_THEME
}
