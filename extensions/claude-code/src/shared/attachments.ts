/**
 * The scheme a view loads attachments over:
 * `claude-code-file://attachments/<tab>/<name>`.
 *
 * A view may not name an absolute path, and the attachments are not in the
 * app's own store. So they come back the way the Slack extension's media
 * does, over a scheme of the extension's own, which the view's page policy
 * names (see src/renderer/extension-view.html in the app). Served by
 * `serveAttachment` in ../main/attachments.ts.
 */
export const ATTACHMENT_SCHEME = 'claude-code-file'

/** The address an attachment is drawn from, by its key relative to the root. */
export function attachmentUrl(key: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/')
  return `${ATTACHMENT_SCHEME}://attachments/${path}`
}
