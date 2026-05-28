// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { diagnosticsProbe } from "./diagnostics.ts";
import { docsValidationProbe } from "./docs-validation.ts";
import { lookupProbe, registerProbe } from "./registry.ts";

/**
 * Register all built-in probes. Idempotent: re-importing this module
 * (e.g. through a different entry point) is a no-op once the probes
 * are already in place.
 *
 * Ownership boundary:
 *   - Built-in probes here implement the cross-scenario contract that
 *     the typed registry already references by name (see
 *     scenarios/assertions/registry.ts).
 *   - Scenario-specific probes (if any) belong in a per-scenario
 *     module that calls `registerProbe()` directly.
 *
 * Probes intentionally NOT yet registered (probe-registry follow-up):
 *   - shieldsConfigProbe       (security; required: true)
 *   - networkPolicyProbe       (security; required: true)
 *   - injectionBlockedProbe    (security; required: true)
 *
 * Until those land, the orchestrator surfaces them as failed (not
 * skipped) because the typed registry marks them required: true.
 * That is intentional — security-sensitive suites must NEVER show
 * fake-green when their probe is missing.
 */
const BUILTIN_PROBES = {
  diagnosticsProbe,
  docsValidationProbe,
} as const;

export function registerBuiltinProbes(): void {
  for (const [name, fn] of Object.entries(BUILTIN_PROBES)) {
    if (lookupProbe(name) === undefined) {
      registerProbe(name, fn);
    }
  }
}
