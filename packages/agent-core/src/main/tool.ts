import { z } from 'zod'
export type AgentToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }
export type AgentTool = {
  name: string
  description: string
  shape: z.ZodRawShape
  run: (input: Record<string, unknown>) => Promise<AgentToolResult>
}
export function defineAgentTool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (input: z.infer<z.ZodObject<S>>) => Promise<AgentToolResult>
): AgentTool {
  return { name, description, shape, run: (input) => run(z.object(shape).parse(input)) }
}
