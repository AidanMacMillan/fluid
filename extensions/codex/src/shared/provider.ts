import type { AgentProvider } from '@fluid/agent-core'
export const codexProvider: AgentProvider = {
  id: 'codex',
  name: 'Codex',
  icon: 'icon-[logos--openai-icon]',
  attachmentScheme: 'codex-file',
  defaultMode: 'workspace',
  defaultEffort: 'high',
  efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  capabilities: { fork: true, fileRevert: false },
  modes: [
    {
      value: 'read-only',
      label: 'Read only',
      hint: 'Explore without changing project files. Requests for additional access require approval.'
    },
    {
      value: 'workspace',
      label: 'Workspace',
      hint: 'Edit project files; ask before additional access. Fluid workspace changes require approval.'
    },
    {
      value: 'full',
      label: 'Full access',
      hint: 'Run commands and change files or Fluid tasks without asking.'
    }
  ]
}
