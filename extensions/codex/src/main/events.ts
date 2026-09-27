import { basename } from 'node:path'
import type { AgentEvent, AgentItem, AgentQuestion, AgentUsageWindow } from '@fluid/agent-core'
import { array, object, string } from './transport'
const printable = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
const short = (value: unknown): string => printable(value).slice(0, 200_000)

export function questionsFrom(value: unknown): AgentQuestion[] {
  return array(value)
    .map((raw, index) => {
      const q = object(raw)
      return {
        id: string(q.id) || String(index),
        header: string(q.header) || 'Question',
        question: string(q.question) || string(q.title),
        secret: q.isSecret === true,
        options: array(q.options).map((rawOption) => {
          const o = object(rawOption)
          return {
            label: typeof rawOption === 'string' ? rawOption : string(o.label),
            description: string(o.description)
          }
        }),
        multiSelect: false
      }
    })
    .filter((q) => q.question)
}

export function usageEvents(raw: unknown): AgentEvent[] {
  const data = object(raw)
  const buckets = Object.keys(object(data.rateLimitsByLimitId)).length
    ? object(data.rateLimitsByLimitId)
    : { codex: data.rateLimits ?? data }
  const windows: AgentUsageWindow[] = []
  for (const [bucket, value] of Object.entries(buckets)) {
    const limit = object(value)
    for (const key of ['primary', 'secondary']) {
      const w = object(limit[key])
      if (typeof w.usedPercent !== 'number') continue
      const mins = Number(w.windowDurationMins)
      const label =
        mins >= 1440
          ? `${Math.round(mins / 1440)} day`
          : mins >= 60
            ? `${Math.round(mins / 60)} hour`
            : `${mins || '?'} min`
      windows.push({
        id: `${bucket}:${key}`,
        label: `${bucket === 'codex' ? '' : `${bucket} · `}${label}`,
        usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
        ...(typeof w.resetsAt === 'number'
          ? { resetsAt: new Date(w.resetsAt * 1000).toISOString() }
          : {})
      })
    }
  }
  return windows.length ? [{ type: 'usage', windows }] : []
}

/** The mapper accepts unknown wire payloads; unknown tools retain a readable card. */
export class CodexEventMapper {
  private tools = new Map<string, AgentItem>()
  constructor(private readonly attachmentKey: (path: string) => string | null = () => null) {}
  item(raw: unknown, completed: boolean, turnId = '', history = false): AgentEvent[] {
    const item = object(raw)
    const id = string(item.id)
    const type = string(item.type)
    if (!id) return []
    if (type === 'userMessage') {
      if (!history) return []
      let text = array(item.content)
        .map((c) => string(object(c).text))
        .filter(Boolean)
        .join('\n')
      const paths = array(item.content)
        .filter((c) => object(c).type === 'localImage')
        .map((c) => string(object(c).path))
      const marker = '\n\nAttached files (read these paths if needed):\n'
      const at = text.lastIndexOf(marker)
      if (at >= 0) {
        const candidates = text.slice(at + marker.length).split('\n')
        if (candidates.every((path) => this.attachmentKey(path))) {
          paths.push(...candidates)
          text = text.slice(0, at)
        }
      }
      const attachments = paths.flatMap((path) => {
        const key = this.attachmentKey(path)
        return key ? [{ name: basename(path), key }] : []
      })
      return [
        {
          type: 'user',
          itemId: id,
          text,
          ...(turnId ? { uuid: turnId } : {}),
          ...(attachments.length ? { attachments } : {})
        }
      ]
    }
    if (type === 'agentMessage') {
      const events: AgentEvent[] = completed
        ? [{ type: 'text.set', itemId: id, kind: 'text', text: string(item.text) }]
        : []
      if (completed && item.delivery === 'async' && array(item.questions).length)
        events.push({
          type: 'question.opened',
          requestId: `async:${id}`,
          questions: questionsFrom(item.questions),
          responseMode: 'message'
        })
      return events
    }
    if (type === 'reasoning') {
      return completed
        ? array(item.summary).flatMap((text, index): AgentEvent[] => [
            {
              type: 'text.set',
              itemId: `${id}:summary:${index}`,
              kind: 'thinking',
              text: string(text)
            }
          ])
        : []
    }
    if (type === 'plan')
      return completed
        ? [{ type: 'text.set', itemId: id, kind: 'text', text: string(item.text) }]
        : []
    if (type === 'contextCompaction')
      return completed ? [{ type: 'compacted', trigger: 'auto' }] : []
    let card: AgentItem
    const status: AgentItem['status'] = !completed
      ? 'running'
      : ['failed', 'declined', 'error'].includes(string(item.status)) || item.error
        ? 'error'
        : 'ok'
    if (type === 'commandExecution')
      card = {
        id,
        kind: 'command',
        toolName: type,
        title: 'Run command',
        detail: string(item.command),
        input: { command: item.command, cwd: item.cwd },
        status,
        output: short(item.aggregatedOutput ?? '')
      }
    else if (type === 'fileChange')
      card = {
        id,
        kind: 'file-change',
        toolName: type,
        title: 'Edit files',
        detail: array(item.changes)
          .map((c) => string(object(c).path))
          .join(', '),
        input: { changes: item.changes },
        status,
        output: array(item.changes)
          .map((c) => `${string(object(c).path)}\n${string(object(c).diff)}`)
          .join('\n')
          .slice(0, 200_000)
      }
    else if (type === 'mcpToolCall' || type === 'dynamicToolCall')
      card = {
        id,
        kind: 'tool',
        toolName: `${string(item.server)} ${string(item.tool)}`.trim(),
        title: string(item.tool) || 'Tool',
        input: object(item.arguments),
        status,
        output: short(item.error ?? item.result ?? item.contentItems ?? '')
      }
    else if (type === 'webSearch')
      card = {
        id,
        kind: 'search',
        toolName: type,
        title: 'Search the web',
        detail: string(item.query),
        input: object(item.action),
        status
      }
    else
      card = {
        id,
        kind: type.toLowerCase().includes('agent') ? 'task' : 'tool',
        toolName: type,
        title: type || 'Tool',
        input: item,
        status,
        output: completed ? short(item) : undefined
      }
    if (completed) this.tools.delete(id)
    else this.tools.set(id, card)
    return [{ type: completed ? 'item.completed' : 'item.started', item: card }]
  }
  notification(method: string, raw: unknown): AgentEvent[] {
    const p = object(raw)
    const id = string(p.itemId)
    switch (method) {
      case 'item/started':
        return this.item(p.item, false, string(p.turnId))
      case 'item/completed':
        return this.item(p.item, true, string(p.turnId))
      case 'item/agentMessage/delta':
      case 'item/plan/delta':
        return [{ type: 'text.delta', itemId: id, kind: 'text', delta: string(p.delta) }]
      case 'item/reasoning/summaryTextDelta':
        return [
          {
            type: 'text.delta',
            itemId: `${id}:summary:${Number(p.summaryIndex) || 0}`,
            kind: 'thinking',
            delta: string(p.delta)
          }
        ]
      case 'item/commandExecution/outputDelta': {
        const item = this.tools.get(id)
        if (!item) return []
        const updated = { ...item, output: ((item.output ?? '') + string(p.delta)).slice(-200_000) }
        this.tools.set(id, updated)
        return [{ type: 'item.updated', item: updated }]
      }
      case 'turn/plan/updated':
        return [
          {
            type: 'plan',
            steps: array(p.plan).map((s) => {
              const step = object(s)
              return {
                step: string(step.step),
                status:
                  step.status === 'completed'
                    ? 'completed'
                    : step.status === 'inProgress'
                      ? 'inProgress'
                      : 'pending'
              }
            })
          }
        ]
      case 'thread/tokenUsage/updated': {
        const usage = object(p.tokenUsage)
        const last = object(usage.last)
        const max = Number(usage.modelContextWindow)
        const used = Number(last.totalTokens)
        return max > 0 && Number.isFinite(used)
          ? [
              {
                type: 'context',
                context: {
                  usedTokens: used,
                  maxTokens: max,
                  usedPercent: Math.min(100, (used / max) * 100),
                  segments: []
                }
              }
            ]
          : []
      }
      case 'account/rateLimits/updated':
        return usageEvents(p)
      case 'thread/name/updated':
        return typeof p.threadName === 'string' ? [{ type: 'title', title: p.threadName }] : []
      case 'error':
        return [
          {
            type: 'notice',
            level: p.willRetry ? 'warning' : 'error',
            message: string(object(p.error).message) || 'Codex reported an error.'
          }
        ]
      default:
        return []
    }
  }
}
