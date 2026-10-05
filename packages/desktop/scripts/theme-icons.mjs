// Renders the app icon once per theme, into resources/.
//
// build/icon.svg is the icon — the default theme's, the one packaged builds
// ship, and the reference every other version is drawn from. Each theme's
// version is that same drawing with its four colours swapped for the theme's
// own, taken from the tokens in src/renderer/src/assets/themes.css. At runtime
// src/main/app-icon.ts puts the current theme's version in the dock. Each also
// has a dev version, with "DEV" across the square, for runs from source — so
// the dev app is never mistaken for an installed one.
//
// The PNGs are not checked in: scripts/ensure-icons.mjs renders them when dev,
// start or build finds them missing or stale. To render them anyway, run this
// in Electron, which is already here and draws SVG the way the app does:
//
//   pnpm --filter @fluid/desktop icons
//
// A new theme is an entry below, and an import in src/main/app-icon.ts.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow } from 'electron'

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
const SIZE = 1024

/**
 * Each theme's colours for the icon's four: the ground, the two ends of the
 * square's gradient (the lit corner, then the shaded one) and the square's
 * edge. The ground is the theme's popover glass, the lit end its brightest
 * ink, the edge its muted ink, and the shaded end whatever the theme lights
 * things up with — its drag marker, or its switch for Blossom, whose marker is
 * too pale to shade with. Graphite has no colour of its own, so it shades to
 * grey like the default. Frost's ice is all near-white, so its shaded end is
 * pulled down from the loading bar's ice to the default's depth.
 */
const THEMES = {
  graphite: {
    ground: 'oklch(11% 0 0)',
    lit: 'oklch(99% 0 0)',
    shade: 'oklch(72% 0 0)',
    edge: 'oklch(57% 0 0)'
  },
  midnight: {
    ground: 'oklch(15% 0.02 270)',
    lit: 'oklch(98.5% 0.004 270)',
    shade: 'oklch(74% 0.15 292)',
    edge: 'oklch(56% 0.045 278)'
  },
  spooktober: {
    ground: 'oklch(13% 0.01 45)',
    lit: 'oklch(98.5% 0.004 85)',
    shade: 'oklch(72% 0.19 50)',
    edge: 'oklch(57% 0.058 56)'
  },
  frost: {
    ground: 'oklch(20% 0.02 238)',
    lit: 'oklch(99% 0.004 225)',
    shade: 'oklch(76% 0.07 218)',
    edge: 'oklch(59% 0.035 234)'
  },
  blossom: {
    ground: 'oklch(19% 0.005 350)',
    lit: 'oklch(98.8% 0.003 350)',
    shade: 'oklch(70% 0.16 355)',
    edge: 'oklch(56% 0.009 350)'
  }
}

/** Where each of the four sits in build/icon.svg. Each must appear exactly once. */
const SLOTS = {
  ground: 'fill="black"',
  lit: 'stop-color="white"',
  shade: 'stop-color="#9C9C9C"',
  edge: 'stroke="#737373"'
}

/** `oklch(L% C H)` as sRGB hex, so the SVG reads the same in any tool, not only in Chromium. */
function hex(color) {
  const [, l, c, h] = color.match(/^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/).map(Number)
  const hr = (h * Math.PI) / 180
  const L = l / 100
  const a = c * Math.cos(hr)
  const b = c * Math.sin(hr)
  const lms = [
    L + 0.3963377774 * a + 0.2158037573 * b,
    L - 0.1055613458 * a - 0.0638541728 * b,
    L - 0.0894841775 * a - 1.291485548 * b
  ].map((v) => v ** 3)
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2]
  ]
  return (
    '#' +
    linear
      .map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
      .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

function recolor(svg, theme, colors) {
  for (const [slot, needle] of Object.entries(SLOTS)) {
    const count = svg.split(needle).length - 1
    if (count !== 1) {
      throw new Error(
        `build/icon.svg has ${count} of ${needle} (the ${slot}), not one — update SLOTS to match the new icon before rendering ${theme}.`
      )
    }
    svg = svg.replace(needle, needle.replace(/"[^"]*"$/, `"${hex(colors[slot])}"`))
  }
  return svg
}

/**
 * dock.setIcon bypasses macOS's icon treatment. Bake a soft bevel and the two
 * diagonal specular highlights into the runtime images so switching themes
 * doesn't turn the tile flat. Keep build/icon.svg untreated: macOS supplies
 * its own finish to the packaged icon. This is a static approximation, not
 * the system's dynamic Liquid Glass rendering.
 * The rim and bevel are twice their original widths for a stronger highlight
 * at dock sizes. Both follow the shared tile outline, with their outer halves
 * clipped away to keep the highlight inside the silhouette.
 * Broad shoulders in the gradients carry the light along the straight edges,
 * with a faint rim between the two diagonal highlights.
 */
function withHighlights(svg) {
  return svg
    .replace(
      '</defs>',
      `<clipPath id="tile-clip"><use href="#tile-outline"/></clipPath>
<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">
<stop stop-color="#fff" stop-opacity="0.75"/>
<stop offset="0.28" stop-color="#fff" stop-opacity="0.4"/>
<stop offset="0.5" stop-color="#fff" stop-opacity="0.08"/>
<stop offset="0.72" stop-color="#fff" stop-opacity="0.3"/>
<stop offset="1" stop-color="#fff" stop-opacity="0.6"/>
</linearGradient>
<linearGradient id="bevel" x1="0" y1="0" x2="1" y2="1">
<stop stop-color="#fff" stop-opacity="0.22"/>
<stop offset="0.28" stop-color="#fff" stop-opacity="0.1"/>
<stop offset="0.5" stop-color="#fff" stop-opacity="0.02"/>
<stop offset="0.72" stop-color="#fff" stop-opacity="0.07"/>
<stop offset="1" stop-color="#fff" stop-opacity="0.16"/>
</linearGradient>
</defs>`
    )
    .replace(
      '</svg>',
      `<g clip-path="url(#tile-clip)">
<use href="#tile-outline" stroke="url(#bevel)" stroke-width="32"/>
<use href="#tile-outline" stroke="url(#rim)" stroke-width="12"/>
</g>
</svg>`
    )
}

/**
 * "DEV" across the square, in the icon's ground colour so it reads against the
 * square's light gradient. The square is 408px wide, centred on the canvas.
 */
function withDevLabel(svg, ground) {
  return svg.replace(
    '</svg>',
    `<text x="512" y="512" fill="${ground}" font-family="'SF Pro Rounded', 'Helvetica Neue', Arial, sans-serif" font-size="145" font-weight="900" letter-spacing="4" text-anchor="middle" dominant-baseline="central">DEV</text>
</svg>`
  )
}

async function render(window, svg) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const page = `<body style="margin:0;background:transparent"><img src="${src}" width="${SIZE}" height="${SIZE}" style="display:block"></body>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
  // A frame after load, so the image is painted rather than merely decoded.
  await window.webContents.executeJavaScript(
    'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  )
  const image = await window.webContents.capturePage()
  const { width } = image.getSize()
  return (
    width === SIZE ? image : image.resize({ width: SIZE, height: SIZE, quality: 'best' })
  ).toPNG()
}

app.dock?.hide()

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true }
  })

  const reference = readFileSync(join(desktop, 'build/icon.svg'), 'utf8')
  mkdirSync(join(desktop, 'resources/icons/dev'), { recursive: true })

  const write = async (out, svg) => {
    writeFileSync(join(desktop, out), await render(window, svg))
    console.log(out)
  }

  await write('resources/icon.png', withHighlights(reference))
  await write('resources/icons/dev/default.png', withHighlights(withDevLabel(reference, 'black')))
  for (const [theme, colors] of Object.entries(THEMES)) {
    const themed = recolor(reference, theme, colors)
    await write(`resources/icons/${theme}.png`, withHighlights(themed))
    await write(
      `resources/icons/dev/${theme}.png`,
      withHighlights(withDevLabel(themed, hex(colors.ground)))
    )
  }

  window.destroy()
  app.quit()
})
