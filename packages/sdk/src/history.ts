/** A durable visit or extension event, owned by the task where it happened. */
export type HistoryEntry = {
  id: string
  taskId: string
  /** A reference, retained even after the tab closes. */
  tabId: string | null
  /** Core tab type or an extension-namespaced event type. */
  type: string
  label: string
  title: string
  /** Page URL, file path, working directory, or extension-defined location. */
  location: string | null
  sessionId: string | null
  /** Set by the host, never supplied by an extension. */
  extensionId: string | null
  metadata: Record<string, unknown>
  visitedAt: Date
  /** Remembered site icon for this visit's origin, even after its tab has closed. */
  favicon?: string
}

/** Payload field names to include with automatic visits to this tab type. */
export type TabHistoryFields = {
  location?: string
  sessionId?: string
}
