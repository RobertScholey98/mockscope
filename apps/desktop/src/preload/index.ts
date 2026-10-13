import { contextBridge, ipcRenderer } from 'electron'
import type { MockscopeApi, Project } from '../shared/api.ts'

const call =
  (method: keyof MockscopeApi) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke('mockscope', method, ...args)

const api: MockscopeApi = {
  recentProjects: call('recentProjects'),
  pickProject: call('pickProject'),
  openProject: call('openProject'),
  pickSpec: call('pickSpec'),
  initProject: call('initProject'),
  closeProject: call('closeProject'),
  sync: call('sync'),
  setActive: call('setActive'),
  deactivateAll: call('deactivateAll'),
  createMock: call('createMock'),
  duplicateMock: call('duplicateMock'),
  renameMock: call('renameMock'),
  deleteMock: call('deleteMock'),
  saveMock: call('saveMock'),
  revealMock: call('revealMock'),
  onProjectChanged(listener) {
    const handler = (_event: unknown, project: Project) => listener(project)
    ipcRenderer.on('project-changed', handler)
    return () => ipcRenderer.removeListener('project-changed', handler)
  },
}

contextBridge.exposeInMainWorld('mockscope', api)
