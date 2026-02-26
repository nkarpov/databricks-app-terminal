#!/bin/bash
# Optional agent setup script for Databricks App Terminal.
# Run this before the app starts to enable Claude Code and Codex agent sessions.
# Ports the proven patterns from coding-agents-databricks/startup.sh.
#
# Usage in app.yaml:
#   command: ["bash", "-c", "source scripts/agent-setup.sh && npm run start"]
#
# Skip this entirely if you only need plain terminal sessions.
set -e

echo "[agent-setup] Starting agent environment configuration..."

# ── Home directory ──────────────────────────────────────────────────────────
export HOME="${HOME:-/home/app}"
mkdir -p "$HOME"

# ── Agent CLI binaries ─────────────────────────────────────────────────────
# Agent CLIs (claude, codex) are installed as optionalDependencies in
# package.json. The platform's npm install step puts them in node_modules/.bin.
# We just need to ensure that directory is on PATH for agent sessions.
APP_BIN="$(pwd)/node_modules/.bin"
if [ -d "$APP_BIN" ]; then
    export PATH="$APP_BIN:$PATH"
    echo "[agent-setup] Added node_modules/.bin to PATH: $APP_BIN"
fi

# Verify agent binaries are available
for bin in claude codex; do
    if command -v "$bin" &>/dev/null; then
        echo "[agent-setup] Found $bin at $(which $bin)"
    else
        echo "[agent-setup] WARNING: $bin not found on PATH"
    fi
done

# ── Databricks CLI config ──────────────────────────────────────────────────
# The container gets DATABRICKS_HOST, DATABRICKS_CLIENT_ID, and
# DATABRICKS_CLIENT_SECRET injected automatically by the platform.
# Write a .databrickscfg so the Databricks CLI and SDK can authenticate.
cat > "$HOME/.databrickscfg" << DBCFG
[DEFAULT]
host = https://${DATABRICKS_HOST}
client_id = ${DATABRICKS_CLIENT_ID}
client_secret = ${DATABRICKS_CLIENT_SECRET}

[sandbox]
host = https://${DATABRICKS_HOST}
client_id = ${DATABRICKS_CLIENT_ID}
client_secret = ${DATABRICKS_CLIENT_SECRET}
DBCFG
echo "[agent-setup] Wrote ~/.databrickscfg"

# ── Exchange OAuth credentials for bearer token ────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "$SCRIPT_DIR/get-token.sh" 2>/dev/null || true
DBX_BEARER_TOKEN=$(bash "$SCRIPT_DIR/get-token.sh" 2>/dev/null || echo "")

if [ -z "$DBX_BEARER_TOKEN" ]; then
    echo "[agent-setup] WARNING: Could not obtain bearer token. Agent auth may fail."
fi

# ── Save bearer token for Codex sessions ───────────────────────────────────
echo -n "$DBX_BEARER_TOKEN" > "$HOME/.dbx_bearer_token"
chmod 600 "$HOME/.dbx_bearer_token"

# ── Databricks auth disambiguation ────────────────────────────────────────
export DATABRICKS_AUTH_TYPE="oauth-m2m"

# ── Claude Code settings ──────────────────────────────────────────────────
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/settings.json" << SETTINGS
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://${DATABRICKS_HOST}/serving-endpoints/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "${DBX_BEARER_TOKEN}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "databricks-claude-opus-4-6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "databricks-claude-sonnet-4-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "databricks-claude-haiku-4-5",
    "ANTHROPIC_CUSTOM_HEADERS": "x-databricks-use-coding-agent-mode: true",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
  },
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "WebFetch",
      "WebSearch"
    ],
    "deny": []
  }
}
SETTINGS

# ── Claude Code onboarding bypass ─────────────────────────────────────────
APP_DIR="$(pwd)"
cat > "$HOME/.claude.json" << CLSTATE
{
  "hasCompletedOnboarding": true,
  "projects": {
    "${APP_DIR}": {
      "allowedTools": [],
      "hasTrustDialogAccepted": true
    }
  }
}
CLSTATE

# ── Codex config ──────────────────────────────────────────────────────────
mkdir -p "$HOME/.codex"

cat > "$HOME/.codex/config.toml" << CODEXCFG
profile = "default"
web_search = "disabled"

[profiles.default]
model_provider = "proxy"
model = "databricks-gpt-5-2"
model_catalog_json = "${HOME}/.codex/databricks-models.json"

[model_providers.proxy]
name = "Databricks Proxy"
base_url = "https://${DATABRICKS_HOST}/serving-endpoints"
env_key = "DATABRICKS_TOKEN"
wire_api = "responses"
CODEXCFG

cat > "$HOME/.codex/databricks-models.json" << 'MODELS'
{
  "models": [
    {
      "slug": "databricks-gpt-5-3-codex",
      "display_name": "databricks-gpt-5-3-codex",
      "description": "GPT-5.3 Codex via Databricks Model Serving",
      "context_window": 272000,
      "supported_in_api": true,
      "priority": 0,
      "available_in_plans": ["enterprise"],
      "supports_reasoning_summaries": true,
      "support_verbosity": true,
      "default_verbosity": "low",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        {"effort": "low", "description": "Fast responses with lighter reasoning"},
        {"effort": "medium", "description": "Balances speed and reasoning depth"},
        {"effort": "high", "description": "Greater reasoning depth for complex problems"},
        {"effort": "xhigh", "description": "Maximum reasoning depth"}
      ],
      "input_modalities": ["text", "image"],
      "supports_parallel_tool_calls": true,
      "prefer_websockets": false,
      "apply_patch_tool_type": "freeform",
      "truncation_policy": {"mode": "tokens", "limit": 10000},
      "reasoning_summary_format": "experimental",
      "shell_type": "shell_command",
      "visibility": "list",
      "minimal_client_version": "0.98.0",
      "upgrade": null,
      "base_instructions": "",
      "model_messages": null,
      "experimental_supported_tools": []
    },
    {
      "slug": "databricks-gpt-5-2",
      "display_name": "databricks-gpt-5-2",
      "description": "GPT-5.2 via Databricks Model Serving",
      "context_window": 272000,
      "supported_in_api": true,
      "priority": 1,
      "available_in_plans": ["enterprise"],
      "supports_reasoning_summaries": true,
      "support_verbosity": true,
      "default_verbosity": "low",
      "default_reasoning_level": "medium",
      "supported_reasoning_levels": [
        {"effort": "low", "description": "Fast responses with lighter reasoning"},
        {"effort": "medium", "description": "Balances speed and reasoning depth"},
        {"effort": "high", "description": "Greater reasoning depth for complex problems"},
        {"effort": "xhigh", "description": "Maximum reasoning depth"}
      ],
      "input_modalities": ["text", "image"],
      "supports_parallel_tool_calls": true,
      "prefer_websockets": false,
      "apply_patch_tool_type": "freeform",
      "truncation_policy": {"mode": "tokens", "limit": 10000},
      "reasoning_summary_format": "experimental",
      "shell_type": "shell_command",
      "visibility": "list",
      "minimal_client_version": "0.98.0",
      "upgrade": null,
      "base_instructions": "",
      "model_messages": null,
      "experimental_supported_tools": []
    }
  ]
}
MODELS

# ── Tell the app to load the agent env service ───────────────────────────
export SERVICE_MODULES="./dist/services/agentEnvService.js"

echo "[agent-setup] Agent environment configuration complete."
