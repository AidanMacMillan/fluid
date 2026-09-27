import type { AgentProvider } from '@fluid/agent-core'
import { CLAUDE_DEFAULT_MODE, CLAUDE_DEFAULT_EFFORT, CLAUDE_EFFORTS } from './tab'
export const claudeProvider: AgentProvider = {
  id: 'claude-code',
  name: 'Claude Code',
  askName: 'Claude',
  icon: 'icon-[logos--claude-icon]',
  attachmentScheme: 'claude-code-file',
  defaultMode: CLAUDE_DEFAULT_MODE,
  defaultEffort: CLAUDE_DEFAULT_EFFORT,
  efforts: CLAUDE_EFFORTS,
  capabilities: { fork: true, fileRevert: true },
  modes: [
    { value: 'plan', label: 'Plan', hint: 'Explore and propose, but do not edit.' },
    { value: 'default', label: 'Ask', hint: 'Ask before anything that is not already allowed.' },
    {
      value: 'auto',
      label: 'Auto',
      hint: 'A model decides the easy calls and asks about the rest.'
    },
    { value: 'acceptEdits', label: 'Accept edits', hint: 'Edit files without asking.' },
    { value: 'bypassPermissions', label: 'Full access', hint: 'Run anything without asking.' }
  ]
}
