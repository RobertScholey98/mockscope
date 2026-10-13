#!/usr/bin/env node
// Minimal command line for scripting and CI. The desktop app does everything this does.
import { resolve } from 'node:path'
import { activeRoutes, initProject, loadProject, setActiveMock, syncProject } from './index.ts'

const USAGE = `usage:
  mockscope init <spec.json> [projectDir]   create .mockscope/ and generate empty mocks
  mockscope sync [projectDir]               regenerate schemas, add mocks for new operations
  mockscope check [projectDir]              list mocks that don't match the spec (exit 1 if any)
  mockscope on <operationId> <mock> [projectDir]
  mockscope off <operationId> [projectDir]
  mockscope status [projectDir]`

const [command, ...args] = process.argv.slice(2)

try {
  switch (command) {
    case 'init': {
      const [spec, dir = '.'] = args
      if (!spec) throw new Error(USAGE)
      const project = await initProject(resolve(dir), resolve(spec))
      const count = project.operations.reduce((n, op) => n + op.mocks.length, 0)
      console.log(`Created ${project.dir} with ${count} mocks for ${project.operations.length} operations`)
      break
    }
    case 'sync': {
      const result = await syncProject(resolve(args[0] ?? '.'))
      console.log(`New mocks: ${result.createdMocks.join(', ') || 'none'}`)
      console.log(`Removed schemas: ${result.removedSchemas.join(', ') || 'none'}`)
      break
    }
    case 'check': {
      const project = await loadProject(resolve(args[0] ?? '.'))
      const bad = [...project.operations.flatMap((op) => op.mocks), ...project.orphans].filter((m) => m.issues.length > 0)
      for (const mock of bad) {
        for (const issue of mock.issues) console.log(`${mock.operationId}/${mock.name}${issue.path ? ` ${issue.path}` : ''}: ${issue.message}`)
      }
      console.log(bad.length === 0 ? 'All mocks match the spec' : `${bad.length} mock(s) don't match the spec`)
      process.exitCode = bad.length === 0 ? 0 : 1
      break
    }
    case 'on':
    case 'off': {
      const [operationId, ...rest] = args
      const mock = command === 'on' ? rest.shift() : null
      if (!operationId || mock === undefined) throw new Error(USAGE)
      await setActiveMock(await loadProject(resolve(rest[0] ?? '.')), operationId, mock)
      console.log(mock ? `${operationId} → ${mock}` : `${operationId} → live`)
      break
    }
    case 'status': {
      const routes = activeRoutes(await loadProject(resolve(args[0] ?? '.')))
      if (routes.length === 0) console.log('No mocks switched on')
      for (const r of routes) console.log(`${r.method.toUpperCase().padEnd(6)} ${r.operationId} → ${r.mockName} (${r.status})`)
      break
    }
    default:
      console.log(USAGE)
      process.exitCode = command ? 1 : 0
  }
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
}
