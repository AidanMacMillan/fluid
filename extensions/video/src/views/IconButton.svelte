<script lang="ts">
  type Props = {
    /**
     * A literal Iconify utility class, e.g. `icon-[ph--plus]`. It has to be
     * written out at the call site: the Tailwind plugin generates icons by
     * scanning source text, so a class assembled at runtime produces nothing.
     */
    icon: string
    label: string
    /** `sm` for the close affordances that live inside a row, `md` standalone. */
    size?: 'sm' | 'md'
    /** Dimmed and inert — a dead end the user can see, rather than one that moves. */
    disabled?: boolean
    class?: string
    onclick: (event: MouseEvent) => void
  }

  const {
    icon,
    label,
    size = 'md',
    disabled = false,
    class: className = '',
    onclick
  }: Props = $props()
</script>

<button
  type="button"
  title={label}
  aria-label={label}
  {disabled}
  {onclick}
  class="grid shrink-0 place-items-center rounded-md glass-control text-ink-400 no-drag hover:text-ink-100 {size ===
  'sm'
    ? 'size-5 text-xs'
    : 'size-6 text-sm'} disabled:pointer-events-none disabled:text-ink-600 {className}"
>
  <span class={icon} aria-hidden="true"></span>
</button>
