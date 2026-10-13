export type JsonSchema = { [key: string]: unknown }

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export interface OperationResponse {
  status: number
  description?: string
  /** Response body schema, already converted to JSON Schema draft-07. */
  schema?: JsonSchema
}

export interface Operation {
  /** operationId from the spec, or one derived from method + path. Filesystem-safe. */
  id: string
  method: HttpMethod
  /** Path as written in the spec, e.g. `/update_todo/{id}`. */
  path: string
  summary?: string
  tags: string[]
  responses: OperationResponse[]
}

export interface Spec {
  title: string
  version: string
  /** Path prefix every operation is served under, e.g. `/api`. Empty string for none. */
  basePath: string
  operations: Operation[]
  /** Component schemas converted to JSON Schema, keyed by name. Referenced as `#/definitions/<name>`. */
  definitions: Record<string, JsonSchema>
}

/** `.mockscope/mockscope.json` */
export interface ProjectConfig {
  /** Path to the OpenAPI/Swagger document, relative to the `.mockscope` directory. */
  spec: string
  /** Overrides the base path derived from the spec's `servers` / `basePath`. */
  basePath?: string
}

/** `.mockscope/state.json`: which mock (if any) is switched on for each operation. */
export interface ProjectState {
  active: Record<string, string>
}

/** Contents of `.mockscope/mocks/<operationId>/<name>.json` */
export interface MockFile {
  $schema?: string
  status: number
  /** Milliseconds to wait before responding. */
  delay?: number
  headers?: Record<string, string>
  body?: unknown
}

export interface ValidationIssue {
  /** JSON pointer into the mock file, e.g. `/body/0/title`. */
  path: string
  message: string
}

export interface Mock {
  operationId: string
  name: string
  file: MockFile
  /** Non-empty when the file doesn't parse or doesn't match the spec. */
  issues: ValidationIssue[]
}

export interface OperationView extends Operation {
  mocks: Mock[]
  activeMock: string | null
}

export interface Project {
  /** Absolute path of the `.mockscope` directory. */
  dir: string
  config: ProjectConfig
  spec: Spec
  operations: OperationView[]
  /** Mock folders whose operation no longer exists in the spec. */
  orphans: Mock[]
  state: ProjectState
}

/** A switched-on mock, flattened into what the interceptor needs. */
export interface ActiveRoute {
  operationId: string
  mockName: string
  method: HttpMethod
  /** Regex source matched against the request URL's pathname. */
  pathPattern: string
  status: number
  delay: number
  headers: Record<string, string>
  body?: unknown
}
