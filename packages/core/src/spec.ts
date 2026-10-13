import { isObject, toJsonSchema } from './schema.ts'
import { HTTP_METHODS, type JsonSchema, type Operation, type OperationResponse, type Spec } from './types.ts'

/** Parses a Swagger 2.0 or OpenAPI 3.x document (as JSON) into the operations mockscope cares about. */
export function parseSpec(doc: unknown): Spec {
  if (!isObject(doc)) throw new Error('Spec is not a JSON object')
  const isSwagger2 = typeof doc.swagger === 'string' && doc.swagger.startsWith('2')
  if (!isSwagger2 && !(typeof doc.openapi === 'string' && doc.openapi.startsWith('3'))) {
    throw new Error('Spec must be Swagger 2.0 or OpenAPI 3.x (missing "swagger" or "openapi" version field)')
  }

  const refPrefix = isSwagger2 ? '#/definitions/' : '#/components/schemas/'
  const rawDefinitions = isSwagger2 ? doc.definitions : (doc.components as JsonSchema | undefined)?.schemas
  const definitions = Object.fromEntries(
    Object.entries(isObject(rawDefinitions) ? rawDefinitions : {}).map(([name, schema]) => [
      name,
      toJsonSchema(schema, refPrefix),
    ]),
  )

  const info = isObject(doc.info) ? doc.info : {}
  const usedIds = new Set<string>()
  const operations: Operation[] = []

  for (const [path, pathItem] of Object.entries(isObject(doc.paths) ? doc.paths : {})) {
    if (!isObject(pathItem)) continue
    for (const method of HTTP_METHODS) {
      const op = pathItem[method]
      if (!isObject(op)) continue

      const responses: OperationResponse[] = []
      for (const [code, response] of Object.entries(isObject(op.responses) ? op.responses : {})) {
        const status = parseStatus(code)
        if (status === undefined || !isObject(response)) continue
        const rawSchema = isSwagger2 ? response.schema : pickJsonContent(response.content)
        responses.push({
          status,
          description: typeof response.description === 'string' ? response.description : undefined,
          schema: rawSchema === undefined ? undefined : toJsonSchema(rawSchema, refPrefix),
        })
      }
      responses.sort((a, b) => a.status - b.status)

      operations.push({
        id: uniqueId(typeof op.operationId === 'string' ? op.operationId : `${method}${path}`, usedIds),
        method,
        path,
        summary: typeof op.summary === 'string' ? op.summary : undefined,
        tags: Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        responses,
      })
    }
  }

  return {
    title: typeof info.title === 'string' ? info.title : 'Untitled API',
    version: typeof info.version === 'string' ? info.version : '',
    basePath: normalizeBasePath(isSwagger2 ? doc.basePath : firstServerPath(doc.servers)),
    operations,
    definitions,
  }
}

/** `"200"` → 200, `"2XX"` → 200, `"default"` → undefined (there's no status to mock). */
function parseStatus(code: string): number | undefined {
  const match = /^([1-5])(\d\d|XX)$/i.exec(code)
  if (!match) return undefined
  return Number(match[1]) * 100 + (match[2]!.toUpperCase() === 'XX' ? 0 : Number(match[2]))
}

function pickJsonContent(content: unknown): unknown {
  if (!isObject(content)) return undefined
  const types = Object.keys(content)
  const type = types.find((t) => t === 'application/json') ?? types.find((t) => t.includes('json')) ?? types[0]
  const media = type === undefined ? undefined : content[type]
  return isObject(media) ? media.schema : undefined
}

function firstServerPath(servers: unknown): unknown {
  const url = Array.isArray(servers) && isObject(servers[0]) ? servers[0].url : undefined
  if (typeof url !== 'string' || url.includes('{')) return ''
  return new URL(url, 'http://placeholder').pathname
}

export function normalizeBasePath(basePath: unknown): string {
  if (typeof basePath !== 'string') return ''
  const trimmed = basePath.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function uniqueId(raw: string, used: Set<string>): string {
  const base = raw.replace(/[{}]/g, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'operation'
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`
  used.add(id)
  return id
}

/** Regex source matching request pathnames for `operation`, e.g. `^/api/update_todo/[^/]+$`. */
export function pathPattern(basePath: string, path: string): string {
  const full = `${basePath}${path.startsWith('/') ? path : `/${path}`}`
  const source = full
    .split(/(\{[^}]+\})/)
    .map((part) => (part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return `^${source}/?$`
}
