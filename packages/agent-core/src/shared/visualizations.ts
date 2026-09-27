/** Provider-neutral local HTML preview, with an adapter for Codex's content marker. */
export type AgentVisualization = { path: string; title?: string; mode?: 'wide' }
export type AgentContentPart =
  | { kind: 'markdown'; source: string }
  | { kind: 'visualization'; visualization: AgentVisualization }

export const MAX_VISUALIZATION_BYTES = 1_000_000
export const VISUALIZATION_INSTRUCTIONS =
  'Fluid can display interactive HTML inline. When a visualization helps, write a self-contained HTML file under the session working directory (under 1 MB), then reference it on its own line using a fenced fluid-visualization block containing JSON: {"path":"/absolute/path/chart.html","title":"Chart","mode":"wide"}. Title and mode are optional. Codex visualize content markers are also supported. Use inline CSS and JavaScript; no local resource URLs or API calls. Approved static CDNs: cdnjs.cloudflare.com, esm.sh, cdn.jsdelivr.net, unpkg.com, fonts.googleapis.com, fonts.gstatic.com, fonts.bunny.net. Controls run locally in a sandbox. window.openai.sendFollowUpMessage({prompt}) offers the user a draft to review; it does not submit automatically. Do not use other host APIs.'

export function parseVisualization(value: unknown): AgentVisualization | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (
    typeof v.path !== 'string' ||
    v.path.length > 4096 ||
    v.path.includes('\0') ||
    !/^(\/|[A-Za-z]:[\\/])/.test(v.path) ||
    !/\.html?$/i.test(v.path) ||
    (v.title !== undefined && (typeof v.title !== 'string' || v.title.length > 250)) ||
    (v.mode !== undefined && v.mode !== 'wide')
  )
    return null
  return {
    path: v.path,
    ...(v.title ? { title: v.title as string } : {}),
    ...(v.mode === 'wide' ? { mode: 'wide' } : {})
  }
}

function fromJSON(source: string): AgentVisualization | null {
  try {
    return parseVisualization(JSON.parse(source))
  } catch {
    return null
  }
}

/** Only standalone references execute. Quoted examples and code fences stay prose. */
export function agentContent(source: string, streaming = false): AgentContentPart[] {
  const parts: AgentContentPart[] = []
  let markdown = ''
  let fence: { char: string; length: number } | null = null
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const flush = (): void => {
    if (markdown) parts.push({ kind: 'markdown', source: markdown })
    markdown = ''
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const trimmed = line.trim()
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r?\n$/, ''))
    if (fence) {
      markdown += line
      if (
        delimiter &&
        delimiter[1]![0] === fence.char &&
        delimiter[1]!.length >= fence.length &&
        !delimiter[2]!.trim()
      )
        fence = null
      continue
    }
    if (delimiter?.[2]?.trim() === 'fluid-visualization') {
      let end = i + 1
      while (end < lines.length && lines[end]!.trim() !== delimiter[1]) end++
      if (end === lines.length && streaming) break
      const visualization = end < lines.length ? fromJSON(lines.slice(i + 1, end).join('')) : null
      if (visualization) {
        flush()
        parts.push({ kind: 'visualization', visualization })
        i = end
        continue
      }
    }
    if (delimiter) fence = { char: delimiter[1]![0]!, length: delimiter[1]!.length }
    const marker = /^ {0,3}visualize(.*?)\s*$/.exec(line)
    const visualization = marker ? fromJSON(marker[1]!) : null
    if (visualization) {
      flush()
      parts.push({ kind: 'visualization', visualization })
    } else if (
      streaming &&
      i === lines.length - 1 &&
      trimmed.startsWith('') &&
      ('visualize'.startsWith(trimmed) ||
        (trimmed.startsWith('visualize') && !trimmed.includes('')))
    ) {
      break
    } else markdown += line
  }
  flush()
  return parts
}
