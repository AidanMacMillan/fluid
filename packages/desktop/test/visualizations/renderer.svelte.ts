import { mount } from 'svelte'
import AgentMarkdown from '../../../agent-core/src/views/components/AgentMarkdown.svelte'

const url = new URL(location.href).searchParams.get('preview')!
const props = $state({
  source:
    'Before\nvisualize{"path":"/fixture.html","title":"Interactive preview","mode":"wide"}\nAfter',
  id: 'message',
  streaming: true,
  loadVisualization: async () => {
    window.testLoads++
    return url
  },
  onFollowUp: (prompt: string) => {
    window.testDraft = prompt
  }
})
declare global {
  interface Window {
    testLoads: number
    testDraft: string
    updateMessage: (source: string) => void
  }
}
window.testLoads = 0
window.testDraft = ''
window.updateMessage = (source) => {
  props.source = source
}
mount(AgentMarkdown, { target: document.body, props })
