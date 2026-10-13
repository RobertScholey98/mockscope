import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { msw } from 'msw/vite'
import { normalizePath, type Plugin, type ViteDevServer } from 'vite'
import { activeRoutes, loadProject, resolveMockscopeDir, type ActiveRoute } from '@mockscope/core'
import type { ClientOptions } from './client.ts'

export interface MockscopeOptions {
  /** Directory containing `.mockscope/`. Defaults to Vite's root. */
  root?: string
  /**
   * Start MSW with mockscope's handler. Set to `false` if your app already starts MSW, and put
   * `mockscopeHandler` from `virtual:mockscope` first in your own handlers instead.
   * @default true
   */
  autoStart?: boolean
  /** Reload the page when you switch mocks, so the screen refetches. @default true */
  reloadOnChange?: boolean
  /** Also register MSW's own Vite plugin (serves the worker script). Turn off if you already use `msw()`. @default true */
  includeMsw?: boolean
}

const VIRTUAL_ID = 'virtual:mockscope'
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`
const ROUTES_URL = '/__mockscope/routes'
const CLIENT_PATH = normalizePath(fileURLToPath(new URL('./client.ts', import.meta.url)))

/**
 * Serves switched-on `.mockscope` mocks through MSW during `vite dev`.
 * Has no effect on `vite build`.
 */
export function mockscope(options: MockscopeOptions = {}): Plugin[] {
  const clientOptions: Omit<ClientOptions, 'routesUrl'> = {
    autoStart: options.autoStart ?? true,
    reloadOnChange: options.reloadOnChange ?? true,
  }
  let routes: ActiveRoute[] = []
  let root = ''
  const entryModules = new Set<string>()

  const plugin: Plugin = {
    name: 'mockscope',
    apply: 'serve',

    config() {
      // Prebundle up front so discovering them on first load doesn't trigger an extra reload.
      return { optimizeDeps: { include: ['msw', 'msw/browser', 'msw/experimental'] } }
    },

    configResolved(config) {
      root = config.root
    },

    async configureServer(server) {
      const dir = resolveMockscopeDir(options.root ? resolve(root, options.root) : root)
      routes = await readRoutes(dir, server)

      server.middlewares.use(ROUTES_URL, (_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(JSON.stringify(routes))
      })

      // Electron (or a text editor, or git) writes the files; we just watch them.
      let specPath: string | undefined
      try {
        const project = await loadProject(dir)
        specPath = normalizePath(resolve(project.dir, project.config.spec))
      } catch {}
      server.watcher.add([dir, ...(specPath ? [specPath] : [])])

      let timer: ReturnType<typeof setTimeout> | undefined
      const watchedDir = normalizePath(dir)
      server.watcher.on('all', (_event, file) => {
        const path = normalizePath(file)
        if (!path.startsWith(`${watchedDir}/`) && path !== specPath) return
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const next = await readRoutes(dir, server)
          if (JSON.stringify(next) === JSON.stringify(routes)) return
          routes = next
          server.config.logger.info(`[mockscope] ${describe(routes)}`, { timestamp: true })
          server.ws.send({ type: 'custom', event: 'mockscope:routes', data: routes })
        }, 75)
      })

      server.config.logger.info(`[mockscope] watching ${dir}: ${describe(routes)}`)
    },

    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_VIRTUAL_ID
    },

    load(id) {
      if (id !== RESOLVED_VIRTUAL_ID) return
      const config: ClientOptions = { ...clientOptions, routesUrl: ROUTES_URL }
      return [
        `import { startMockscope } from ${JSON.stringify(CLIENT_PATH)}`,
        `export { mockscopeHandler } from ${JSON.stringify(CLIENT_PATH)}`,
        `await startMockscope(${JSON.stringify(config)})`,
      ].join('\n')
    },

    transformIndexHtml(html) {
      for (const [, src] of html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)) {
        if (src && src.startsWith('/') && !src.startsWith('/@')) entryModules.add(normalizePath(join(root, src)))
      }
    },

    transform(code, id) {
      // A static import of a module with top-level await makes the entry wait for it, so MSW
      // is running before your app's first request.
      if (entryModules.has(id.split('?')[0]!)) return { code: `import '${VIRTUAL_ID}';\n${code}`, map: null }
    },
  }

  return options.includeMsw === false ? [plugin] : [msw(), plugin]
}

async function readRoutes(dir: string, server: ViteDevServer): Promise<ActiveRoute[]> {
  try {
    return activeRoutes(await loadProject(dir))
  } catch (error) {
    server.config.logger.warn(`[mockscope] ${(error as Error).message}`)
    return []
  }
}

function describe(routes: ActiveRoute[]): string {
  if (routes.length === 0) return 'no mocks switched on'
  return `${routes.length} switched on (${routes.map((r) => `${r.operationId}/${r.mockName}`).join(', ')})`
}
