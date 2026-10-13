# mockscope

Switch individual API endpoints between your real backend and named, spec-checked mock responses while you build a Vite app.

Mocks live in your project as plain JSON in a `.mockscope/` folder, generated from your OpenAPI / Swagger spec. A desktop app lets you tick `/todo_list (empty)` on, and the next request your app makes to that endpoint gets the mock. Every other endpoint keeps hitting the real API.

> Status: early prototype. The core, the Vite plugin and the CLI work; the desktop app is a bare shell. See the [project board](https://github.com/users/RobertScholey98/projects/4).

## How it fits together

```
your-app/
  swagger.json
  vite.config.ts            ← plugins: [mockscope()]
  .mockscope/
    mockscope.json          ← { "spec": "../swagger.json" }
    schemas/                ← generated JSON Schema per operation + status
    mocks/<operationId>/<name>.json
    state.json              ← which mock is switched on per operation (gitignored)
```

- **`@mockscope/core`** parses Swagger 2.0 / OpenAPI 3.x, generates empty but schema-valid mocks, validates mocks against the spec, and reads/writes the `.mockscope` folder. It includes a small `mockscope` CLI.
- **`@mockscope/vite`** watches `.mockscope/` and serves switched-on mocks through [MSW 3](https://mswjs.io) in the browser. It injects itself into your entry module, so MSW is running before your first request, and reloads the page when you switch mocks.
- **`apps/desktop`** is the Electron app. It edits the same files.

Because files are the interface, the desktop app, your editor, the CLI and git all work on the same state. Each mock file has a `$schema` link, so VS Code autocompletes and validates mock bodies against your spec.

## Mock files

```json
{
  "$schema": "../../schemas/getTodoList.200.json",
  "status": 200,
  "delay": 3000,
  "headers": { "x-total-count": "0" },
  "body": []
}
```

Mocked responses carry an `x-mockscope: <operationId>/<name>` header so you can spot them in the network tab.

## Try it

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm dev:example          # the todo dashboard on http://localhost:5173
pnpm dev:desktop          # the desktop app; open examples/todo-dashboard
```

Or switch mocks from the command line:

```sh
cd examples/todo-dashboard
node ../../packages/core/src/cli.ts status
node ../../packages/core/src/cli.ts on getTodoList "three items"
node ../../packages/core/src/cli.ts off getTodoList
node ../../packages/core/src/cli.ts check     # exit 1 if any mock no longer matches the spec
```

## Using it in your own app

```ts
// vite.config.ts
import { mockscope } from '@mockscope/vite'

export default defineConfig({ plugins: [react(), mockscope()] })
```

Then run `mockscope init path/to/swagger.json` in the project root, or open the folder in the desktop app.

If your app already starts MSW itself, use `mockscope({ autoStart: false, includeMsw: false })` and put the mockscope handler first in your own handlers:

```ts
import { mockscopeHandler } from 'virtual:mockscope'
network.configure({ handlers: [mockscopeHandler, ...handlers] })
```

## Development

```sh
pnpm test        # core unit tests
pnpm typecheck
```
