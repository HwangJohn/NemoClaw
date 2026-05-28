#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Canonical `openshell sandbox exec --name <sandbox> -- <cmd>` wrapper.
#
# Absorbs reuse category #10 from the migration spec: 15 legacy scripts
# each reimplement sandbox-scoped exec with subtle drift (quoting, exit-
# code propagation, dry-run handling). This helper provides a single
# contract shared by every migrated suite step.
#
# Functions:
#   e2e_sandbox_exec       <sandbox> -- <cmd> [args...]
#       Run <cmd> inside <sandbox> via `openshell sandbox exec`. No stdin passed.
#
#   e2e_sandbox_exec_stdin <sandbox> -- <cmd> [args...]
#       Like e2e_sandbox_exec but pipes the caller's stdin into the
#       sandbox command. Safe for secrets: no host-side expansion is
#       performed on stdin content.

_E2E_SBEX_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../runtime/lib" && pwd)"
# shellcheck source=../runtime/lib/env.sh
. "${_E2E_SBEX_LIB_DIR}/env.sh"

# Per-call timeout (seconds) applied to every `openshell sandbox exec`
# invocation routed through this wrapper. Callers MAY override per call:
#   E2E_SANDBOX_EXEC_TIMEOUT_SECONDS=50 e2e_sandbox_exec ...
#
# Why a wrapper-level cap exists:
#   The orchestrator (phase.ts) enforces step-level timeouts via SIGTERM on
#   the script's process group. When openshell ssh-into-sandbox hangs,
#   SIGTERM eventually kills the script — but the script has no chance to
#   emit a structured diagnostic, so logs end mid-line. An inner per-call
#   `timeout` lets the wrapper observe the hang, emit a classified
#   diagnostic, and exit cleanly *before* the orchestrator's SIGTERM.
#
# The default (25s) sits below the most common orchestrator step caps
# (30s smoke / kimi, 45s sandbox-local). Steps with longer caps (60s
# chat-completion, 120s rebuild) export a larger value before calling.
: "${E2E_SANDBOX_EXEC_TIMEOUT_SECONDS:=25}"

# Resolve the timeout binary once. Empty string == not available.
_e2e_sbex_resolve_timeout_cmd() {
  if command -v timeout >/dev/null 2>&1; then
    printf '%s' timeout
  elif command -v gtimeout >/dev/null 2>&1; then
    printf '%s' gtimeout
  else
    printf '%s' ''
  fi
}

# _e2e_sbex_split_args <sandbox> -- <cmd> [args...]
# Parses the shared calling convention. Prints on stderr on misuse and
# returns 2. On success, sets the two global arrays _E2E_SBEX_SB_NAME and
# _E2E_SBEX_CMD.
_e2e_sbex_parse() {
  local sandbox="${1:-}"
  if [[ -z "${sandbox}" ]]; then
    echo "e2e_sandbox_exec: missing sandbox name" >&2
    return 2
  fi
  shift
  local sep="${1:-}"
  if [[ "${sep}" != "--" ]]; then
    echo "e2e_sandbox_exec: expected '--' after sandbox name, got '${sep}'" >&2
    return 2
  fi
  shift
  if [[ $# -eq 0 ]]; then
    echo "e2e_sandbox_exec: missing command to run in sandbox" >&2
    return 2
  fi
  _E2E_SBEX_SB_NAME="${sandbox}"
  _E2E_SBEX_CMD=("$@")
}

# e2e_sandbox_exec <sandbox> -- <cmd> [args...]
e2e_sandbox_exec() {
  _e2e_sbex_parse "$@" || return $?
  e2e_env_trace "sandbox:exec" "${_E2E_SBEX_SB_NAME}" "${_E2E_SBEX_CMD[*]}"
  if ! command -v openshell >/dev/null 2>&1; then
    echo "e2e_sandbox_exec: openshell CLI not on PATH" >&2
    return 127
  fi
  local timeout_cmd seconds="${E2E_SANDBOX_EXEC_TIMEOUT_SECONDS}"
  timeout_cmd="$(_e2e_sbex_resolve_timeout_cmd)"
  if [[ -z "${timeout_cmd}" ]]; then
    # No timeout binary available — fall back to bare exec but make the
    # missing safety net visible so CI can flag it.
    echo "e2e_sandbox_exec: 'timeout' not available; running without per-call cap (sandbox=${_E2E_SBEX_SB_NAME})" >&2
    openshell sandbox exec --name "${_E2E_SBEX_SB_NAME}" -- "${_E2E_SBEX_CMD[@]}"
    return $?
  fi
  local rc=0
  "${timeout_cmd}" --kill-after=5s "${seconds}" \
    openshell sandbox exec --name "${_E2E_SBEX_SB_NAME}" -- "${_E2E_SBEX_CMD[@]}"
  rc=$?
  if [[ "${rc}" -eq 124 || "${rc}" -eq 137 ]]; then
    # 124 = timeout fired SIGTERM, 137 = --kill-after fired SIGKILL.
    # Emit a single-line classified diagnostic so phase.ts captures
    # something more useful than a SIGTERM black hole.
    echo "e2e_sandbox_exec: openshell sandbox exec hung after ${seconds}s (sandbox=${_E2E_SBEX_SB_NAME}, cmd=${_E2E_SBEX_CMD[0]:-?}; classifier=gateway-transient)" >&2
  fi
  return "${rc}"
}

# e2e_sandbox_exec_stdin <sandbox> -- <cmd> [args...]
# Pipes the caller's stdin into the sandbox command. Safe for secrets:
# stdin bytes are handed to the child process without shell-level
# interpolation.
e2e_sandbox_exec_stdin() {
  _e2e_sbex_parse "$@" || return $?
  e2e_env_trace "sandbox:exec_stdin" "${_E2E_SBEX_SB_NAME}" "${_E2E_SBEX_CMD[*]}"
  if ! command -v openshell >/dev/null 2>&1; then
    echo "e2e_sandbox_exec_stdin: openshell CLI not on PATH" >&2
    return 127
  fi
  local timeout_cmd seconds="${E2E_SANDBOX_EXEC_TIMEOUT_SECONDS}"
  timeout_cmd="$(_e2e_sbex_resolve_timeout_cmd)"
  if [[ -z "${timeout_cmd}" ]]; then
    echo "e2e_sandbox_exec_stdin: 'timeout' not available; running without per-call cap (sandbox=${_E2E_SBEX_SB_NAME})" >&2
    openshell sandbox exec --name "${_E2E_SBEX_SB_NAME}" -- "${_E2E_SBEX_CMD[@]}"
    return $?
  fi
  local rc=0
  "${timeout_cmd}" --kill-after=5s "${seconds}" \
    openshell sandbox exec --name "${_E2E_SBEX_SB_NAME}" -- "${_E2E_SBEX_CMD[@]}"
  rc=$?
  if [[ "${rc}" -eq 124 || "${rc}" -eq 137 ]]; then
    echo "e2e_sandbox_exec_stdin: openshell sandbox exec hung after ${seconds}s (sandbox=${_E2E_SBEX_SB_NAME}, cmd=${_E2E_SBEX_CMD[0]:-?}; classifier=gateway-transient)" >&2
  fi
  return "${rc}"
}
