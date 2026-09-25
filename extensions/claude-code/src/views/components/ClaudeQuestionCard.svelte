<script lang="ts">
  import type { ClaudeQuestion } from '../../main/events'

  /**
   * The model's own questions, from `AskUserQuestion`.
   *
   * Not an approval, though it arrives through the same door: nothing is being
   * asked for permission here, the model has reached a fork it cannot pick for
   * the user and is asking which way. Common in plan mode.
   *
   * The answer goes back keyed by the question's own text, which is what the
   * tool expects. A question the user would rather answer in their own words is
   * left to the composer — dismissing the card says so, and the model asks
   * again or carries on.
   */
  type Props = {
    questions: ClaudeQuestion[]
    onAnswer: (answers: Record<string, string> | null) => void
  }
  const { questions, onAnswer }: Props = $props()

  /** What has been picked so far, by question. Multi-select holds several. */
  let picked = $state<Record<string, string[]>>({})

  const answered = $derived(
    questions.every((question) => (picked[question.question] ?? []).length > 0)
  )

  function choose(question: ClaudeQuestion, label: string): void {
    const current = picked[question.question] ?? []
    if (!question.multiSelect) {
      picked = { ...picked, [question.question]: [label] }
      return
    }
    const next = current.includes(label)
      ? current.filter((entry) => entry !== label)
      : [...current, label]
    picked = { ...picked, [question.question]: next }
  }

  function send(): void {
    const answers: Record<string, string> = {}
    for (const question of questions) {
      answers[question.question] = (picked[question.question] ?? []).join(', ')
    }
    onAnswer(answers)
  }
</script>

<div class="rounded-md bg-black/20 px-3 py-2.5 ring-1 ring-white/10">
  {#each questions as question (question.question)}
    <div class="mb-3 last:mb-0">
      <p class="text-xs text-ink-200">{question.question}</p>
      {#if question.multiSelect}
        <p class="mt-0.5 text-[10px] text-ink-500">Choose any that apply.</p>
      {/if}
      <div class="mt-1.5 flex flex-col gap-1 select-none">
        {#each question.options as option (option.label)}
          {@const on = (picked[question.question] ?? []).includes(option.label)}
          <button
            type="button"
            onclick={() => choose(question, option.label)}
            aria-pressed={on}
            class="rounded-md glass-control px-2 py-1.5 text-left ring-1 {on
              ? 'ring-ink-300/50'
              : 'ring-transparent'}"
          >
            <span class="block text-[11px] font-medium text-ink-200">{option.label}</span>
            {#if option.description}
              <span class="block text-[10px] leading-relaxed text-ink-500"
                >{option.description}</span
              >
            {/if}
          </button>
        {/each}
      </div>
    </div>
  {/each}

  <div class="mt-2 flex items-center gap-1.5 select-none">
    <button
      type="button"
      disabled={!answered}
      onclick={send}
      class="h-6 rounded-md bg-ink-100 px-2.5 text-[11px] font-medium text-ink-900
             hover:bg-white disabled:pointer-events-none disabled:bg-ink-700
             disabled:text-ink-500"
    >
      Answer
    </button>
    <button
      type="button"
      onclick={() => onAnswer(null)}
      class="h-6 rounded-md glass-control px-2.5 text-[11px] text-ink-400 hover:text-ink-100"
    >
      I'll type it instead
    </button>
  </div>
</div>
