import { useCallback, useEffect, useState, type FormEvent } from 'react'

interface Todo {
  id: number
  title: string
  done: boolean
  priority: 'low' | 'normal' | 'high'
  assignee: string | null
  createdAt: string
}

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T }

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.message ?? `${response.status} ${response.statusText}`)
  return body as T
}

function useApi<T>(path: string) {
  const [result, setResult] = useState<Load<T>>({ state: 'loading' })
  const reload = useCallback(() => {
    setResult({ state: 'loading' })
    api<T>(path).then(
      (data) => setResult({ state: 'ready', data }),
      (error: Error) => setResult({ state: 'error', message: error.message }),
    )
  }, [path])
  useEffect(reload, [reload])
  return [result, reload] as const
}

export function App() {
  const [todos, reloadTodos] = useApi<Todo[]>('/todo_list')
  const [recent, reloadRecent] = useApi<{ since: string; items: Todo[] }>('/recent_additions')
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = () => {
    reloadTodos()
    reloadRecent()
  }

  const toggle = async (todo: Todo) => {
    try {
      await api(`/update_todo/${todo.id}`, { method: 'PATCH', body: JSON.stringify({ done: !todo.done }) })
      setNotice(null)
      refresh()
    } catch (error) {
      setNotice(`Couldn't update "${todo.title}": ${(error as Error).message}`)
    }
  }

  return (
    <main>
      <header>
        <h1>Todos</h1>
        <button onClick={refresh}>Refresh</button>
      </header>
      {notice && <p className="notice">{notice}</p>}
      <div className="grid">
        <section>
          <h2>All todos</h2>
          <Loaded result={todos} empty={(list) => list.length === 0} emptyText="Nothing to do. Add a todo to get started.">
            {(list) => (
              <ul>
                {list.map((todo) => (
                  <TodoRow key={todo.id} todo={todo} onToggle={() => toggle(todo)} />
                ))}
              </ul>
            )}
          </Loaded>
          <NewTodo onCreated={refresh} />
        </section>
        <section>
          <h2>Added this week</h2>
          <Loaded result={recent} empty={(r) => r.items.length === 0} emptyText="No new todos this week.">
            {(r) => (
              <>
                <p className="muted">Since {new Date(r.since).toLocaleDateString()}</p>
                <ul>
                  {r.items.map((todo) => (
                    <TodoRow key={todo.id} todo={todo} />
                  ))}
                </ul>
              </>
            )}
          </Loaded>
        </section>
      </div>
    </main>
  )
}

function Loaded<T>(props: {
  result: Load<T>
  empty: (data: T) => boolean
  emptyText: string
  children: (data: T) => React.ReactNode
}) {
  const { result } = props
  if (result.state === 'loading') return <p className="muted">Loading…</p>
  if (result.state === 'error') return <p className="error">Failed to load: {result.message}</p>
  if (props.empty(result.data)) return <p className="empty">{props.emptyText}</p>
  return <>{props.children(result.data)}</>
}

function TodoRow({ todo, onToggle }: { todo: Todo; onToggle?: () => void }) {
  return (
    <li className={todo.done ? 'done' : ''}>
      {onToggle && <input type="checkbox" checked={todo.done} onChange={onToggle} aria-label={`Mark ${todo.title} done`} />}
      <span className="title">{todo.title || <em>(untitled)</em>}</span>
      <span className={`priority ${todo.priority}`}>{todo.priority}</span>
      {todo.assignee && <span className="assignee">{todo.assignee}</span>}
    </li>
  )
}

function NewTodo({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await api('/new_todo', { method: 'POST', body: JSON.stringify({ title }) })
      setTitle('')
      setError(null)
      onCreated()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <form onSubmit={submit}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New todo" />
      <button type="submit">Add</button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
