#!/usr/bin/env bash
# shellcheck shell=bash

__dbx_terminal_type_name="codex"
__dbx_terminal_type_cmd="${DBX_APP_TERMINAL_CODEX_CMD:-codex}"
__dbx_terminal_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
__dbx_terminal_shared_dir="${__dbx_terminal_root}/terminal-types/_shared"
__dbx_codex_model="${DBX_APP_TERMINAL_CODEX_MODEL:-databricks-gpt-5-3-codex}"

# shellcheck source=../_shared/agent-bootstrap.sh
source "${__dbx_terminal_shared_dir}/agent-bootstrap.sh"

dbx_agent_home
dbx_agent_add_node_path "${__dbx_terminal_root}"
if ! dbx_agent_require_oauth_env; then
  printf '\n[session-type:%s] oauth env bootstrap failed. staying in shell.\n\n' "$__dbx_terminal_type_name"
  return 0
fi

if ! __dbx_host_url="$(dbx_agent_host_url)"; then
  printf '\n[session-type:%s] host bootstrap failed. staying in shell.\n\n' "$__dbx_terminal_type_name"
  return 0
fi

if ! dbx_agent_write_databrickscfg "${__dbx_host_url}"; then
  printf '\n[session-type:%s] databrickscfg bootstrap failed. staying in shell.\n\n' "$__dbx_terminal_type_name"
  return 0
fi

__dbx_bearer_token="$(dbx_agent_exchange_token "${__dbx_terminal_shared_dir}" || true)"
if [[ -z "${__dbx_bearer_token}" ]]; then
  __dbx_bearer_token="$(dbx_agent_read_token_file)"
fi
if [[ -z "${__dbx_bearer_token}" ]]; then
  printf '\n[session-type:%s] token bootstrap failed. staying in shell.\n\n' "$__dbx_terminal_type_name"
  return 0
fi

dbx_agent_write_token_file "${__dbx_bearer_token}"
dbx_agent_write_codex_config "${__dbx_host_url}" "${__dbx_codex_model}"
export DATABRICKS_TOKEN="${__dbx_bearer_token}"
export DATABRICKS_AUTH_TYPE="pat"
unset DATABRICKS_CLIENT_ID DATABRICKS_CLIENT_SECRET

__dbx_codex_launched=0
if [[ "${DBX_APP_TERMINAL_TYPE_NO_AUTO_EXEC:-0}" != "1" ]] && command -v "$__dbx_terminal_type_cmd" >/dev/null 2>&1; then
  __dbx_codex_launched=1
  if "$__dbx_terminal_type_cmd"; then
    :
  else
    __dbx_codex_exit_code="$?"
    printf '\n[session-type:%s] CLI exited with status %s. Staying in shell.\n\n' \
      "$__dbx_terminal_type_name" "$__dbx_codex_exit_code"
    unset __dbx_codex_exit_code
  fi
fi

if [[ "$__dbx_codex_launched" == "0" ]]; then
  printf '\n[session-type:%s] CLI "%s" was not auto-started.\n' "$__dbx_terminal_type_name" "$__dbx_terminal_type_cmd"
  printf '[session-type:%s] Staying in shell. Run `%s` when ready.\n\n' "$__dbx_terminal_type_name" "$__dbx_terminal_type_cmd"
fi

unset __dbx_terminal_type_name __dbx_terminal_type_cmd __dbx_terminal_root __dbx_terminal_shared_dir __dbx_host_url __dbx_bearer_token __dbx_codex_model __dbx_codex_launched
