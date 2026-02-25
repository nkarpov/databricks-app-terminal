# Databricks App Terminal

Databricks App Terminal is a multi-session web terminal for Databricks Apps.

When running inside a Databricks App, terminal commands execute under the app's service principal identity. Databricks CLI is available in the runtime and works with app M2M auth out of the box.

## What this project provides

- Browser terminal UI with tabs (`xterm.js`)
- In-memory PTY sessions (`node-pty`, no tmux dependency)
- Session lifecycle APIs (list/create/attach/input/resize/kill)
- WebSocket terminal streaming
- Health/readiness/runtime diagnostics endpoints
- Structured API errors and structured logs
- Runtime-safe `npm install -g` behavior (redirected to writable app paths)

## UI behavior

- One session is created automatically if none exist.
- Tabs are always visible.
- `+` creates a new tab/session.
- `Cmd+T` (macOS) / `Ctrl+T` (Windows/Linux) creates a new tab/session.
- Tab titles follow terminal title escape sequences from the running shell/app.

## Databricks identity model

Inside Databricks Apps:

- commands run as the app service principal
- Databricks CLI is preinstalled in the runtime
- CLI authentication uses app M2M context

This makes the terminal immediately usable for Databricks operations without manual auth bootstrapping.

## Deploy

`app.yaml` and `databricks.yml` are included.

```bash
npm run build
databricks apps deploy --profile <PROFILE>
```

Example:

```bash
databricks apps deploy --profile SHARED
```

## API surface

### Runtime
- `GET /health`
- `GET /ready`
- `GET /api/runtime/diagnostics`

### Sessions
- `GET /api/sessions`
- `POST /api/sessions`
- `POST /api/sessions/:sessionId/attach`
- `POST /api/sessions/:sessionId/input`
- `POST /api/sessions/:sessionId/resize`
- `DELETE /api/sessions/:sessionId`

### WebSocket
- `GET /ws/terminal?sessionId=<uuidv7>&cols=<n>&rows=<n>`

## Configuration

Core runtime env vars:

- `APP_NAME` (default `databricks-app-terminal`)
- `HOST` (default `0.0.0.0`)
- `PORT` (default `8080`)
- `SHELL` (default `/bin/bash`)
- `WEB_ROOT` (default `./public`)
- `STRICT_RUNTIME_CHECKS` (default `true`)
- `LOG_LEVEL` (`debug|info|warn|error`, default `info`)
- `LOG_PATH` (default `./logs/databricks-app-terminal.jsonl`)

Session defaults:

- `SESSION_DEFAULT_CWD` (default `/app/python` on Databricks, else current directory)

Writable tool paths (for global npm installs in sessions):

- `DBX_APP_TERMINAL_RUNTIME_ROOT`
- `DBX_APP_TERMINAL_TOOLS_ROOT`
- `DBX_APP_TERMINAL_NPM_PREFIX`
- `DBX_APP_TERMINAL_NPM_CACHE`

Guardrails:

- `MAX_SESSIONS`
- `MAX_HISTORY_CHARS`
- `MAX_INPUT_BYTES`
- `MAX_WS_MESSAGE_BYTES`
- `WS_BACKPRESSURE_BYTES`
- `DEFAULT_COLS`, `DEFAULT_ROWS`, `MAX_COLS`, `MAX_ROWS`
- `SESSION_ENV_HOOK_TIMEOUT_MS`
- `DIAGNOSTICS_TTL_MS`

## Local development

```bash
npm install
npm run dev
```

Quality gates:

```bash
npm run check
npm test
npm run build
```

## Internals and contribution policy

See [AGENTS.md](./AGENTS.md) for implementation details, architecture boundaries, and contributor/automation rules.

## Operations

See [RUNBOOK.md](./RUNBOOK.md) for deploy/run/troubleshooting procedures.
