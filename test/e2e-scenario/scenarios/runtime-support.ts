// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-support contract for typed scenarios.
 *
 * The typed scenario registry (`scenarios/scenarios/baseline.ts`) declares
 * scenarios for every product surface, including ones whose onboarding
 * profiles or required secrets are not yet wired through the bash
 * dispatcher (`nemoclaw_scenarios/onboard/dispatch.sh`), the compiler
 * secret allowlist (`scenarios/compiler.ts:ONBOARD_PROFILE_SECRET_ENV`),
 * or the workflow secret declarations
 * (`.github/workflows/e2e-scenarios{,-all}.yaml`).
 *
 * Live fan-out via `e2e-scenarios-all.yaml` would otherwise dispatch
 * every registered scenario, and the unsupported ones would either:
 *   1. fail at onboarding with `e2e_onboard: unsupported onboarding
 *      profile: <name>` (Mode A failure mode), or
 *   2. run without the credential boundary the registry declares.
 *
 * `isScenarioFullyWired` is the gate. It is consumed by:
 *   - `buildScenarioMatrix()` in `run.ts` to filter `--emit-matrix`.
 *   - `e2e-scenario-fully-wired.test.ts` to lock the contract: every
 *     scenario that survives the filter must also be routable by the
 *     bash dispatcher and have its requiredSecrets covered by the
 *     workflow secret allowlist.
 *
 * Adding a new scenario whose profile is not in `SUPPORTED_ONBOARDING_IDS`
 * is fine — it stays in the registry for documentation and future
 * implementation, but the matrix emitter will skip it until the
 * dispatcher case + secret plumbing land.
 */

import type { ScenarioDefinition } from "./types.ts";

/**
 * Onboarding-profile ids the bash dispatcher
 * (test/e2e-scenario/nemoclaw_scenarios/onboard/dispatch.sh) currently
 * routes to a worker. Mirrors the dispatcher's case statement plus the
 * `<base>-no-docker` variants the compiler synthesizes for negative
 * scenarios with `runtime: "docker-missing"`.
 *
 * Lock-checked by `e2e-scenario-fully-wired.test.ts` against the
 * dispatcher source — the test fails if the two ever drift.
 */
export const SUPPORTED_ONBOARDING_IDS: ReadonlySet<string> = new Set([
  "cloud-openclaw",
  "cloud-openclaw-no-docker",
  "cloud-openclaw-custom-policies",
  "cloud-openclaw-invalid-nvidia-key",
  "cloud-openclaw-gateway-port-conflict",
  "cloud-hermes",
  "local-ollama-openclaw",
]);

/**
 * Secrets the scenario workflows
 * (.github/workflows/e2e-scenarios.yaml + e2e-scenarios-all.yaml) pass
 * through to runs. Lock-checked by `e2e-scenario-fully-wired.test.ts`
 * against the workflow YAML.
 *
 * Adding a secret here without also declaring it in the workflow
 * widens the scenario fan-out surface but the new scenarios still
 * won't actually have the secret at runtime. The test catches that.
 */
export const WORKFLOW_AVAILABLE_SECRETS: ReadonlySet<string> = new Set([
  "NVIDIA_API_KEY",
]);

/**
 * Compute the onboarding-profile id the compiler will actually invoke
 * for a scenario. Mirrors the runtime-rewrite logic in
 * `compiler.ts:phaseActions` for the onboarding phase: scenarios with
 * `runtime: "docker-missing"` swap their base profile for the
 * `<base>-no-docker` worker.
 *
 * Kept out of compiler.ts so runtime-support can import it without
 * pulling in the full compiler graph.
 */
export function effectiveOnboardingId(scenario: ScenarioDefinition): string | null {
  const env = scenario.environment;
  if (!env) return null;
  const base = env.onboarding;
  if (!base) return null;
  return env.runtime === "docker-missing" ? `${base}-no-docker` : base;
}

export type WiredCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * Decide whether a scenario can actually run end-to-end given the
 * current dispatcher and workflow plumbing. Returns the structured
 * reason list when not wired, so the matrix emitter can log a
 * scenario-by-scenario explanation of what was skipped and why.
 */
export function isScenarioFullyWired(scenario: ScenarioDefinition): WiredCheck {
  const reasons: string[] = [];

  const onboarding = effectiveOnboardingId(scenario);
  if (onboarding === null) {
    reasons.push("scenario has no environment.onboarding");
  } else if (!SUPPORTED_ONBOARDING_IDS.has(onboarding)) {
    reasons.push(
      `onboarding profile '${onboarding}' has no case in nemoclaw_scenarios/onboard/dispatch.sh`,
    );
  }

  const required = scenario.requiredSecrets ?? [];
  const missing = required.filter((secret) => !WORKFLOW_AVAILABLE_SECRETS.has(secret));
  if (missing.length > 0) {
    reasons.push(
      `required secret(s) not declared in workflow: ${missing.join(", ")}`,
    );
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
