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

dbx_agent_persist_enabled() {
  [[ "${DBX_APP_TERMINAL_PERSIST_ENABLED:-0}" == "1" ]] || return 1
  [[ -n "${AGENT_STATE_VOLUME:-}" ]] || return 1
  command -v databricks >/dev/null 2>&1 || return 1
  return 0
}

dbx_agent_persist_remote_prefix() {
  local volume="${AGENT_STATE_VOLUME%/}"
  local type_id="${DBX_APP_TERMINAL_PERSIST_TYPE_ID:-${DBX_APP_TERMINAL_TYPE_ID:-terminal}}"
  printf 'dbfs:%s/agent-state/%s' "$volume" "$type_id"
}

dbx_agent_persist_remote_files_prefix() {
  printf '%s/files' "$(dbx_agent_persist_remote_prefix)"
}

dbx_agent_persist_remote_manifest_path() {
  printf '%s/manifest.txt' "$(dbx_agent_persist_remote_prefix)"
}

dbx_agent_persist_manifest_path() {
  printf '/tmp/dbx-agent-persist-%s-%s-manifest.txt' "${DBX_APP_TERMINAL_TYPE_ID:-terminal}" "${DBX_APP_TERMINAL_SESSION_ID:-unknown}"
}

dbx_agent_persist_old_manifest_path() {
  printf '/tmp/dbx-agent-persist-%s-%s-manifest.old.txt' "${DBX_APP_TERMINAL_TYPE_ID:-terminal}" "${DBX_APP_TERMINAL_SESSION_ID:-unknown}"
}

dbx_agent_persist_is_excluded() {
  local rel="$1"
  shift || true

  local ex
  for ex in "$@"; do
    [[ -n "$ex" ]] || continue
    if [[ "$rel" == $ex ]]; then
      return 0
    fi
  done

  return 1
}

dbx_agent_persist_collect_manifest() {
  local manifest_path="$1"
  local include_raw="${DBX_APP_TERMINAL_PERSIST_INCLUDE:-}"
  local exclude_raw="${DBX_APP_TERMINAL_PERSIST_EXCLUDE:-}"

  : > "$manifest_path"
  [[ -n "$include_raw" ]] || return 0

  local IFS=$'\n'
  local patterns=($include_raw)
  local excludes=($exclude_raw)

  shopt -s globstar nullglob dotglob

  local pattern
  for pattern in "${patterns[@]}"; do
    [[ -n "$pattern" ]] || continue

    local matches=("${HOME}"/$pattern)
    local match
    for match in "${matches[@]}"; do
      [[ -e "$match" ]] || continue

      if [[ -d "$match" ]]; then
        while IFS= read -r file; do
          [[ -f "$file" ]] || continue
          local rel="${file#${HOME}/}"
          dbx_agent_persist_is_excluded "$rel" "${excludes[@]}" && continue
          printf '%s\n' "$rel" >> "$manifest_path"
        done < <(find "$match" -type f 2>/dev/null)
      else
        local rel="${match#${HOME}/}"
        dbx_agent_persist_is_excluded "$rel" "${excludes[@]}" && continue
        printf '%s\n' "$rel" >> "$manifest_path"
      fi
    done
  done

  shopt -u globstar nullglob dotglob

  if [[ -s "$manifest_path" ]]; then
    sort -u -o "$manifest_path" "$manifest_path"
  fi
}

dbx_agent_persist_restore_if_enabled() {
  dbx_agent_persist_enabled || return 0

  local remote_manifest
  remote_manifest="$(dbx_agent_persist_remote_manifest_path)"
  local local_manifest
  local_manifest="$(dbx_agent_persist_old_manifest_path)"

  rm -f "$local_manifest"
  if ! databricks fs cp "$remote_manifest" "$local_manifest" >/dev/null 2>&1; then
    return 0
  fi

  local remote_files
  remote_files="$(dbx_agent_persist_remote_files_prefix)"
  local restore_strategy="${DBX_APP_TERMINAL_PERSIST_RESTORE_STRATEGY:-overwrite}"

  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue

    local local_path="${HOME}/${rel}"
    if [[ "$restore_strategy" == "if-missing" ]] && [[ -e "$local_path" ]]; then
      continue
    fi

    mkdir -p "$(dirname "$local_path")"
    databricks fs cp "${remote_files}/${rel}" "$local_path" >/dev/null 2>&1 || true
  done < "$local_manifest"
}

dbx_agent_persist_sync_once() {
  dbx_agent_persist_enabled || return 0

  local prefix
  prefix="$(dbx_agent_persist_remote_prefix)"
  local remote_files
  remote_files="$(dbx_agent_persist_remote_files_prefix)"
  local remote_manifest
  remote_manifest="$(dbx_agent_persist_remote_manifest_path)"

  local manifest_path
  manifest_path="$(dbx_agent_persist_manifest_path)"
  local old_manifest_path
  old_manifest_path="$(dbx_agent_persist_old_manifest_path)"

  dbx_agent_persist_collect_manifest "$manifest_path"

  rm -f "$old_manifest_path"
  databricks fs cp "$remote_manifest" "$old_manifest_path" >/dev/null 2>&1 || true

  databricks fs mkdir "$prefix" >/dev/null 2>&1 || true

  if [[ -f "$old_manifest_path" ]]; then
    while IFS= read -r old_rel; do
      [[ -n "$old_rel" ]] || continue
      if ! grep -Fqx "$old_rel" "$manifest_path" 2>/dev/null; then
        databricks fs rm "${remote_files}/${old_rel}" >/dev/null 2>&1 || true
      fi
    done < "$old_manifest_path"
  fi

  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue

    local local_path="${HOME}/${rel}"
    [[ -f "$local_path" ]] || continue

    local remote_path="${remote_files}/${rel}"
    databricks fs mkdir "$(dirname "$remote_path")" >/dev/null 2>&1 || true
    databricks fs cp "$local_path" "$remote_path" --overwrite >/dev/null 2>&1 || true
  done < "$manifest_path"

  databricks fs cp "$manifest_path" "$remote_manifest" --overwrite >/dev/null 2>&1 || true
}

dbx_agent_persist_watch_if_enabled() {
  dbx_agent_persist_enabled || return 0

  local interval="${DBX_APP_TERMINAL_PERSIST_SYNC_INTERVAL_SEC:-10}"
  if ! [[ "$interval" =~ ^[0-9]+$ ]]; then
    interval=10
  fi
  if [[ "$interval" -lt 3 ]]; then
    interval=3
  fi

  (
    while kill -0 "$$" >/dev/null 2>&1; do
      dbx_agent_persist_sync_once
      sleep "$interval"
    done
  ) >/dev/null 2>&1 &

  export DBX_APP_TERMINAL_PERSIST_SYNC_PID=$!
}
