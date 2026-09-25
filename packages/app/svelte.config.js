import adapter from '@sveltejs/adapter-cloudflare'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Reads wrangler.jsonc for where the Worker and its assets go, and gives
    // `vite dev` the same bindings through a local proxy.
    adapter: adapter()
  }
}

export default config
