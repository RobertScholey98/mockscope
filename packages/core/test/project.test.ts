import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeRoutes,
  duplicateMock,
  initProject,
  loadProject,
  parseSpec,
  renameMock,
  saveMock,
  setActiveMock,
  syncProject,
  type Project,
} from '../src/index.ts'

const TODO_SPEC = new URL('../../../examples/todo-dashboard/swagger.json', import.meta.url)

let root: string
let project: Project

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mockscope-'))
  await cp(TODO_SPEC, join(root, 'swagger.json'))
  project = await initProject(root, join(root, 'swagger.json'))
})

const readJson = async (...parts: string[]) => JSON.parse(await readFile(join(root, '.mockscope', ...parts), 'utf8'))
const operation = (p: Project, id: string) => p.operations.find((op) => op.id === id)!

describe('initProject', () => {
  it('generates one empty, schema-linked mock per documented response', async () => {
    expect(await readJson('mockscope.json')).toEqual({ spec: '../swagger.json' })
    expect(await readJson('mocks', 'getTodoList', '200.json')).toEqual({
      $schema: '../../schemas/getTodoList.200.json',
      status: 200,
      body: [],
    })
    expect(await readJson('mocks', 'getRecentAdditions', '200.json')).toEqual({
      $schema: '../../schemas/getRecentAdditions.200.json',
      status: 200,
      body: { since: '1970-01-01T00:00:00.000Z', items: [] },
    })
    expect((await readJson('mocks', 'createTodo', '201.json')).body).toEqual({
      id: 0,
      title: '',
      done: false,
      priority: 'low',
      assignee: '',
      createdAt: '1970-01-01T00:00:00.000Z',
    })
    expect(operation(project, 'updateTodo').mocks.map((m) => m.name)).toEqual(['200', '404'])
  })

  it('produces mocks that validate against their own schemas', () => {
    const issues = project.operations.flatMap((op) => op.mocks.flatMap((m) => m.issues))
    expect(issues).toEqual([])
  })

  it('writes standalone JSON Schemas with only the definitions they use', async () => {
    const schema = await readJson('schemas', 'getTodoList.200.json')
    expect(Object.keys(schema.definitions)).toEqual(['Todo'])
    expect(schema.properties.body).toEqual({ type: 'array', items: { $ref: '#/definitions/Todo' } })
    expect(schema.definitions.Todo.properties.assignee).toEqual({ type: ['string', 'null'] })
  })
})

describe('validation', () => {
  it('reports where a mock body breaks the spec', async () => {
    await saveMock(project, 'getTodoList', 'broken', {
      status: 200,
      body: [{ id: 'one', title: 'x', done: false, priority: 'urgent', createdAt: 'yesterday' }],
    })
    const mock = operation(await loadProject(root), 'getTodoList').mocks.find((m) => m.name === 'broken')!
    expect(mock.issues.map((i) => i.path).sort()).toEqual(['/body/0/createdAt', '/body/0/id', '/body/0/priority'])
  })

  it('accepts undocumented status codes but says so in the schema link', async () => {
    await saveMock(project, 'getTodoList', 'teapot', { status: 418, body: 'no' })
    expect((await readJson('mocks', 'getTodoList', 'teapot.json')).$schema).toBe('../../schemas/_undocumented.json')
    const mock = operation(await loadProject(root), 'getTodoList').mocks.find((m) => m.name === 'teapot')!
    expect(mock.issues).toEqual([])
  })

  it('flags files that are not valid JSON', async () => {
    await writeFile(join(root, '.mockscope', 'mocks', 'getTodoList', 'typo.json'), '{ "status": 200,, }')
    const mock = operation(await loadProject(root), 'getTodoList').mocks.find((m) => m.name === 'typo')!
    expect(mock.issues[0]!.message).toMatch(/^Invalid JSON/)
  })
})

describe('switching mocks on and off', () => {
  it('routes only switched-on mocks, matching path parameters', async () => {
    await duplicateMock(project, 'getTodoList', '200')
    project = await loadProject(root)
    await renameMock(project, 'getTodoList', '200 copy', 'empty')
    await setActiveMock(project, 'getTodoList', 'empty')
    await setActiveMock(project, 'updateTodo', '404')
    project = await loadProject(root)

    expect(operation(project, 'getTodoList').mocks.map((m) => m.name)).toEqual(['200', '500', 'empty'])
    const routes = activeRoutes(project)
    expect(routes.map((r) => [r.operationId, r.mockName, r.method, r.status])).toEqual([
      ['getTodoList', 'empty', 'get', 200],
      ['updateTodo', '404', 'patch', 404],
    ])
    const update = new RegExp(routes[1]!.pathPattern)
    expect(update.test('/api/update_todo/42')).toBe(true)
    expect(update.test('/api/update_todo/42/extra')).toBe(false)
    expect(update.test('/update_todo/42')).toBe(false)
  })

  it('carries the active flag through a rename', async () => {
    await setActiveMock(project, 'getTodoList', '200')
    await renameMock(project, 'getTodoList', '200', 'ok')
    expect(await readJson('state.json')).toEqual({ active: { getTodoList: 'ok' } })
  })

  it('treats an active mock that was deleted outside the app as live', async () => {
    await setActiveMock(project, 'getTodoList', 'gone')
    expect(operation(await loadProject(root), 'getTodoList').activeMock).toBeNull()
  })
})

describe('syncProject', () => {
  it('adds mocks for new operations, keeps edited ones, and orphans removed ones', async () => {
    await saveMock(project, 'getTodoList', '200', { status: 200, body: [], delay: 500 })
    const spec = JSON.parse(await readFile(join(root, 'swagger.json'), 'utf8'))
    delete spec.paths['/recent_additions']
    spec.paths['/stats'] = {
      get: { operationId: 'getStats', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { open: { type: 'integer' } } } } } } } },
    }
    await writeFile(join(root, 'swagger.json'), JSON.stringify(spec))

    const result = await syncProject(root)
    expect(result.createdMocks).toEqual(['getStats/200'])
    expect(result.removedSchemas).toEqual(['getRecentAdditions.200.json'])

    project = await loadProject(root)
    expect((await readJson('mocks', 'getTodoList', '200.json')).delay).toBe(500)
    expect(operation(project, 'getStats').mocks[0]!.file.body).toEqual({ open: 0 })
    expect(project.orphans.map((m) => `${m.operationId}/${m.name}`)).toEqual(['getRecentAdditions/200'])
  })
})

describe('parseSpec', () => {
  it('reads Swagger 2.0, deriving ids and honouring basePath and x-nullable', () => {
    const spec = parseSpec({
      swagger: '2.0',
      info: { title: 'Legacy', version: '2' },
      basePath: '/v1/',
      paths: {
        '/users/{userId}': {
          get: {
            responses: {
              200: { description: 'ok', schema: { $ref: '#/definitions/User' } },
              default: { description: 'error' },
            },
          },
        },
      },
      definitions: {
        User: {
          type: 'object',
          properties: { nickname: { type: 'string', 'x-nullable': true }, example: { type: 'string' } },
        },
      },
    })
    expect(spec.basePath).toBe('/v1')
    expect(spec.operations).toHaveLength(1)
    expect(spec.operations[0]).toMatchObject({ id: 'get_users_userId', method: 'get', path: '/users/{userId}' })
    expect(spec.operations[0]!.responses).toEqual([
      { status: 200, description: 'ok', schema: { $ref: '#/definitions/User' } },
    ])
    // A property that happens to be called "example" is a property, not the OpenAPI keyword.
    expect(spec.definitions.User!.properties).toEqual({
      nickname: { type: ['string', 'null'] },
      example: { type: 'string' },
    })
  })
})
