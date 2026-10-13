// Stands in for a real backend so the example runs on its own. Requests mockscope doesn't
// intercept end up here.
import type { Plugin } from 'vite'

interface Todo {
  id: number
  title: string
  done: boolean
  priority: 'low' | 'normal' | 'high'
  assignee: string | null
  createdAt: string
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

const todos: Todo[] = [
  { id: 1, title: 'Wire up the revenue chart', done: true, priority: 'high', assignee: 'Sam', createdAt: daysAgo(12) },
  { id: 2, title: 'Fix timezone on the activity feed', done: false, priority: 'normal', assignee: null, createdAt: daysAgo(9) },
  { id: 3, title: 'Empty state for new accounts', done: false, priority: 'normal', assignee: 'Priya', createdAt: daysAgo(3) },
  { id: 4, title: 'Export CSV from the orders table', done: false, priority: 'low', assignee: null, createdAt: daysAgo(1) },
]

export function liveApi(): Plugin {
  return {
    name: 'live-api',
    configureServer(server) {
      server.middlewares.use('/api', async (request, response) => {
        const send = (status: number, body: unknown) => {
          response.statusCode = status
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(body))
        }
        const readBody = async () => {
          let raw = ''
          for await (const chunk of request) raw += chunk
          return raw ? JSON.parse(raw) : {}
        }
        const url = request.url ?? '/'

        if (request.method === 'GET' && url === '/todo_list') return send(200, todos)
        if (request.method === 'GET' && url === '/recent_additions') {
          const since = daysAgo(7)
          return send(200, { since, items: todos.filter((t) => t.createdAt >= since) })
        }
        if (request.method === 'POST' && url === '/new_todo') {
          const { title, priority = 'normal' } = await readBody()
          if (!title) return send(400, { message: 'Title is required', code: 'validation' })
          const todo: Todo = { id: Math.max(0, ...todos.map((t) => t.id)) + 1, title, done: false, priority, assignee: null, createdAt: new Date().toISOString() }
          todos.push(todo)
          return send(201, todo)
        }
        const update = /^\/update_todo\/(\d+)$/.exec(url)
        if (request.method === 'PATCH' && update) {
          const todo = todos.find((t) => t.id === Number(update[1]))
          if (!todo) return send(404, { message: 'No such todo', code: 'not_found' })
          Object.assign(todo, await readBody())
          return send(200, todo)
        }
        send(404, { message: `No route for ${request.method} /api${url}` })
      })
    },
  }
}
