# Terminal types

Session types are discovered at startup from this directory.

Current profiles in this repo:
- `claude`
- `codex`
- `pi`

Each custom type must live in its own folder:

```text
terminal-types/<type-id>/
  type.json
  launch.sh
```

## `type.json`

```json
{
  "id": "claude",
  "name": "Claude Code",
  "description": "Launch Claude Code in the terminal",
  "badge": "claude",
  "icon": "✶",
  "entrypoint": "launch.sh"
}
```

Fields:
- `id` (optional): type id (`[a-z0-9][a-z0-9-_]{0,63}`), defaults to folder name
- `name` (required): display name
- `description` (optional): short description
- `badge` (optional): short tab badge label
- `icon` (optional): short icon/logo string (e.g. unicode glyph) used in TUI picker and tab badge
  - can be a private-use glyph when backed by a bundled icon font
- `entrypoint` (optional): launch script path relative to type folder, default `launch.sh`
- `persistence` (optional): declarative agent-state sync contract used by shared bootstrap helpers
  - `enabled` (bool)
  - `schemaVersion` (int, currently `1`)
  - `include` (array of glob patterns relative to `$HOME`)
  - `exclude` (optional array of glob patterns)
  - `restoreStrategy` (`overwrite` or `if-missing`)

## `launch.sh`

`launch.sh` is sourced by the base shell startup sequence once, at session boot.

- Use it to set env vars and/or `exec` a CLI.
- If it returns without `exec`, the user stays in a regular shell.
- Session auth mode (`m2m` / `user`) and Databricks auth env handling are already provided by core runtime.
- Shared helpers for Databricks-backed agents live in `terminal-types/_shared/agent-bootstrap.sh` and `terminal-types/_shared/get-token.sh`.
- Keep provider-specific setup in the type's own `launch.sh` for true drop-in extensions.

## Databricks-backed agent launchers

The built-in `claude`, `codex`, and `pi` terminal types source shared helper logic from `terminal-types/_shared/`.

- `agent-bootstrap.sh` provides generic bootstrap primitives (host normalization, OAuth checks, `.databrickscfg`, token exchange/cache).
- `agent-bootstrap.sh` also provides optional persistence helpers:
  - `dbx_agent_persist_restore_if_enabled`
  - `dbx_agent_persist_watch_if_enabled`
- `get-token.sh` performs service-principal OAuth token exchange (with `DATABRICKS_TOKEN` fallback).
- Provider-specific CLI config generation lives inside each type's own `launch.sh`.

Persistence helpers expect `AGENT_STATE_VOLUME` to be set (for example via Databricks Apps `app.yaml` `env[].valueFrom`), and sync raw files + `manifest.txt` to `dbfs:${AGENT_STATE_VOLUME}/agent-state/<type-id>/`.

Launcher env knobs:

- `DBX_APP_TERMINAL_CLAUDE_CMD` (default `claude`)
- `DBX_APP_TERMINAL_CODEX_CMD` (default `codex`)
- `DBX_APP_TERMINAL_CLAUDE_MODEL` (optional Claude model override)
- `DBX_APP_TERMINAL_CODEX_MODEL` (default `databricks-gpt-5-3-codex`)
