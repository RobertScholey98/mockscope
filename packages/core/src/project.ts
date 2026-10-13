import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { Ajv, type ValidateFunction } from 'ajv'
import addFormatsModule from 'ajv-formats'
import { mockFileSchema, UNDOCUMENTED_STATUS_SCHEMA } from './schema.ts'
import { emptyValue } from './sample.ts'
import { parseSpec, pathPattern } from './spec.ts'
import type {
  ActiveRoute,
  JsonSchema,
  Mock,
  MockFile,
  Operation,
  OperationView,
  Project,
  ProjectConfig,
  ProjectState,
  Spec,
  ValidationIssue,
} from './types.ts'

// ajv-formats is CommonJS; depending on the loader its default export arrives wrapped.
const addFormats = ((addFormatsModule as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv) => Ajv

export const MOCKSCOPE_DIR = '.mockscope'
const CONFIG_FILE = 'mockscope.json'
const STATE_FILE = 'state.json'
const SCHEMAS_DIR = 'schemas'
const MOCKS_DIR = 'mocks'
const UNDOCUMENTED_SCHEMA_FILE = '_undocumented.json'

/** Accepts either a project root or its `.mockscope` directory. */
export function resolveMockscopeDir(path: string): string {
  const absolute = resolve(path)
  return basename(absolute) === MOCKSCOPE_DIR ? absolute : join(absolute, MOCKSCOPE_DIR)
}

export function hasMockscope(path: string): boolean {
  return existsSync(join(resolveMockscopeDir(path), CONFIG_FILE))
}

/** Creates `.mockscope/` next to `projectRoot`, pointing at `specPath`, and generates the starting mocks. */
export async function initProject(projectRoot: string, specPath: string): Promise<Project> {
  const dir = resolveMockscopeDir(projectRoot)
  if (existsSync(join(dir, CONFIG_FILE))) throw new Error(`${dir} already contains a mockscope project`)
  // Parse before writing anything so a bad spec leaves no half-made project behind.
  parseSpec(JSON.parse(await readFile(specPath, 'utf8')))

  await mkdir(dir, { recursive: true })
  const config: ProjectConfig = { spec: toPosix(relative(dir, resolve(specPath))) }
  await writeJson(join(dir, CONFIG_FILE), config)
  await writeJson(join(dir, STATE_FILE), { active: {} } satisfies ProjectState)
  // Which mocks are switched on is a personal, moment-to-moment choice; keep it out of git.
  await writeFile(join(dir, '.gitignore'), `${STATE_FILE}\n`)
  await syncProject(dir)
  return loadProject(dir)
}

export interface SyncResult {
  createdMocks: string[]
  removedSchemas: string[]
}

/**
 * Regenerates `schemas/` from the spec and creates starter mocks for operations that have no mocks folder yet.
 * Never touches existing mocks: ones that no longer match the spec show up as validation issues instead.
 */
export async function syncProject(path: string): Promise<SyncResult> {
  const dir = resolveMockscopeDir(path)
  const config = await readConfig(dir)
  const spec = await readSpec(dir, config)
  const schemasDir = join(dir, SCHEMAS_DIR)
  await mkdir(schemasDir, { recursive: true })

  const written = new Set<string>([UNDOCUMENTED_SCHEMA_FILE])
  await writeJson(join(schemasDir, UNDOCUMENTED_SCHEMA_FILE), UNDOCUMENTED_STATUS_SCHEMA)
  for (const operation of spec.operations) {
    for (const response of operation.responses) {
      const file = schemaFileName(operation.id, response.status)
      written.add(file)
      await writeJson(join(schemasDir, file), mockFileSchema(operation, response, spec))
    }
  }

  const removedSchemas: string[] = []
  for (const file of await readdir(schemasDir)) {
    if (file.endsWith('.json') && !written.has(file)) {
      await rm(join(schemasDir, file))
      removedSchemas.push(file)
    }
  }

  const createdMocks: string[] = []
  for (const operation of spec.operations) {
    const folder = join(dir, MOCKS_DIR, operation.id)
    if (existsSync(folder)) continue
    await mkdir(folder, { recursive: true })
    for (const response of operation.responses) {
      const file: MockFile = { status: response.status }
      if (response.schema) file.body = emptyValue(response.schema, spec.definitions)
      await writeMockFile(dir, operation, String(response.status), file)
      createdMocks.push(`${operation.id}/${response.status}`)
    }
  }

  return { createdMocks, removedSchemas }
}

export async function loadProject(path: string): Promise<Project> {
  const dir = resolveMockscopeDir(path)
  const config = await readConfig(dir)
  const spec = await readSpec(dir, config)
  const state = await readState(dir)
  const validator = new MockValidator(spec)
  const operationsById = new Map(spec.operations.map((op) => [op.id, op]))

  const mocksByOperation = new Map<string, Mock[]>()
  const mocksDir = join(dir, MOCKS_DIR)
  const folders = existsSync(mocksDir) ? await readdir(mocksDir, { withFileTypes: true }) : []
  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    const operation = operationsById.get(folder.name)
    const mocks: Mock[] = []
    for (const file of (await readdir(join(mocksDir, folder.name))).sort(compareNames)) {
      if (!file.endsWith('.json')) continue
      mocks.push(await readMock(join(mocksDir, folder.name, file), folder.name, operation, validator))
    }
    mocksByOperation.set(folder.name, mocks)
  }

  const operations: OperationView[] = spec.operations.map((op) => {
    const mocks = mocksByOperation.get(op.id) ?? []
    const active = state.active[op.id]
    return { ...op, mocks, activeMock: mocks.some((m) => m.name === active) ? active! : null }
  })
  const orphans = [...mocksByOperation.entries()].filter(([id]) => !operationsById.has(id)).flatMap(([, mocks]) => mocks)

  return { dir, config, spec, operations, orphans, state }
}

/** Every switched-on mock, ready to hand to the interceptor. Mocks whose JSON doesn't parse are skipped. */
export function activeRoutes(project: Project): ActiveRoute[] {
  const basePath = project.config.basePath ?? project.spec.basePath
  return project.operations.flatMap((op) => {
    const mock = op.mocks.find((m) => m.name === op.activeMock)
    if (!mock || mock.issues.some((issue) => issue.path === '' && issue.message.startsWith('Invalid JSON'))) return []
    return [
      {
        operationId: op.id,
        mockName: mock.name,
        method: op.method,
        pathPattern: pathPattern(basePath, op.path),
        status: mock.file.status,
        delay: mock.file.delay ?? 0,
        headers: mock.file.headers ?? {},
        body: mock.file.body,
      },
    ]
  })
}

// ---------------------------------------------------------------------------------------------
// Editing. Each function writes to disk; callers reload the project to see the result.

export function validateMockName(name: string): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return 'Name cannot be empty'
  if (/[\\/:*?"<>|]/.test(trimmed)) return 'Name cannot contain \\ / : * ? " < > |'
  if (trimmed.startsWith('.')) return 'Name cannot start with a dot'
  return undefined
}

export async function saveMock(project: Project, operationId: string, name: string, file: MockFile): Promise<void> {
  const operation = requireOperation(project, operationId)
  await writeMockFile(project.dir, operation, requireValidName(name), file)
}

export async function createMock(project: Project, operationId: string, name: string, file: MockFile): Promise<void> {
  if (existsSync(mockPath(project.dir, operationId, name))) throw new Error(`A mock named "${name}" already exists`)
  await saveMock(project, operationId, name, file)
}

/** Copies a mock to `<name> copy` (or `copy 2`, ...) and returns the new name. */
export async function duplicateMock(project: Project, operationId: string, name: string): Promise<string> {
  const source = requireMock(project, operationId, name)
  let copyName = `${name} copy`
  for (let n = 2; existsSync(mockPath(project.dir, operationId, copyName)); n++) copyName = `${name} copy ${n}`
  await saveMock(project, operationId, copyName, structuredClone(source.file))
  return copyName
}

export async function renameMock(project: Project, operationId: string, from: string, to: string): Promise<void> {
  requireMock(project, operationId, from)
  const target = requireValidName(to)
  if (target === from) return
  if (existsSync(mockPath(project.dir, operationId, target))) throw new Error(`A mock named "${target}" already exists`)
  await rename(mockPath(project.dir, operationId, from), mockPath(project.dir, operationId, target))
  if (project.state.active[operationId] === from) await setActiveMock(project, operationId, target)
}

export async function deleteMock(project: Project, operationId: string, name: string): Promise<void> {
  await rm(mockPath(project.dir, operationId, name))
  if (project.state.active[operationId] === name) await setActiveMock(project, operationId, null)
}

/** Switches `name` on for its operation (switching off any sibling), or switches the operation back to live with `null`. */
export async function setActiveMock(project: Project, operationId: string, name: string | null): Promise<void> {
  const active = { ...project.state.active }
  if (name === null) delete active[operationId]
  else active[operationId] = name
  project.state = { active }
  await writeJson(join(project.dir, STATE_FILE), project.state)
}

export async function deactivateAll(project: Project): Promise<void> {
  project.state = { active: {} }
  await writeJson(join(project.dir, STATE_FILE), project.state)
}

// ---------------------------------------------------------------------------------------------

class MockValidator {
  private readonly ajv = addFormats(new Ajv({ allErrors: true, strict: false }))
  private readonly cache = new Map<string, ValidateFunction>()

  private readonly spec: Spec

  constructor(spec: Spec) {
    this.spec = spec
  }

  validate(operation: Operation, file: unknown): ValidationIssue[] {
    const status = typeof file === 'object' && file !== null ? (file as MockFile).status : undefined
    const response = operation.responses.find((r) => r.status === status)
    const key = response ? `${operation.id}.${response.status}` : UNDOCUMENTED_SCHEMA_FILE
    let validate = this.cache.get(key)
    if (!validate) {
      const schema: JsonSchema = response ? mockFileSchema(operation, response, this.spec) : UNDOCUMENTED_STATUS_SCHEMA
      validate = this.ajv.compile(schema)
      this.cache.set(key, validate)
    }
    if (validate(file)) return []
    return (validate.errors ?? []).map((error) => ({
      path: error.instancePath,
      message:
        error.keyword === 'additionalProperties'
          ? `unexpected property "${(error.params as { additionalProperty: string }).additionalProperty}"`
          : error.keyword === 'const' && error.instancePath === '/status'
            ? `status ${status} is not documented for this operation`
            : (error.message ?? error.keyword),
    }))
  }
}

async function readMock(
  path: string,
  operationId: string,
  operation: Operation | undefined,
  validator: MockValidator,
): Promise<Mock> {
  const name = basename(path, '.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    return {
      operationId,
      name,
      file: { status: 0 },
      issues: [{ path: '', message: `Invalid JSON: ${(error as Error).message}` }],
    }
  }
  const issues = operation
    ? validator.validate(operation, parsed)
    : [{ path: '', message: 'Operation no longer exists in the spec' }]
  return { operationId, name, file: parsed as MockFile, issues }
}

async function writeMockFile(dir: string, operation: Operation, name: string, file: MockFile) {
  const documented = operation.responses.some((r) => r.status === file.status)
  const schemaFile = documented ? schemaFileName(operation.id, file.status) : UNDOCUMENTED_SCHEMA_FILE
  // Fixed key order keeps diffs readable; $schema gives editors autocomplete and validation.
  const ordered: MockFile = { $schema: `../../${SCHEMAS_DIR}/${schemaFile}`, status: file.status }
  if (file.delay) ordered.delay = file.delay
  if (file.headers && Object.keys(file.headers).length > 0) ordered.headers = file.headers
  if (file.body !== undefined) ordered.body = file.body
  await mkdir(join(dir, MOCKS_DIR, operation.id), { recursive: true })
  await writeJson(mockPath(dir, operation.id, name), ordered)
}

async function readConfig(dir: string): Promise<ProjectConfig> {
  const path = join(dir, CONFIG_FILE)
  if (!existsSync(path)) throw new Error(`No mockscope project at ${dirname(dir)} (missing ${MOCKSCOPE_DIR}/${CONFIG_FILE})`)
  const config = JSON.parse(await readFile(path, 'utf8')) as ProjectConfig
  if (typeof config.spec !== 'string') throw new Error(`${CONFIG_FILE} must have a "spec" path`)
  return config
}

async function readSpec(dir: string, config: ProjectConfig): Promise<Spec> {
  const specPath = resolve(dir, config.spec)
  let text: string
  try {
    text = await readFile(specPath, 'utf8')
  } catch {
    throw new Error(`Can't read the spec at ${specPath}`)
  }
  try {
    return parseSpec(JSON.parse(text))
  } catch (error) {
    throw new Error(`${specPath}: ${(error as Error).message}`)
  }
}

async function readState(dir: string): Promise<ProjectState> {
  try {
    const state = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8')) as Partial<ProjectState>
    return { active: state.active ?? {} }
  } catch {
    return { active: {} }
  }
}

function requireOperation(project: Project, operationId: string): Operation {
  const operation = project.spec.operations.find((op) => op.id === operationId)
  if (!operation) throw new Error(`Unknown operation "${operationId}"`)
  return operation
}

function requireMock(project: Project, operationId: string, name: string): Mock {
  const mock = project.operations.find((op) => op.id === operationId)?.mocks.find((m) => m.name === name)
  if (!mock) throw new Error(`No mock "${name}" for ${operationId}`)
  return mock
}

function requireValidName(name: string): string {
  const problem = validateMockName(name)
  if (problem) throw new Error(problem)
  return name.trim()
}

function mockPath(dir: string, operationId: string, name: string): string {
  return join(dir, MOCKS_DIR, operationId, `${name}.json`)
}

function schemaFileName(operationId: string, status: number): string {
  return `${operationId}.${status}.json`
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}

/** Numeric-aware ordering so `200` sorts before `404` and `page 2` before `page 10`. */
function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}
