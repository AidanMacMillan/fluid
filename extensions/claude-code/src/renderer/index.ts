import { defineRendererExtension, type NewTab, type NewTaskTemplate } from '@fluid/sdk'
import type { Component } from 'svelte'
import { CLAUDE_TAB, folderName, isClaudeTab, type ClaudeTabPayload } from '../shared/tab'

/**
 * The Claude Code extension's half in the app's windows: how a session's row
 * reads, the launcher rows that start one — blank, or already asked
 * something — and the new-task row that starts one already asked something. The session itself is drawn in
 * a view of its own; see ../views.
 */
export default defineRendererExtension<Component<never>>({
  id: 'claude-code',

  tabs: {
    session: {
      icon: 'icon-[logos--claude-icon]',
      // Named after the folder until the conversation has a name of its own,
      // for the reason a terminal and an editor are: it is the one short thing
      // that tells two of them apart, and a conversation has no title until
      // it has had a turn.
      label: (tab) => (isClaudeTab(tab) ? folderName(tab.payload.cwd) : null),
      // The row is only the folder's last segment, and two sessions in
      // different checkouts of the same repository would draw two identical
      // rows.
      tooltip: (tab) => (isClaudeTab(tab) ? tab.payload.cwd : null)
    }
  },

  launcher: [
    {
      id: 'session',
      label: 'Claude Code',
      icon: 'icon-[logos--claude-icon]',
      keywords: ['ai', 'agent', 'assistant', 'anthropic', 'chat', 'cc'],
      // Starts where a new terminal would. A session's working directory is
      // settled when its process starts, so the tab records the answer rather
      // than working it out again on a later launch — and unlike a terminal's
      // it never changes afterwards: `cd` moves a shell, and nothing moves a
      // session.
      open: async (host): Promise<NewTab> => {
        const payload: ClaudeTabPayload = { cwd: await host.api.projects.workingDirectory({}) }
        return { type: CLAUDE_TAB, title: null, payload }
      }
    },
    {
      id: 'ask',
      label: 'Ask Claude',
      icon: 'icon-[logos--claude-icon]',
      // The new-task panel's row of the same name, for a session in the task
      // already selected: offered once something is typed, which becomes the
      // session's first turn.
      typed: true,
      open: async (text, host): Promise<NewTab> => {
        const payload: ClaudeTabPayload = {
          cwd: await host.api.projects.workingDirectory({}),
          prompt: text
        }
        return { type: CLAUDE_TAB, title: null, payload }
      }
    }
  ],

  newTask: [
    {
      id: 'ask',
      label: 'Ask Claude',
      icon: 'icon-[logos--claude-icon]',
      // Only once something is typed, and for whatever that is: the text is the
      // session's first turn, and the task's name — the same name the row above
      // would give a blank task for it.
      typed: true,
      open: async (text, host): Promise<NewTaskTemplate> => {
        const payload: ClaudeTabPayload = {
          cwd: await host.api.projects.workingDirectory({}),
          prompt: text
        }
        return { title: text, tabs: [{ type: CLAUDE_TAB, title: null, payload }] }
      }
    }
  ]
})
