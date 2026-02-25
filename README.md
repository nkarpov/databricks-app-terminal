# Databricks App Terminal

Databricks App Terminal is a multi-session web terminal for Databricks Apps.

![Auth mode switching demo](./images/auth.gif)

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
- Each tab shows a tiny auth badge (`m2m` / `user`); click it to toggle auth mode for that session.
- Tab titles follow terminal title escape sequences from the running shell/app.

## Databricks identity model

Inside Databricks Apps:

- commands run as the app service principal by default
- Databricks CLI is preinstalled in the runtime
- default CLI authentication uses app M2M context

Optional per-session user mode:

- create with `authMode: "user"` (or toggle per-tab badge)
- backend reads the forwarded user token header (`x-forwarded-access-token` by default)
- shell is seeded with `DATABRICKS_HOST` + `DATABRICKS_TOKEN` for Databricks CLI calls as that user
- built-in `dbx-auth` command supports switching in-shell (`dbx-auth m2m`, `dbx-auth user`) and prints current mode with no args

This keeps M2M as the safe default while allowing explicit user-delegated CLI sessions.

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
- `POST /api/sessions` (optional body: `{ cwd?, cols?, rows?, authMode?: "m2m" | "user" }`)
- `POST /api/sessions/:sessionId/attach`
- `POST /api/sessions/:sessionId/input`
- `POST /api/sessions/:sessionId/resize`
- `POST /api/sessions/:sessionId/auth-mode` (body: `{ mode: "m2m" | "user" }`)
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

User mode (Databricks CLI delegation):

- `DATABRICKS_HOST` (preferred) or `DATABRICKS_SERVER_HOSTNAME` (fallback)
- `USER_ACCESS_TOKEN_HEADER` (default `x-forwarded-access-token`)
- `ALLOW_USER_TOKEN_AUTH` (default `true`)

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
