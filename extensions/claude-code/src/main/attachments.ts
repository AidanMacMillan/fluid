import { createAttachmentStore } from '@fluid/agent-core/main'
export const {
  setAttachmentsRoot,
  attachmentsRoot,
  attachmentsDirectory,
  discardAttachments,
  pruneAttachments,
  attachmentKey,
  ATTACHMENT_SCHEME_PRIVILEGES,
  serveAttachment
} = createAttachmentStore('claude-code-file', 'claude-code.session', true)
