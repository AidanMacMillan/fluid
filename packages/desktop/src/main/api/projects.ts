import type { Project, Space, Tab, Task } from '@fluid/sdk'
import { getProject, listProjects, updateProject } from '../db/projects'
import { getSpace, listSpaces } from '../db/spaces'
import { listTabs } from '../db/tabs'
import { listTasks } from '../db/tasks'
import { resolveDirectory, usableCwd } from '../directories'
import {
  activeProject,
  createProject,
  deleteProject,
  projectRoot,
  renameProject,
  setActiveProject
} from '../projects'
import { createSpace, deleteSpace, moveProjectToSpace, renameSpace } from '../spaces'
import { emit } from './bus'
import { ApiError, found } from './errors'
import { clearTaskClipboard } from './teardown'

/**
 * Projects and spaces, as the API offers them. The rules themselves — names
 * cannot be blank, the last project and the default space cannot go, deleting
 * a space clears its sessions — are in src/main/projects.ts and
 * src/main/spaces.ts, which these wrap and announce.
 */

export async function list(): Promise<Project[]> {
  return listProjects()
}

export async function get(id: string): Promise<Project | null> {
  return (await getProject(id)) ?? null
}

export async function active(): Promise<Project | null> {
  return (await activeProject()) ?? null
}

export async function setActive(id: string): Promise<Project> {
  const before = await activeProject()
  found(await getProject(id), 'project')
  const project = found(await setActiveProject(id), 'project')
  if (before?.id !== project.id) emit({ type: 'project.activated', project })
  return project
}

export async function create(input: {
  name: string
  root?: string | null
  spaceId?: string
}): Promise<Project> {
  if (input.spaceId !== undefined) found(await getSpace(input.spaceId), 'space')
  const project = await createProject(input.name, input.root ?? null, input.spaceId)
  emit({ type: 'project.created', project })
  emit({ type: 'project.activated', project })
  return project
}

export async function rename(id: string, name: string): Promise<Project> {
  const project = found(await renameProject(id, name), 'project')
  emit({ type: 'project.updated', project })
  return project
}

export async function setRoot(id: string, root: string | null): Promise<Project> {
  const project = found(
    await updateProject(id, { root: root === null ? null : resolveDirectory(root) }),
    'project'
  )
  emit({ type: 'project.updated', project })
  return project
}

export async function workingDirectory(id?: string): Promise<string> {
  if (id === undefined) return projectRoot()
  return usableCwd(found(await getProject(id), 'project').root)
}

export async function setSpace(id: string, spaceId: string): Promise<Project> {
  found(await getProject(id), 'project')
  if (!(await moveProjectToSpace(id, spaceId))) throw new ApiError('That space no longer exists.')
  const project = found(await getProject(id), 'project')
  emit({ type: 'project.updated', project })
  return project
}

export async function remove(id: string, confirmation: string): Promise<void> {
  const project = found(await getProject(id), 'project')
  const wasActive = (await activeProject())?.id === id

  // Refused before anything is touched, so a mistyped confirmation costs
  // nothing. `deleteProject` asks both again; these are the same rules.
  if (confirmation.trim() !== project.name) throw new ApiError(`Type ${project.name} to delete it.`)
  if ((await listProjects()).length === 1) {
    throw new ApiError('This is the only project. Make another one before deleting it.')
  }

  // Everything under the project cascades away with it. Read first, so what its
  // tabs were running can be stopped once the rows are gone.
  const doomed: { task: Task; tabs: Tab[] }[] = []
  for (const task of await listTasks(id)) {
    doomed.push({ task, tabs: await listTabs(task.id) })
    await clearTaskClipboard(task.id)
  }

  await deleteProject(id, confirmation)

  for (const { task, tabs } of doomed) emit({ type: 'task.deleted', task, tabs })
  emit({ type: 'project.deleted', project })

  if (wasActive) {
    const next = await activeProject()
    if (next) emit({ type: 'project.activated', project: next })
  }
}

// Spaces

export async function listAllSpaces(): Promise<Space[]> {
  return listSpaces()
}

export async function createSpaceNamed(name: string): Promise<Space> {
  const space = await createSpace(name)
  emit({ type: 'space.created', space })
  return space
}

export async function renameSpaceTo(id: string, name: string): Promise<Space> {
  const space = found(await renameSpace(id, name), 'space')
  emit({ type: 'space.updated', space })
  return space
}

export async function removeSpace(id: string): Promise<void> {
  const space = found(await getSpace(id), 'space')
  const moving = (await listProjects()).filter((project) => project.spaceId === id)
  await deleteSpace(id)
  emit({ type: 'space.deleted', space })
  // Its projects fall back to the default space.
  for (const { id: projectId } of moving) {
    const project = await getProject(projectId)
    if (project) emit({ type: 'project.updated', project })
  }
}
