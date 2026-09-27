export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENTS = 10
export function attachmentUrl(scheme: string, key: string): string {
  return `${scheme}://attachments/${key.split('/').map(encodeURIComponent).join('/')}`
}
