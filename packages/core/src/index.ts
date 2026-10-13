export * from './types.ts'
export { parseSpec, pathPattern } from './spec.ts'
export { toJsonSchema, mockFileSchema } from './schema.ts'
export { emptyValue } from './sample.ts'
export {
  MOCKSCOPE_DIR,
  resolveMockscopeDir,
  hasMockscope,
  initProject,
  syncProject,
  loadProject,
  activeRoutes,
  validateMockName,
  saveMock,
  createMock,
  duplicateMock,
  renameMock,
  deleteMock,
  setActiveMock,
  deactivateAll,
  type SyncResult,
} from './project.ts'
