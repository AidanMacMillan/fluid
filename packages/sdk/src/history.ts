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
  /** Computed by history.list; recovery is checked again by history.open. */
  canOpen?: boolean
  unavailableReason?: string
}

/** References to retain for this tab type, and how to restore a saved visit. */
export type TabHistoryFields = {
  location?: string
  sessionId?: string
  /** Explicitly retained payload fields, stored in metadata.payload. Never include prompts or commands. */
  payload?: string[]
  /**
   * Build a payload for this tab type from a saved visit, or null if it cannot
   * be restored. Called when listing and opening history: keep this read-only,
   * fast, and free of network requests. Only return fields needed to identify
   * the destination; Fluid also uses these to find an already open tab.
   * Existing history may predate this declaration and lack metadata.payload.
   */
  restore?: (
    entry: HistoryEntry
  ) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>
}
