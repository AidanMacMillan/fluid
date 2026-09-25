import type { TaskActionInfo } from '../../../main/task-actions'
import { reasonFrom } from './ipc-error'

/**
 * The buttons in a task's panel, and what pressing one is doing.
 *
 * Kept per task rather than for whichever task is in front, because an action
 * outlives the user's attention: a merge pressed on one task and left to run
 * while they move to the next should still read as running — and its failure
 * still be waiting — when they come back.
 *
 * The list itself lives in the main process (see src/main/task-actions.ts);
 * this holds only what has been drawn from it and asks again after each press,
 * since what an action did is usually what decides whether it is still offered.
 */

export type TaskActionsState = {
  actions: TaskActionInfo[]
  /** The id of the one under way, or null. Only one runs at a time per task. */
  running: string | null
  /** What the last press said when it failed, until the next press. */
  error: string | null
}

const EMPTY: TaskActionsState = { actions: [], running: null, error: null }

class TaskActions {
  #states = $state<Record<string, TaskActionsState>>({})
  /**
   * Which load is the latest, per task, so an answer that comes back after a
   * newer one was asked for is dropped rather than drawn over it.
   */
  #loads = new Map<string, number>()

  for(taskId: string | null): TaskActionsState {
    return (taskId !== null ? this.#states[taskId] : undefined) ?? EMPTY
  }

  /** Asks what the task's type offers it now. A failure keeps what was drawn. */
  async load(taskId: string): Promise<void> {
    const load = (this.#loads.get(taskId) ?? 0) + 1
    this.#loads.set(taskId, load)
    try {
      const actions = await window.api.tasks.actions(taskId)
      if (this.#loads.get(taskId) !== load) return
      this.#states[taskId] = { ...this.for(taskId), actions }
    } catch (error) {
      console.warn('Could not list the task actions:', reasonFrom(error))
    }
  }

  async run(taskId: string, actionId: string): Promise<void> {
    if (this.for(taskId).running !== null) return
    this.#states[taskId] = { ...this.for(taskId), running: actionId, error: null }

    let error: string | null = null
    try {
      const result = await window.api.tasks.runAction(taskId, actionId)
      if (result.status === 'failed') error = result.message
    } catch (cause) {
      error = reasonFrom(cause)
    }

    this.#states[taskId] = { ...this.for(taskId), running: null, error }
    await this.load(taskId)
  }
}

export const taskActions = new TaskActions()
