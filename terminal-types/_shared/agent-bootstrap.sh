#!/usr/bin/env bash
# shellcheck shell=bash

dbx_agent_log() {
  printf '[agent-bootstrap] %s\n' "$*"
}

dbx_agent_die() {
  dbx_agent_log "ERROR: $*"
  return 1
}

dbx_agent_normalize_host() {
  local raw="${1:-}"
  raw="${raw#https://}"
  raw="${raw#http://}"
  raw="${raw%%/*}"
  printf '%s' "$raw"
}

dbx_agent_home() {
  export HOME="${HOME:-/home/app}"
  mkdir -p "$HOME"
}

dbx_agent_host_name() {
  local raw="${DATABRICKS_HOST:-${DATABRICKS_SERVER_HOSTNAME:-}}"
  dbx_agent_normalize_host "$raw"
}

dbx_agent_host_url() {
  local host
  host="$(dbx_agent_host_name)"
  [[ -n "$host" ]] || return 1
  printf 'https://%s' "$host"
}

dbx_agent_require_oauth_env() {
  [[ -n "$(dbx_agent_host_name)" ]] || dbx_agent_die "Missing DATABRICKS_HOST (or DATABRICKS_SERVER_HOSTNAME)"
  [[ -n "${DATABRICKS_CLIENT_ID:-}" ]] || dbx_agent_die "Missing DATABRICKS_CLIENT_ID"
  [[ -n "${DATABRICKS_CLIENT_SECRET:-}" ]] || dbx_agent_die "Missing DATABRICKS_CLIENT_SECRET"
}

dbx_agent_add_node_path() {
  local root="$1"
  local app_bin="${root}/node_modules/.bin"
  if [[ -d "$app_bin" ]]; then
    export PATH="${app_bin}:${PATH}"
  fi
}

dbx_agent_write_databrickscfg() {
  local url="$1"
  cat > "${HOME}/.databrickscfg" << DBCFG
[DEFAULT]
host = ${url}
client_id = ${DATABRICKS_CLIENT_ID}
client_secret = ${DATABRICKS_CLIENT_SECRET}

[sandbox]
host = ${url}
client_id = ${DATABRICKS_CLIENT_ID}
client_secret = ${DATABRICKS_CLIENT_SECRET}
DBCFG
  chmod 600 "${HOME}/.databrickscfg"
}

dbx_agent_exchange_token() {
  local shared_dir="$1"
  local host_name
  host_name="$(dbx_agent_host_name)"
  DATABRICKS_HOST="${host_name}" bash "${shared_dir}/get-token.sh"
}

dbx_agent_write_token_file() {
  local token="$1"
  printf '%s' "$token" > "${HOME}/.dbx_bearer_token"
  chmod 600 "${HOME}/.dbx_bearer_token"
}

dbx_agent_read_token_file() {
  if [[ -f "${HOME}/.dbx_bearer_token" ]]; then
    tr -d '\r\n' < "${HOME}/.dbx_bearer_token"
  fi
}

dbx_agent_write_claude_settings() {
  local host_url="$1"
  local token="$2"
  local project_dir="$3"
  mkdir -p "${HOME}/.claude"

  cat > "${HOME}/.claude/settings.json" << SETTINGS
{
  "env": {
    "ANTHROPIC_BASE_URL": "${host_url}/serving-endpoints/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "${token}",
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
  chmod 600 "${HOME}/.claude/settings.json"

  cat > "${HOME}/.claude.json" << CLSTATE
{
  "hasCompletedOnboarding": true,
  "projects": {
    "${project_dir}": {
      "allowedTools": [],
      "hasTrustDialogAccepted": true
    }
  }
}
CLSTATE
}

dbx_agent_write_codex_config() {
  local host_url="$1"
  local default_model="$2"
  mkdir -p "${HOME}/.codex"

  cat > "${HOME}/.codex/config.toml" << CODEXCFG
profile = "default"
# Databricks OpenAI proxy currently rejects web_search tool calls.
web_search = "disabled"

[profiles.default]
model_provider = "proxy"
model = "${default_model}"
model_catalog_json = "${HOME}/.codex/databricks-models.json"

[model_providers.proxy]
name = "Databricks Proxy"
base_url = "${host_url}/serving-endpoints"
env_key = "DATABRICKS_TOKEN"
wire_api = "responses"
CODEXCFG

  cat > "${HOME}/.codex/databricks-models.json" << 'MODELS'
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
}
