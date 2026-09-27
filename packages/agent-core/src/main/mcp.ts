import { createServer, type Server } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AgentTool } from './tool'
import { READ_ONLY_TOOLS } from './tools'

/** One loopback endpoint and credential per live session. Never persisted. */
export async function createAgentMcpBridge(
  tools: AgentTool[],
  authorize: (tool: AgentTool, input: Record<string, unknown>) => Promise<boolean>
): Promise<{ url: string; token: string; close: () => void }> {
  const token = randomBytes(32).toString('base64url')
  const expected = Buffer.from(`Bearer ${token}`)
  const active = new Set<McpServer>()
  let closed = false
  const server: Server = createServer((req, res) => {
    void (async () => {
      const actual = Buffer.from(req.headers.authorization ?? '')
      if (closed || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.writeHead(401).end()
        return
      }
      if (req.headers.origin || req.url !== '/mcp') {
        res.writeHead(403).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1024 * 1024) {
          res.writeHead(413).end()
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      let body: unknown
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      const mcp = new McpServer({ name: 'fluid', version: '1.0.0' })
      active.add(mcp)
      for (const tool of tools) {
        const readOnly = READ_ONLY_TOOLS.has(`mcp__fluid__${tool.name}`)
        mcp.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: tool.shape,
            annotations: {
              readOnlyHint: readOnly,
              destructiveHint: !readOnly,
              openWorldHint: false
            }
          },
          async (input) => {
            if (closed) throw new Error('This Fluid session has ended.')
            if (!readOnly && !(await authorize(tool, input)))
              return {
                content: [{ type: 'text', text: 'The user declined this Fluid action.' }],
                isError: true
              }
            if (closed) throw new Error('This Fluid session has ended.')
            return tool.run(input)
          }
        )
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      })
      res.on('close', () => {
        active.delete(mcp)
        void mcp.close().catch(() => {})
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Could not start the Fluid tool bridge.')
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    close: () => {
      closed = true
      server.close()
      server.closeAllConnections()
      for (const mcp of active) void mcp.close().catch(() => {})
      active.clear()
    }
  }
}
