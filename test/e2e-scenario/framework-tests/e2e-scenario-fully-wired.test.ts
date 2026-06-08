// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Contract test for the scenario fan-out runtime-support gate.
 *
 * Three invariants:
 *
 *   1. SUPPORTED_ONBOARDING_IDS in scenarios/runtime-support.ts matches
 *      the bash dispatcher (nemoclaw_scenarios/onboard/dispatch.sh)
 *      case statement. The dispatcher is the source of truth for what
 *      profiles can actually be invoked at runtime; the typed set must
 *      mirror it.
 *
 *   2. WORKFLOW_AVAILABLE_SECRETS matches the secrets declared in
 *      .github/workflows/e2e-scenarios.yaml AND
 *      .github/workflows/e2e-scenarios-all.yaml. A secret listed in
 *      one but not the other would still leave fan-out runs without
 *      the secret at runtime.
 *
 *   3. Every scenario emitted by buildScenarioMatrix() satisfies
 *      isScenarioFullyWired (positive sanity) and every scenario
 *      filtered out has a real reason listed (no silent drops).
 *
 * Adding a new dispatcher case or workflow secret requires updating
 * the typed sets in runtime-support.ts. Adding a new scenario whose
 * onboarding profile or required secrets are not yet plumbed will
 * NOT fail this test — the scenario stays in the registry as a
 * roadmap item but the matrix emitter skips it.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { buildScenarioMatrix } from "../scenarios/run.ts";
import { listScenarios } from "../scenarios/registry.ts";
import {
  isScenarioFullyWired,
  SUPPORTED_ONBOARDING_IDS,
  WORKFLOW_AVAILABLE_SECRETS,
} from "../scenarios/runtime-support.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DISPATCH_SH = path.join(
  REPO_ROOT,
  "test/e2e-scenario/nemoclaw_scenarios/onboard/dispatch.sh",
);
const E2E_SCENARIOS_YAML = path.join(REPO_ROOT, ".github/workflows/e2e-scenarios.yaml");
const E2E_SCENARIOS_ALL_YAML = path.join(REPO_ROOT, ".github/workflows/e2e-scenarios-all.yaml");

/**
 * Parse the dispatcher case-statement labels. Matches indented lines of
 * the form `<id>)` or `<id-a> | <id-b>)` inside the `case "${profile}"
 * in ... esac` block. Tolerates leading whitespace and `*)` default.
 */
function dispatcherProfileIds(): Set<string> {
  const source = fs.readFileSync(DISPATCH_SH, "utf8");
  const ids = new Set<string>();
  // Match e.g. `    cloud-openclaw)` or `    cloud-openclaw-invalid-nvidia-key | cloud-openclaw-gateway-port-conflict)`
  const re = /^\s+([a-z][a-z0-9-]*(?:\s*\|\s*[a-z][a-z0-9-]*)*)\)\s*$/gm;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: classic regex exec loop
  while ((match = re.exec(source)) !== null) {
    for (const id of match[1].split("|")) {
      const trimmed = id.trim();
      if (trimmed && trimmed !== "*") ids.add(trimmed);
    }
  }
  return ids;
}

/**
 * Parse the secret keys declared under any `secrets:` block in a workflow
 * YAML. Light text-level parser to avoid pulling in js-yaml just for two
 * files; the structure is stable.
 */
function workflowSecretKeys(yamlPath: string): Set<string> {
  const source = fs.readFileSync(yamlPath, "utf8");
  const keys = new Set<string>();
  const lines = source.split("\n");
  let inSecrets = false;
  let secretsIndent = -1;
  for (const line of lines) {
    if (/^\s*secrets:\s*$/.test(line)) {
      inSecrets = true;
      secretsIndent = line.search(/\S/);
      continue;
    }
    if (inSecrets) {
      if (line.trim() === "" || line.search(/\S/) <= secretsIndent) {
        // De-dent or blank line ends the block.
        if (line.search(/\S/) >= 0 && line.search(/\S/) <= secretsIndent) {
          inSecrets = false;
        }
        continue;
      }
      const m = /^\s+([A-Z][A-Z0-9_]*):/.exec(line);
      if (m) keys.add(m[1]);
    }
  }
  return keys;
}

describe("scenario runtime-support contract", () => {
  it("SUPPORTED_ONBOARDING_IDS matches dispatcher case statement", () => {
    const dispatcherIds = dispatcherProfileIds();
    // The dispatcher's negative variants (`<base>-no-docker`) live in
    // separate `*.sh` files sourced by dispatch.sh; ids that appear in
    // the case statement but represent compiler-synthesized variants
    // should also be in the typed set. Cross-check both directions.
    const typedSet = new Set(SUPPORTED_ONBOARDING_IDS);
    const missingFromTyped = [...dispatcherIds].filter((id) => !typedSet.has(id));
    const missingFromDispatcher = [...typedSet].filter((id) => !dispatcherIds.has(id));
    expect(
      missingFromTyped,
      `dispatcher routes profiles the typed set forgot: ${missingFromTyped.join(", ")}`,
    ).toEqual([]);
    expect(
      missingFromDispatcher,
      `typed set claims profiles the dispatcher does not route: ${missingFromDispatcher.join(", ")}`,
    ).toEqual([]);
  });

  it("WORKFLOW_AVAILABLE_SECRETS matches both scenario workflows", () => {
    const fromScenarios = workflowSecretKeys(E2E_SCENARIOS_YAML);
    const fromAll = workflowSecretKeys(E2E_SCENARIOS_ALL_YAML);
    const typed = new Set(WORKFLOW_AVAILABLE_SECRETS);
    expect(fromScenarios, "e2e-scenarios.yaml secrets must match typed set").toEqual(typed);
    expect(fromAll, "e2e-scenarios-all.yaml secrets must match typed set").toEqual(typed);
  });

  it("every scenario emitted by buildScenarioMatrix is fully wired", () => {
    const matrix = buildScenarioMatrix();
    const idsInMatrix = new Set(matrix.map((entry) => entry.id));
    expect(idsInMatrix.size).toBeGreaterThan(0);
    for (const scenario of listScenarios()) {
      if (!idsInMatrix.has(scenario.id)) continue;
      const wired = isScenarioFullyWired(scenario);
      expect(
        wired,
        `scenario ${scenario.id} appears in matrix but is not fully wired`,
      ).toEqual({ ok: true });
    }
  });

  it("every filtered-out scenario has a structured reason list", () => {
    const matrix = buildScenarioMatrix();
    const idsInMatrix = new Set(matrix.map((entry) => entry.id));
    const filtered = listScenarios().filter((s) => !idsInMatrix.has(s.id));
    expect(filtered.length).toBeGreaterThan(0); // Confirms the gate is actually filtering something.
    for (const scenario of filtered) {
      const wired = isScenarioFullyWired(scenario);
      if (wired.ok) {
        throw new Error(
          `scenario ${scenario.id} is fully wired but was filtered out by buildScenarioMatrix`,
        );
      }
      expect(wired.reasons.length, `${scenario.id} must have at least one reason`).toBeGreaterThan(
        0,
      );
    }
  });
});
