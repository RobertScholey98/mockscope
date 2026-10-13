// The contract between the renderer and the main process. Types only: both sides import it.
import type { MockFile, Project, SyncResult } from '@mockscope/core'

export type { Mock, MockFile, OperationView, Project, ValidationIssue, JsonSchema } from '@mockscope/core'

export type OpenResult =
  | { kind: 'opened'; root: string; project: Project }
  | { kind: 'needs-init'; root: string; specCandidates: string[] }
  | { kind: 'error'; root: string; message: string }

export interface MockscopeApi {
  recentProjects(): Promise<string[]>
  /** Shows a folder picker. `null` if cancelled. */
  pickProject(): Promise<OpenResult | null>
  openProject(root: string): Promise<OpenResult>
  /** Shows a file picker for the OpenAPI/Swagger JSON. `null` if cancelled. */
  pickSpec(root: string): Promise<string | null>
  initProject(root: string, specPath: string): Promise<OpenResult>
  closeProject(): Promise<void>

  sync(): Promise<{ project: Project; result: SyncResult }>
  setActive(operationId: string, name: string | null): Promise<Project>
  deactivateAll(): Promise<Project>
  /** Creates a mock from the spec's empty value for `status`. Returns the new name. */
  createMock(operationId: string, status: number): Promise<{ project: Project; name: string }>
  duplicateMock(operationId: string, name: string): Promise<{ project: Project; name: string }>
  renameMock(operationId: string, from: string, to: string): Promise<Project>
  deleteMock(operationId: string, name: string): Promise<Project>
  saveMock(operationId: string, name: string, file: MockFile): Promise<Project>
  revealMock(operationId: string, name: string): Promise<void>

  /** Fires whenever files under `.mockscope/` or the spec change, from any source. */
  onProjectChanged(listener: (project: Project) => void): () => void
}

declare global {
  interface Window {
    mockscope: MockscopeApi
  }
}
