import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { open, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import {
  createMock,
  deactivateAll,
  deleteMock,
  duplicateMock,
  emptyValue,
  hasMockscope,
  initProject,
  loadProject,
  renameMock,
  saveMock,
  setActiveMock,
  syncProject,
  type Project,
} from '@mockscope/core'
import type { MockscopeApi, OpenResult } from '../shared/api.ts'

let window: BrowserWindow | undefined
let current: { root: string; project: Project; watchers: FSWatcher[] } | undefined

// ---------------------------------------------------------------------------------------------
// Recent projects

const recentFile = () => join(app.getPath('userData'), 'recent-projects.json')

async function recentProjects(): Promise<string[]> {
  try {
    return JSON.parse(await readFile(recentFile(), 'utf8'))
  } catch {
    return []
  }
}

async function remember(root: string) {
  const list = [root, ...(await recentProjects()).filter((r) => r !== root)].slice(0, 8)
  await writeFile(recentFile(), JSON.stringify(list, null, 2))
}

// ---------------------------------------------------------------------------------------------
// Opening, and keeping the renderer in sync with the files

async function openProject(root: string): Promise<OpenResult> {
  closeProject()
  if (!hasMockscope(root)) return { kind: 'needs-init', root, specCandidates: await findSpecs(root) }
  try {
    const project = await loadProject(root)
    current = { root, project, watchers: [] }
    startWatching(root, project)
    await remember(root)
    window?.setTitle(`${basename(root)} · mockscope`)
    return { kind: 'opened', root, project }
  } catch (error) {
    return { kind: 'error', root, message: (error as Error).message }
  }
}

function closeProject() {
  current?.watchers.forEach((w) => w.close())
  current = undefined
  window?.setTitle('mockscope')
}

/**
 * Files are the source of truth: the Vite plugin, your editor and git all change them too.
 * Reload on any change and push the result to the renderer.
 */
function startWatching(root: string, project: Project) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let specChanged = false
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(async () => {
      if (current?.root !== root) return
      try {
        // A new spec means new schemas, and starter mocks for any new operations.
        if (specChanged) await syncProject(root)
        specChanged = false
        await reload()
      } catch (error) {
        console.error('[mockscope] reload failed:', error)
      }
    }, 120)
  }
  const specPath = resolve(project.dir, project.config.spec)
  current!.watchers.push(
    watch(project.dir, { recursive: true }, schedule),
    watch(specPath, () => {
      specChanged = true
      schedule()
    }),
  )
}

async function reload(): Promise<Project> {
  if (!current) throw new Error('No project open')
  current.project = await loadProject(current.root)
  window?.webContents.send('project-changed', current.project)
  return current.project
}

function requireProject(): Project {
  if (!current) throw new Error('No project open')
  return current.project
}

/** Spec-looking JSON files near the project root, to offer when setting up `.mockscope`. */
async function findSpecs(root: string, depth = 3): Promise<string[]> {
  const found: string[] = []
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.mockscope'])
  const walk = async (dir: string, level: number) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && level < depth && !skip.has(entry.name)) await walk(path, level + 1)
      else if (entry.isFile() && entry.name.endsWith('.json') && (await looksLikeSpec(path))) found.push(path)
    }
  }
  await walk(root, 0)
  return found.sort((a, b) => relative(root, a).length - relative(root, b).length)
}

async function looksLikeSpec(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0)
    return /"(openapi|swagger)"\s*:\s*"[23]/.test(buffer.toString('utf8', 0, bytesRead))
  } finally {
    await handle.close()
  }
}

function uniqueName(project: Project, operationId: string, base: string): string {
  const taken = new Set(project.operations.find((op) => op.id === operationId)?.mocks.map((m) => m.name))
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base} ${n}`
  return name
}

// ---------------------------------------------------------------------------------------------
// IPC: one channel, dispatched by method name. Mutations write files, then return the reloaded project.

const api: { [K in keyof MockscopeApi]?: (...args: never[]) => unknown } = {
  recentProjects,
  async pickProject() {
    const result = await dialog.showOpenDialog(window!, { title: 'Open project folder', properties: ['openDirectory'] })
    return result.canceled || !result.filePaths[0] ? null : openProject(result.filePaths[0])
  },
  openProject,
  async pickSpec(root: string) {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose the OpenAPI / Swagger JSON',
      defaultPath: root,
      properties: ['openFile'],
      filters: [{ name: 'OpenAPI JSON', extensions: ['json'] }],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  },
  async initProject(root: string, specPath: string) {
    try {
      await initProject(root, specPath)
    } catch (error) {
      return { kind: 'error', root, message: (error as Error).message } satisfies OpenResult
    }
    return openProject(root)
  },
  async closeProject() {
    closeProject()
  },
  async sync() {
    const result = await syncProject(requireProject().dir)
    return { project: await reload(), result }
  },
  async setActive(operationId: string, name: string | null) {
    await setActiveMock(requireProject(), operationId, name)
    return reload()
  },
  async deactivateAll() {
    await deactivateAll(requireProject())
    return reload()
  },
  async createMock(operationId: string, status: number) {
    const project = requireProject()
    const response = project.spec.operations.find((op) => op.id === operationId)?.responses.find((r) => r.status === status)
    const name = uniqueName(project, operationId, 'new mock')
    const body = response?.schema ? emptyValue(response.schema, project.spec.definitions) : undefined
    await createMock(project, operationId, name, { status, body })
    return { project: await reload(), name }
  },
  async duplicateMock(operationId: string, name: string) {
    const copy = await duplicateMock(requireProject(), operationId, name)
    return { project: await reload(), name: copy }
  },
  async renameMock(operationId: string, from: string, to: string) {
    await renameMock(requireProject(), operationId, from, to)
    return reload()
  },
  async deleteMock(operationId: string, name: string) {
    await deleteMock(requireProject(), operationId, name)
    return reload()
  },
  async saveMock(operationId: string, name: string, file) {
    await saveMock(requireProject(), operationId, name, file)
    return reload()
  },
  async revealMock(operationId: string, name: string) {
    shell.showItemInFolder(join(requireProject().dir, 'mocks', operationId, `${name}.json`))
  },
}

ipcMain.handle('mockscope', async (_event, method: keyof MockscopeApi, ...args: unknown[]) => {
  const handler = api[method] as ((...args: unknown[]) => unknown) | undefined
  if (!handler) throw new Error(`Unknown method ${method}`)
  return handler(...args)
})

// ---------------------------------------------------------------------------------------------

function createWindow() {
  window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 560,
    title: 'mockscope',
    backgroundColor: '#16181b',
    autoHideMenuBar: true,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs') },
  })
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  window.on('closed', () => {
    window = undefined
  })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  closeProject()
  app.quit()
})
