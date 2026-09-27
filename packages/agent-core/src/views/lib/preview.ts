import { agentContent } from '../../shared/visualizations'

/** Text for compact previews; rich content belongs in the full transcript. */
export function agentPreview(source: string, streaming = false): string {
  return (
    agentContent(source, streaming)
      .flatMap((part) => (part.kind === 'markdown' ? [part.source] : []))
      .join('\n')
      // Provider content markers frame metadata with these delimiters. Hide the
      // whole payload, including unknown kinds and unfinished streaming markers,
      // rather than maintaining a list of individual widgets here.
      .replace(/[^]*(?:|$)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}
