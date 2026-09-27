import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
export type RpcId = string | number
export type RpcMessage = {
  id?: RpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
export const string = (value: unknown): string => (typeof value === 'string' ? value : '')
export const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** JSONL framing and process lifetime are independent of Codex display mapping. */
export class CodexTransport {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    RpcId,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private nextId = 0
  private buffer = ''
  private stderr = ''
  private closed = false
  private killTimer?: ReturnType<typeof setTimeout>
  constructor(
    binary: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly receive: (message: RpcMessage) => void,
    private readonly exited: (error: Error) => void
  ) {
    this.child = spawn(binary, args, { cwd, env, stdio: 'pipe', windowsHide: true })
    const decoder = new StringDecoder('utf8')
    this.child.stdout.on('data', (data: Buffer) => {
      this.buffer += decoder.write(data)
      if (this.buffer.length > 32 * 1024 * 1024) {
        this.fail(new Error('Codex exceeded the maximum protocol message size.'))
        this.close()
        return
      }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim()
        this.buffer = this.buffer.slice(end + 1)
        if (!line) continue
        try {
          this.dispatch(JSON.parse(line) as RpcMessage)
        } catch {
          this.fail(new Error('Codex returned an invalid protocol message.'))
          this.close()
          return
        }
      }
    })
    this.child.stderr.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4096)
    })
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.on('error', (error) => this.fail(error))
    this.child.on('exit', (code, signal) => {
      clearTimeout(this.killTimer)
      this.fail(
        new Error(
          `Codex stopped (${signal ?? code ?? 'unknown'}).${this.stderr ? ` ${this.stderr.trim()}` : ''}`
        )
      )
    })
  }
  private dispatch(message: RpcMessage): void {
    if (message.method) {
      this.receive(message)
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(message.error.message || 'Codex request failed.'))
    else pending.resolve(message.result)
  }
  private write(message: RpcMessage): void {
    if (this.closed || this.child.stdin.destroyed)
      throw new Error('The Codex connection is closed.')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  request(method: string, params: unknown = {}, timeout = 60_000): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`Codex did not answer ${method}. Reconnect before trying again.`)
        reject(error)
        // A timed-out mutation has an unknown outcome. Do not accept more work
        // on this process and risk submitting a turn twice.
        this.fail(error)
        this.close()
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  notify(method: string, params: unknown = {}): void {
    this.write({ method, params })
  }
  respond(id: RpcId, result: unknown): void {
    this.write({ id, result })
  }
  reject(id: RpcId, message: string): void {
    this.write({ id, error: { code: -32601, message } })
  }
  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
    this.exited(error)
  }
  close(): void {
    if (!this.closed) {
      this.closed = true
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('The Codex session was closed.'))
      }
      this.pending.clear()
    }
    this.child.stdin.end()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGTERM')
    this.killTimer ??= setTimeout(() => this.child.kill('SIGKILL'), 2000)
    this.killTimer.unref()
  }
}
