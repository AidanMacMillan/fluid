import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// The workspace's own packages ship TypeScript source rather than a build, so
// they are bundled in like the app's own modules instead of being left as
// requires that would find a .ts file at runtime. The native haptics addon
// stays external so its binary can be loaded from the packaged app. The other
// workspace dependencies are discovered here, so a new extension needs nothing
// here.
const { dependencies } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))
const WORKSPACE_PACKAGES = Object.entries(dependencies as Record<string, string>)
  .filter(([name, version]) => name !== '@fluid/haptics' && version.startsWith('workspace:'))
  .map(([name]) => name)

export default defineConfig({
  // PGlite ships WASM and Postgres data files alongside its JS, so it has to
  // stay an external require rather than being bundled into out/main.
  main: {
    plugins: [externalizeDepsPlugin({ exclude: WORKSPACE_PACKAGES })]
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({ exclude: [...WORKSPACE_PACKAGES, '@ghostery/adblocker-content'] })
    ],
    // Browsing and extension preloads run sandboxed: every runtime dependency
    // must be bundled, with no shared chunks or external require except Electron.
    // The app window preload can use Node and stays separate.
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'extension-view': resolve(__dirname, 'src/preload/extension-view.ts'),
          'extension-host': resolve(__dirname, 'src/preload/extension-host.ts'),
          adblocker: resolve(__dirname, 'src/preload/adblocker.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [tailwindcss(), svelte()],
    // Seven pages, because settings, the launcher, the project picker, the
    // clipboard panel and the find bar are surfaces of their own — the first
    // four windows (see src/main/settings-window.ts, src/main/launcher-window.ts,
    // src/main/project-window.ts and src/main/clipboard-window.ts), the last a
    // view composited over the page it searches (see src/main/find-bar.ts). All
    // five exist because nothing the renderer paints can cover a browser tab's
    // native view. They share every component and the preload; only the entry
    // differs. The seventh is the page every extension tab drawn in a view of
    // its own is loaded into (see src/main/extension-views.ts), which has a
    // preload of its own.
    build: {
      // Every asset inlines as a `data:` URL rather than landing as a file
      // beside the page. The launcher is loaded off `file://` in production
      // and its CSP allows `'self'` and `data:` only — and `'self'` does not
      // match a file: origin, so a favicon emitted as a file would be blocked
      // in the built app while working perfectly against the dev server. The
      // limit is well clear of anything an icon weighs.
      assetsInlineLimit: 16384,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html'),
          launcher: resolve(__dirname, 'src/renderer/launcher.html'),
          project: resolve(__dirname, 'src/renderer/project.html'),
          clipboard: resolve(__dirname, 'src/renderer/clipboard.html'),
          find: resolve(__dirname, 'src/renderer/find.html'),
          'split-drop': resolve(__dirname, 'src/renderer/split-drop.html'),
          popout: resolve(__dirname, 'src/renderer/popout.html'),
          'extension-view': resolve(__dirname, 'src/renderer/extension-view.html'),
          'extension-host': resolve(__dirname, 'src/renderer/extension-host.html')
        }
      }
    }
  }
})
