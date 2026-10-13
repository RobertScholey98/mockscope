/// <reference types="vite/client" />
/// <reference types="msw/vite/client" />
// Runs in the browser. Loaded through `virtual:mockscope`, which the plugin injects into your app's entry module.
import { delay, http, HttpResponse } from 'msw'
import type { ActiveRoute } from '@mockscope/core'

interface CompiledRoute extends ActiveRoute {
  regex: RegExp
}

export interface ClientOptions {
  /** Start MSW ourselves. Turn off when the app already runs MSW and adds `mockscopeHandler` itself. */
  autoStart: boolean
  /** Reload the page when the switched-on mocks change, so screens refetch. */
  reloadOnChange: boolean
  routesUrl: string
}

let routes: CompiledRoute[] = []

function setRoutes(next: ActiveRoute[]) {
  routes = next.map((route) => ({ ...route, regex: new RegExp(route.pathPattern) }))
}

/**
 * One catch-all handler that answers from whichever mocks are switched on right now.
 * Requests that match nothing fall through to the next handler, or to the real network.
 */
export const mockscopeHandler = http.all('*', async ({ request }) => {
  const method = request.method.toLowerCase()
  const { pathname } = new URL(request.url)
  const route = routes.find((r) => r.method === method && r.regex.test(pathname))
  if (!route) return

  if (route.delay > 0) await delay(route.delay)
  const headers = { 'x-mockscope': `${route.operationId}/${route.mockName}`, ...route.headers }
  return route.body === undefined
    ? new HttpResponse(null, { status: route.status, headers })
    : HttpResponse.json(route.body, { status: route.status, headers })
})

export async function startMockscope(options: ClientOptions): Promise<void> {
  // Fetched before MSW starts, so this request is never intercepted.
  setRoutes(await (await fetch(options.routesUrl)).json())
  describe(routes)

  import.meta.hot?.on('mockscope:routes', (next: ActiveRoute[]) => {
    if (options.reloadOnChange) {
      location.reload()
      return
    }
    setRoutes(next)
    describe(routes)
  })

  if (options.autoStart) {
    const { network } = await import('virtual:msw')
    network.configure({ handlers: [mockscopeHandler], onUnhandledFrame: 'bypass' })
    await network.enable()
  }
}

function describe(active: CompiledRoute[]) {
  if (active.length === 0) {
    console.info('[mockscope] no mocks switched on; every request goes to the real API')
    return
  }
  console.groupCollapsed(`[mockscope] ${active.length} mock${active.length === 1 ? '' : 's'} switched on`)
  for (const route of active) {
    console.info(`${route.method.toUpperCase()} ${route.pathPattern} → ${route.operationId}/${route.mockName} (${route.status})`)
  }
  console.groupEnd()
}
