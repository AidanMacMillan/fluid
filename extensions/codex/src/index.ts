import { createAgentExtension } from '@fluid/agent-core/main'
import { codexProvider } from './shared/provider'
import { createCodexAdapter } from './main/sessions'
export default createAgentExtension(codexProvider, createCodexAdapter)
