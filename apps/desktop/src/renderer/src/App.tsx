// Deliberately bare: proves the open → init → toggle loop end to end.
// The real interface (T3 Code-style shell, mock editor) is tracked in the issue backlog.
import { useEffect, useState } from 'react'
import type { OpenResult, Project } from '@shared/api.ts'

export function App() {
  const [screen, setScreen] = useState<OpenResult | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.mockscope.recentProjects().then(setRecent)
    return window.mockscope.onProjectChanged((project) =>
      setScreen((s) => (s?.kind === 'opened' ? { ...s, project } : s)),
    )
  }, [])

  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    try {
      setError(null)
      return await action()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const show = (result: OpenResult | null | undefined) => {
    if (result) setScreen(result)
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {screen?.kind === 'opened' ? (
        <ProjectView
          root={screen.root}
          project={screen.project}
          onClose={() => run(() => window.mockscope.closeProject()).then(() => setScreen(null))}
          run={run}
        />
      ) : screen?.kind === 'needs-init' ? (
        <section>
          <h1>Set up mockscope in {screen.root}</h1>
          <p>Choose the OpenAPI / Swagger JSON to generate mocks from:</p>
          <ul>
            {screen.specCandidates.map((spec) => (
              <li key={spec}>
                <button onClick={() => run(() => window.mockscope.initProject(screen.root, spec)).then(show)}>{spec}</button>
              </li>
            ))}
          </ul>
          <button
            onClick={async () => {
              const spec = await window.mockscope.pickSpec(screen.root)
              if (spec) show(await run(() => window.mockscope.initProject(screen.root, spec)))
            }}
          >
            Choose file…
          </button>{' '}
          <button onClick={() => setScreen(null)}>Cancel</button>
        </section>
      ) : (
        <section>
          <h1>mockscope</h1>
          {screen?.kind === 'error' && <p style={{ color: 'crimson' }}>{screen.message}</p>}
          <button onClick={() => run(() => window.mockscope.pickProject()).then(show)}>Open project folder…</button>
          <h2>Recent</h2>
          <ul>
            {recent.map((root) => (
              <li key={root}>
                <button onClick={() => run(() => window.mockscope.openProject(root)).then(show)}>{root}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}

function ProjectView(props: {
  root: string
  project: Project
  onClose: () => void
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>
}) {
  const { project, run } = props
  return (
    <section>
      <h1>
        {project.spec.title} <small>{props.root}</small>
      </h1>
      <button onClick={props.onClose}>Close</button>{' '}
      <button onClick={() => run(() => window.mockscope.sync())}>Sync spec</button>{' '}
      <button onClick={() => run(() => window.mockscope.deactivateAll())}>All live</button>
      {project.operations.map((op) => (
        <div key={op.id} style={{ marginTop: 12 }}>
          <strong>
            {op.method.toUpperCase()} {op.path}
          </strong>{' '}
          <span>{op.activeMock ? `mocked: ${op.activeMock}` : 'live'}</span>
          {op.mocks.map((mock) => (
            <label key={mock.name} style={{ display: 'block', marginLeft: 16 }}>
              <input
                type="checkbox"
                checked={op.activeMock === mock.name}
                onChange={(e) => run(() => window.mockscope.setActive(op.id, e.target.checked ? mock.name : null))}
              />{' '}
              {mock.name} ({mock.file.status}){mock.issues.length > 0 && ` ⚠ ${mock.issues.length} issue(s)`}
            </label>
          ))}
        </div>
      ))}
    </section>
  )
}
