import type { JsonSchema, Operation, OperationResponse, Spec } from './types.ts'

// Keywords whose values are data, not subschemas. Their contents must be copied verbatim.
const DATA_KEYWORDS = new Set(['default', 'enum', 'const', 'example', 'examples'])
// OpenAPI-only keywords that mean nothing (or something different) to a JSON Schema validator.
const DROPPED_KEYWORDS = new Set(['nullable', 'x-nullable', 'discriminator', 'xml', 'externalDocs', 'example'])
// Keywords whose values map arbitrary names (which may collide with keywords) to subschemas.
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'definitions', '$defs'])

/**
 * Converts an OpenAPI 2.0/3.x schema object to JSON Schema draft-07:
 * rewrites `$ref`s to `#/definitions/<name>` and turns `nullable` into a `null` type.
 */
export function toJsonSchema(schema: unknown, refPrefix: string): JsonSchema {
  return isObject(schema) ? convert(schema, refPrefix) : {}
}

function convert(node: JsonSchema, refPrefix: string): JsonSchema {
  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(node)) {
    if (DROPPED_KEYWORDS.has(key)) continue
    if (key === '$ref' && typeof value === 'string') {
      out.$ref = value.startsWith(refPrefix) ? `#/definitions/${value.slice(refPrefix.length)}` : value
    } else if (DATA_KEYWORDS.has(key)) {
      out[key] = value
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, convertValue(sub, refPrefix)]))
    } else if (key === 'type' && value === 'file') {
      // Swagger 2.0 file responses: anything goes.
    } else {
      out[key] = convertValue(value, refPrefix)
    }
  }

  if (node.nullable === true || node['x-nullable'] === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null']
    else if (Array.isArray(out.type) && !out.type.includes('null')) out.type = [...out.type, 'null']
    else if (out.type === undefined) return { anyOf: [out, { type: 'null' }] }
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null]
  }
  return out
}

export function isObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function convertValue(value: unknown, refPrefix: string): unknown {
  if (Array.isArray(value)) return value.map((item) => convertValue(item, refPrefix))
  if (typeof value === 'object' && value !== null) return convert(value as JsonSchema, refPrefix)
  return value
}

/** Names of every definition reachable from `schema`, following refs transitively. */
export function reachableDefinitions(schema: unknown, definitions: Record<string, JsonSchema>): string[] {
  const found = new Set<string>()
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node !== 'object' || node === null) return
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/definitions/')) {
        const name = value.slice('#/definitions/'.length)
        if (!found.has(name) && definitions[name]) {
          found.add(name)
          visit(definitions[name])
        }
      } else if (SCHEMA_MAP_KEYWORDS.has(key) && isObject(value)) {
        Object.values(value).forEach(visit)
      } else if (!DATA_KEYWORDS.has(key)) {
        visit(value)
      }
    }
  }
  visit(schema)
  return [...found].sort()
}

/** JSON Schema for a whole mock file answering `operation` with `response`. */
export function mockFileSchema(operation: Operation, response: OperationResponse, spec: Spec): JsonSchema {
  const definitions = Object.fromEntries(
    reachableDefinitions(response.schema, spec.definitions).map((name) => [name, spec.definitions[name]]),
  )
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: `${operation.method.toUpperCase()} ${operation.path} → ${response.status}`,
    description: response.description ?? operation.summary,
    type: 'object',
    additionalProperties: false,
    required: response.schema ? ['status', 'body'] : ['status'],
    properties: {
      $schema: { type: 'string' },
      status: { const: response.status },
      delay: { type: 'integer', minimum: 0, description: 'Milliseconds to wait before responding.' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: response.schema ?? {},
    },
    ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
  }
}

/** Schema for a mock whose status code isn't documented in the spec. Checks the envelope only. */
export const UNDOCUMENTED_STATUS_SCHEMA: JsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Response with a status code the spec does not document',
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    $schema: { type: 'string' },
    status: { type: 'integer', minimum: 100, maximum: 599 },
    delay: { type: 'integer', minimum: 0 },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    body: {},
  },
}
