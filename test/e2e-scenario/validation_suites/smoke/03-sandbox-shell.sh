#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# smoke step: sandbox-shell
# Verifies that OpenShell can execute a trivial command inside the sandbox.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "smoke:sandbox-shell"
e2e_context_require E2E_SANDBOX_NAME

name="$(e2e_context_get E2E_SANDBOX_NAME)"
output="$(openshell sandbox exec --name "${name}" -- echo ok 2>&1)"
echo "${output}"
if ! echo "${output}" | grep -q '^ok$'; then
  echo "smoke:sandbox-shell: did not receive expected 'ok' from sandbox" >&2
  exit 1
fi
