import type { ExtensionViews } from '@fluid/sdk'

/**
 * Every extension's view half, by extension id, for the page their tabs are
 * drawn in (see src/renderer/src/extension-view.ts).
 *
 * Loaded on demand rather than imported, so that a view draws only its own
 * extension's code: each entry is a chunk of its own, fetched by the one page
 * that needs it. Built in for now, like `RENDERERS` in extensions.svelte.ts;
 * an installed extension's would be fetched from wherever it was installed.
 */
export const EXTENSION_VIEWS: Record<string, () => Promise<ExtensionViews>> = {
  slack: () => import('@fluid/extension-slack/views').then((module) => module.default),
  'claude-code': () =>
    import('@fluid/extension-claude-code/views').then((module) => module.default),
  terminal: () => import('@fluid/extension-terminal/views').then((module) => module.default),
  image: () => import('@fluid/extension-image/views').then((module) => module.default),
  video: () => import('@fluid/extension-video/views').then((module) => module.default)
}
