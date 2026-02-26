import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createTerminalServer } from "./http/app.js";
import { Logger } from "./logging/logger.js";
import { RuntimeDiagnosticsManager } from "./runtime/diagnostics.js";
import { InMemoryPtySessionManager } from "./sessions/ptySessionManager.js";
import { loadRuntimeServices } from "./services/loader.js";
import { ServiceRegistry } from "./services/registry.js";

type RuntimeToolingPaths = {
  runtimeRoot: string;
  runtimeBinDir: string;
  shimsDir: string;
  authStateDir: string;
  bashAuthHookPath: string;
  bashRcPath: string;
};

function prependPathEntries(existingPath: string, entries: string[]): string {
  const existing = existingPath.split(":").filter((entry) => entry.length > 0);
  const combined = [...entries, ...existing];
  const unique: string[] = [];

  for (const entry of combined) {
    if (entry.length === 0 || unique.includes(entry)) {
      continue;
    }
    unique.push(entry);
  }

  return unique.join(":");
}

async function writeFileWithMode(filePath: string, content: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  await fs.chmod(filePath, mode);
}

function buildDbxAuthScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail

if [[ -z "\${DBX_APP_TERMINAL_SESSION_ID:-}" ]]; then
  echo "dbx-auth: missing session context" >&2
  exit 1
fi

base_url="http://127.0.0.1:\${DBX_APP_TERMINAL_PORT:-8080}/api/sessions/\${DBX_APP_TERMINAL_SESSION_ID}/auth-mode"

extract_mode() {
  printf '%s' "$1" | sed -n 's/.*"authMode":"\\([^"]*\\)".*/\\1/p' | head -n 1
}

request() {
  curl -sS -w '\\n%{http_code}' "$@"
}

if [[ "$#" -gt 1 ]]; then
  echo "usage: dbx-auth [m2m|user]" >&2
  exit 2
fi

if [[ "$#" -eq 0 ]]; then
  response="$(request "$base_url")"
else
  mode="$1"
  if [[ "$mode" != "m2m" ]] && [[ "$mode" != "user" ]]; then
    echo "usage: dbx-auth [m2m|user]" >&2
    exit 2
  fi

  response="$(request -X POST -H 'content-type: application/json' --data '{"mode":"'"$mode"'"}' "$base_url")"
fi

status="\${response##*$'\\n'}"
body="\${response%$'\\n'*}"

if [[ "$status" -lt 200 ]] || [[ "$status" -ge 300 ]]; then
  printf '%s\\n' "$body" >&2
  exit 1
fi

mode="$(extract_mode "$body")"
if [[ -z "$mode" ]]; then
  echo "dbx-auth: failed to parse response" >&2
  exit 1
fi

printf '%s\\n' "$mode"
`;
}

function buildBashAuthHookScript(): string {
  return `#!/usr/bin/env bash
# shellcheck shell=bash

if [[ -n "\${DBX_APP_TERMINAL_AUTH_HOOK_LOADED:-}" ]]; then
  return 0
fi
DBX_APP_TERMINAL_AUTH_HOOK_LOADED=1

__dbx_terminal_restore_var() {
  local name="$1"
  local set_flag="$2"
  local value="$3"

  if [[ "$set_flag" == "1" ]]; then
    printf -v "$name" '%s' "$value"
    export "$name"
  else
    unset "$name"
  fi
}

__dbx_terminal_sync_env() {
  local state_file="\${DBX_APP_TERMINAL_AUTH_STATE_FILE:-}"
  if [[ -z "$state_file" ]] || [[ ! -r "$state_file" ]]; then
    return 0
  fi

  local DBX_APP_TERMINAL_STATE_MODE=""
  local DBX_APP_TERMINAL_STATE_DATABRICKS_HOST=""
  local DBX_APP_TERMINAL_STATE_DATABRICKS_TOKEN=""
  local DBX_APP_TERMINAL_STATE_USER_TOKEN_HEADER=""
  local DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_HOST=""
  local DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_HOST_SET="0"
  local DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_CLIENT_ID=""
  local DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_CLIENT_ID_SET="0"
  local DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_CLIENT_SECRET=""
  local DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_CLIENT_SECRET_SET="0"

  # shellcheck disable=SC1090
  source "$state_file" >/dev/null 2>&1 || return 0

  local mode="\${DBX_APP_TERMINAL_STATE_MODE:-m2m}"

  if [[ "$mode" == "\${__DBX_APP_TERMINAL_LAST_APPLIED_MODE:-}" ]] \
    && [[ "\${DBX_APP_TERMINAL_STATE_DATABRICKS_HOST:-}" == "\${__DBX_APP_TERMINAL_LAST_APPLIED_HOST:-}" ]] \
    && [[ "\${DBX_APP_TERMINAL_STATE_DATABRICKS_TOKEN:-}" == "\${__DBX_APP_TERMINAL_LAST_APPLIED_TOKEN:-}" ]]; then
    return 0
  fi

  __DBX_APP_TERMINAL_LAST_APPLIED_MODE="$mode"
  __DBX_APP_TERMINAL_LAST_APPLIED_HOST="\${DBX_APP_TERMINAL_STATE_DATABRICKS_HOST:-}"
  __DBX_APP_TERMINAL_LAST_APPLIED_TOKEN="\${DBX_APP_TERMINAL_STATE_DATABRICKS_TOKEN:-}"

  export DBX_APP_TERMINAL_USER_TOKEN_HEADER="\${DBX_APP_TERMINAL_STATE_USER_TOKEN_HEADER:-x-forwarded-access-token}"

  if [[ "$mode" == "user" ]]; then
    export DBX_APP_TERMINAL_AUTH_MODE="user"
    export DATABRICKS_AUTH_TYPE="pat"

    if [[ -n "\${DBX_APP_TERMINAL_STATE_DATABRICKS_HOST:-}" ]]; then
      export DATABRICKS_HOST="\${DBX_APP_TERMINAL_STATE_DATABRICKS_HOST}"
    else
      unset DATABRICKS_HOST
    fi

    if [[ -n "\${DBX_APP_TERMINAL_STATE_DATABRICKS_TOKEN:-}" ]]; then
      export DATABRICKS_TOKEN="\${DBX_APP_TERMINAL_STATE_DATABRICKS_TOKEN}"
    else
      unset DATABRICKS_TOKEN
    fi

    unset DATABRICKS_CLIENT_ID
    unset DATABRICKS_CLIENT_SECRET
    return 0
  fi

  export DBX_APP_TERMINAL_AUTH_MODE="m2m"
  export DATABRICKS_AUTH_TYPE="oauth-m2m"
  unset DATABRICKS_TOKEN

  __dbx_terminal_restore_var DATABRICKS_HOST "\${DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_HOST_SET:-0}" "\${DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_HOST:-}"
  __dbx_terminal_restore_var DATABRICKS_CLIENT_ID "\${DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_CLIENT_ID_SET:-0}" "\${DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_CLIENT_ID:-}"
  __dbx_terminal_restore_var DATABRICKS_CLIENT_SECRET "\${DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_CLIENT_SECRET_SET:-0}" "\${DBX_APP_TERMINAL_STATE_ORIG_DATABRICKS_CLIENT_SECRET:-}"
}

__dbx_terminal_debug_hook() {
  if [[ "\${__DBX_APP_TERMINAL_SYNC_GUARD:-0}" == "1" ]]; then
    return 0
  fi

  __DBX_APP_TERMINAL_SYNC_GUARD=1
  __dbx_terminal_sync_env
  __DBX_APP_TERMINAL_SYNC_GUARD=0
}

trap '__dbx_terminal_debug_hook' DEBUG
__dbx_terminal_debug_hook
`;
}

function buildBashRcScript(): string {
  return `#!/usr/bin/env bash
if [ -f /etc/bash.bashrc ]; then
  . /etc/bash.bashrc
fi

if [ -f /etc/bashrc ]; then
  . /etc/bashrc
fi

if [ -f ~/.bashrc ]; then
  . ~/.bashrc
fi

if [ -n "\${DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH:-}" ] && [ -f "\${DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH}" ]; then
  . "\${DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH}" >/dev/null 2>&1
fi
`;
}

function buildAuthShimScript(): string {
  return `#!/usr/bin/env bash
# Auth-switching shim: syncs credentials from the per-session state file
# before delegating to the real binary. Agent tool-call subprocesses don't
# inherit BASH_ENV or DEBUG traps, so this shim ensures every invocation
# of shimmed commands picks up the current auth mode.

if [ -n "\${DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH:-}" ] && [ -f "$DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH" ]; then
  . "$DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH" 2>/dev/null
fi

# Find the real binary by searching PATH, skipping this shim's directory
__shim_dir="$(cd "$(dirname "$0")" && pwd)"
__cmd="$(basename "$0")"
IFS=: read -ra __dirs <<< "$PATH"
for __d in "\${__dirs[@]}"; do
  [ "$__d" = "$__shim_dir" ] && continue
  if [ -x "$__d/$__cmd" ]; then
    exec "$__d/$__cmd" "$@"
  fi
done
echo "$__cmd: command not found" >&2
exit 127
`;
}

async function prepareRuntimeTooling(toolsRoot: string): Promise<RuntimeToolingPaths> {
  const runtimeRoot = path.join(toolsRoot, "runtime");
  const runtimeBinDir = path.join(runtimeRoot, "bin");
  const shimsDir = path.join(runtimeRoot, "shims");
  const authStateDir = path.join(runtimeRoot, "auth-state");
  const bashAuthHookPath = path.join(runtimeRoot, "bash-auth-hook.sh");
  const bashRcPath = path.join(runtimeRoot, "bashrc");
  const dbxAuthPath = path.join(runtimeBinDir, "dbx-auth");

  await fs.mkdir(runtimeBinDir, { recursive: true });
  await fs.mkdir(shimsDir, { recursive: true });
  await fs.mkdir(authStateDir, { recursive: true });

  await writeFileWithMode(dbxAuthPath, buildDbxAuthScript(), 0o755);
  await writeFileWithMode(bashAuthHookPath, buildBashAuthHookScript(), 0o644);
  await writeFileWithMode(bashRcPath, buildBashRcScript(), 0o644);

  // Write auth-switching shims for commands that need dynamic credentials.
  // Agent subprocesses don't inherit BASH_ENV or DEBUG traps, so these shims
  // source the auth hook and then exec the real binary.
  const shimScript = buildAuthShimScript();
  await writeFileWithMode(path.join(shimsDir, "databricks"), shimScript, 0o755);

  // Write ~/.bash_profile and ~/.bashrc so agent subprocesses (login shells,
  // interactive shells) source the auth hook. This covers Codex's `bash -lc`
  // tool calls and any interactive bash subshells.
  const homeDir = process.env.HOME || "/home/app";
  const bashProfilePath = path.join(homeDir, ".bash_profile");
  const bashrcPath = path.join(homeDir, ".bashrc");

  const profileContent = `# Written by databricks-app-terminal at startup
[ -n "\${DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH:-}" ] && \\
  [ -f "$DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH" ] && \\
  . "$DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH" 2>/dev/null
[ -f ~/.bashrc ] && . ~/.bashrc
`;

  const bashrcSnippet = `\n# Written by databricks-app-terminal at startup
[ -n "\${DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH:-}" ] && \\
  [ -f "$DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH" ] && \\
  . "$DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH" 2>/dev/null
`;

  await writeFileWithMode(bashProfilePath, profileContent, 0o644);

  // Append to ~/.bashrc rather than overwriting — it may already exist
  try {
    const existingBashrc = await fs.readFile(bashrcPath, "utf-8");
    if (!existingBashrc.includes("DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH")) {
      await fs.appendFile(bashrcPath, bashrcSnippet);
    }
  } catch {
    // File doesn't exist, write it fresh
    await writeFileWithMode(bashrcPath, bashrcSnippet.trimStart(), 0o644);
  }

  return {
    runtimeRoot,
    runtimeBinDir,
    shimsDir,
    authStateDir,
    bashAuthHookPath,
    bashRcPath,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger({
    appName: config.appName,
    level: config.logLevel,
    path: config.logPath,
  });

  const loadedServices = await loadRuntimeServices(config.serviceModules, logger);

  const serviceRegistry = new ServiceRegistry(
    loadedServices,
    {
      config,
      logger,
    },
    logger,
    config.sessionEnvHookTimeoutMs,
  );

  await serviceRegistry.startAll();

  await fs.mkdir(config.npmGlobalPrefix, { recursive: true });
  await fs.mkdir(config.npmCacheDir, { recursive: true });

  const tooling = await prepareRuntimeTooling(config.toolsRoot);

  const npmGlobalBin = path.join(config.npmGlobalPrefix, "bin");
  const existingPath = process.env.PATH || "";
  const prefixedPath = prependPathEntries(existingPath, [tooling.shimsDir, tooling.runtimeBinDir, npmGlobalBin]);

  const sessions = new InMemoryPtySessionManager({
    shell: config.shell,
    baseEnv: {
      NPM_CONFIG_PREFIX: config.npmGlobalPrefix,
      NPM_CONFIG_CACHE: config.npmCacheDir,
      npm_config_prefix: config.npmGlobalPrefix,
      npm_config_cache: config.npmCacheDir,
      PATH: prefixedPath,
      DBX_APP_TERMINAL_NPM_PREFIX: config.npmGlobalPrefix,
      DBX_APP_TERMINAL_NPM_CACHE: config.npmCacheDir,
      DBX_APP_TERMINAL_PORT: String(config.port),
      DBX_APP_TERMINAL_BASH_AUTH_HOOK_PATH: tooling.bashAuthHookPath,
    },
    maxSessions: config.maxSessions,
    maxHistoryChars: config.maxHistoryChars,
    maxInputBytes: config.maxInputBytes,
    defaultCols: config.defaultCols,
    defaultRows: config.defaultRows,
    maxCols: config.maxCols,
    maxRows: config.maxRows,
    authStateDir: tooling.authStateDir,
    bashRcFilePath: tooling.bashRcPath,
    bashAuthHookPath: tooling.bashAuthHookPath,
    logger,
  });

  const diagnostics = new RuntimeDiagnosticsManager(config, sessions, serviceRegistry, logger);
  const startupDiagnostics = await diagnostics.getDiagnostics(true);

  logger.info("runtime.startup", {
    ready: startupDiagnostics.ready,
    coreReady: startupDiagnostics.coreReady,
    requiredServicesReady: startupDiagnostics.requiredServicesReady,
    serviceCount: serviceRegistry.getServiceCount(),
    host: config.host,
    port: config.port,
    sessionDefaultCwd: config.sessionDefaultCwd,
    toolsRoot: config.toolsRoot,
    npmGlobalPrefix: config.npmGlobalPrefix,
    npmCacheDir: config.npmCacheDir,
    runtimeToolingRoot: tooling.runtimeRoot,
    allowUserTokenAuth: config.allowUserTokenAuth,
    userAccessTokenHeader: config.userAccessTokenHeader,
    databricksHostConfigured: Boolean(config.databricksHost),
  });

  if (!startupDiagnostics.ready && config.strictRuntimeChecks) {
    throw new Error("Runtime not ready. Check /api/runtime/diagnostics for details.");
  }

  const { server } = createTerminalServer({
    config,
    logger,
    sessions,
    services: serviceRegistry,
    diagnostics,
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => {
      logger.info("server.listen", {
        host: config.host,
        port: config.port,
      });
      resolve();
    });
  });

  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("runtime.shutdown.begin", {
      signal,
    });

    server.close(async () => {
      await sessions.shutdown();
      await serviceRegistry.stopAll();
      logger.info("runtime.shutdown.complete", {
        signal,
      });
      logger.close();
      process.exit(0);
    });

    setTimeout(() => {
      logger.error("runtime.shutdown.timeout", { signal });
      process.exit(1);
    }, 5_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("databricks-app-terminal startup failed", error);
  process.exit(1);
});
