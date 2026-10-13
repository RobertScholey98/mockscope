import { isObject } from './schema.ts'
import type { JsonSchema } from './types.ts'

const STRING_FORMATS: Record<string, string> = {
  'date-time': '1970-01-01T00:00:00.000Z',
  date: '1970-01-01',
  time: '00:00:00',
  uuid: '00000000-0000-0000-0000-000000000000',
  email: 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '0.0.0.0',
}

/**
 * The emptiest value that still satisfies `schema`: `[]` for arrays, `""`/`0`/`false` for scalars,
 * objects with every property filled in so the shape is visible when you open the mock.
 */
export function emptyValue(schema: unknown, definitions: Record<string, JsonSchema>): unknown {
  return sample(schema, definitions, new Set())
}

function sample(schema: unknown, definitions: Record<string, JsonSchema>, resolving: Set<string>): unknown {
  if (!isObject(schema)) return null

  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/definitions/', '')
    // A model that contains itself (e.g. a tree node) stops at the first repeat.
    if (resolving.has(name) || !definitions[name]) return null
    return sample(definitions[name], definitions, new Set([...resolving, name]))
  }
  if ('const' in schema) return schema.const
  if ('default' in schema) return schema.default
  if (Array.isArray(schema.enum)) return schema.enum[0] ?? null
  if (Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map((part) => sample(part, definitions, resolving)).filter(isObject))
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    const options = schema[key]
    if (Array.isArray(options)) {
      const first = options.find((option) => !(isObject(option) && option.type === 'null')) ?? options[0]
      return sample(first, definitions, resolving)
    }
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const type = types.find((t) => t !== 'null') ?? (schema.properties ? 'object' : types[0])

  switch (type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(isObject(schema.properties) ? schema.properties : {}).map(([key, sub]) => [
          key,
          sample(sub, definitions, resolving),
        ]),
      )
    case 'array':
      return []
    case 'string': {
      const format = typeof schema.format === 'string' ? STRING_FORMATS[schema.format] : undefined
      if (format) return format
      return typeof schema.minLength === 'number' ? 'x'.repeat(schema.minLength) : ''
    }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0
    case 'boolean':
      return false
    default:
      return null
  }
}
