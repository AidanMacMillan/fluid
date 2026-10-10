<script lang="ts">
  import { fluid } from '../lib/api'
  import { reasonFrom } from '../lib/ipc-error'
  import { saveSearchEngine } from '../lib/search-engine-setting'
  import {
    QUERY_PLACEHOLDER,
    SEARCH_ENGINE_PRESETS,
    SEARCH_ENGINE_SETTING,
    customSearchTemplate,
    searchEngineSetting,
    type SearchEngineSetting
  } from '../../../shared/search-engine'

  /**
   * `id` is the engine being edited, or null for a new one. `done` runs once the
   * engine is saved or removed, and when the form is cancelled.
   */
  let { id, done }: { id: string | null; done: () => void } = $props()

  let setting = $state<SearchEngineSetting>(searchEngineSetting(null))
  let loaded = $state(false)
  let saving = $state(false)
  let name = $state('')
  let url = $state('')
  let error = $state<string | null>(null)

  // The fields start from the saved engine, if there is one. Filled once: a
  // later echo of this panel's own save must not overwrite what is being typed.
  $effect(() =>
    fluid.watch(
      'settings.get',
      { key: SEARCH_ENGINE_SETTING },
      (value) => {
        setting = searchEngineSetting(value)
        if (!loaded) {
          const existing = setting.custom.find((engine) => engine.id === id)
          name = existing?.name ?? ''
          url = existing?.url ?? ''
          loaded = true
        }
      },
      (cause) => (error = reasonFrom(cause))
    )
  )

  async function write(next: SearchEngineSetting): Promise<void> {
    saving = true
    error = null
    try {
      await saveSearchEngine(next)
      done()
    } catch (cause) {
      error = reasonFrom(cause)
    } finally {
      saving = false
    }
  }

  async function save(): Promise<void> {
    const label = name.trim()
    const template = customSearchTemplate(url)
    if (!label) {
      error = 'Give the search engine a name.'
      return
    }
    if (!template) {
      error = `Enter a web address with ${QUERY_PLACEHOLDER} where the search goes, such as https://example.com/search?q=${QUERY_PLACEHOLDER}.`
      return
    }
    const saved = {
      id: id ?? `custom:${crypto.randomUUID()}`,
      name: label.slice(0, 40),
      url: template
    }
    await write({
      // A new engine is taken up straight away; an edited one keeps what was picked.
      id: id === null ? saved.id : setting.id,
      custom:
        id === null
          ? [...setting.custom, saved]
          : setting.custom.map((engine) => (engine.id === id ? saved : engine))
    })
  }

  async function remove(): Promise<void> {
    // Taking the picked engine away falls back to the default rather than to nothing.
    await write({
      id: setting.id === id ? SEARCH_ENGINE_PRESETS[0].id : setting.id,
      custom: setting.custom.filter((engine) => engine.id !== id)
    })
  }
</script>

<form
  class="flex flex-col gap-3 text-xs"
  onsubmit={(event) => {
    event.preventDefault()
    void save()
  }}
>
  <label class="flex flex-col gap-1.5">
    <span class="font-medium text-ink-100">Name</span>
    <input
      type="text"
      name="search-engine-name"
      placeholder="My search"
      maxlength="40"
      bind:value={name}
      disabled={!loaded}
      class="rounded-md bg-white/5 px-2.5 py-2 text-ink-100 ring-1 ring-white/10 outline-none focus:ring-marker/60"
    />
  </label>
  <label class="flex flex-col gap-1.5">
    <span class="font-medium text-ink-100">Search address</span>
    <input
      type="text"
      name="search-engine-url"
      placeholder={`https://example.com/search?q=${QUERY_PLACEHOLDER}`}
      spellcheck="false"
      autocapitalize="off"
      bind:value={url}
      disabled={!loaded}
      class="rounded-md bg-white/5 px-2.5 py-2 text-ink-100 ring-1 ring-white/10 outline-none focus:ring-marker/60"
    />
    <span class="text-ink-400"
      >Use <code class="text-ink-200">{QUERY_PLACEHOLDER}</code> where the search terms go. Run a search
      on the site and copy its address from the address bar to see where.</span
    >
  </label>
  {#if error}<p role="alert" class="text-red-400">{error}</p>{/if}
  <div class="flex items-center gap-2">
    {#if id !== null}
      <button
        type="button"
        disabled={saving}
        onclick={() => void remove()}
        class="rounded-md glass-control px-3 py-2 text-red-400 disabled:opacity-40">Remove</button
      >
    {/if}
    <span class="flex-1"></span>
    <button
      type="button"
      disabled={saving}
      onclick={done}
      class="rounded-md glass-control px-3 py-2 disabled:opacity-40">Cancel</button
    >
    <button
      type="submit"
      disabled={saving || !loaded || !name.trim() || !url.trim()}
      class="rounded-md glass-control px-3 py-2 disabled:opacity-40">Save</button
    >
  </div>
</form>
