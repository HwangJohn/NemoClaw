// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 9: Additional Scenario Families - resolver-level metadata only.
 *
 * Plan-printout tests that exercised the deprecated bash entrypoint
 * (run-scenario.sh --plan-only) were deleted alongside the bash runner.
 * The TS runner is exercised by e2e-plan-compiler / e2e-scenario-registry
 * / e2e-phase-orchestrators tests instead.
 */

import { describe, it, expect } from "vitest";
import path from "node:path";

import { loadMetadataFromDir } from "../runtime/resolver/load.ts";
import { resolveScenario } from "../runtime/resolver/plan.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_DIR = path.join(REPO_ROOT, "test/e2e-scenario");

describe("Issue 3812: inference/provider suite families", () => {
  it("test_should_route_inference_suite_families_to_domain_specific_steps", () => {
    const { suites } = loadMetadataFromDir(E2E_DIR);
    for (const family of ["inference-routing", "inference-switch", "kimi-compatibility", "ollama-auth-proxy", "model-router"]) {
      const scripts = suites.suites[family]?.steps?.map((step) => step.script ?? "") ?? [];
      expect(scripts.length, family).toBeGreaterThan(0);
      expect(scripts.every((script) => script.startsWith("inference/")), family).toBe(true);
      expect(scripts.some((script) => !script.startsWith("inference/cloud/")), family).toBe(true);
    }
  });
});

describe("Phase 9: additional scenario families - metadata", () => {
  it("resolver should resolve all new scenarios", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const ids = [
      "macos-repo-cloud-openclaw",
      "wsl-repo-cloud-openclaw",
      "gpu-repo-local-ollama-openclaw",
      "brev-launchable-cloud-openclaw",
      "ubuntu-repo-cloud-hermes",
      "ubuntu-no-docker-preflight-negative",
    ];
    for (const id of ids) {
      const plan = resolveScenario(id, meta);
      expect(plan.scenario_id).toBe(id);
      expect(plan.expected_state.id).toBeTypeOf("string");
      expect(Array.isArray(plan.suites)).toBe(true);
    }
  });
});

describe("Phase 9: Brev launchable scenario (overrides schema)", () => {
  it("should_support_scenario_overrides_on_brev_launchable", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const plan = resolveScenario("brev-launchable-cloud-openclaw", meta);
    expect(plan.overrides).toBeTruthy();
    const overrides = plan.overrides as {
      onboarding?: { gateway?: { bind_address?: string } };
    };
    expect(overrides?.onboarding?.gateway?.bind_address).toBeTypeOf("string");
    expect(overrides?.onboarding?.gateway?.bind_address?.length).toBeGreaterThan(0);
  });
});

describe("Phase 9: negative preflight", () => {
  it("should_define_preflight_failure_no_sandbox_state", () => {
    const meta = loadMetadataFromDir(E2E_DIR);
    const es = meta.expectedStates.expected_states["preflight-failure-no-sandbox"] as
      | {
          gateway?: { expected?: string };
          sandbox?: { expected?: string };
          failure?: { expected?: boolean };
        }
      | undefined;
    expect(es, "preflight-failure-no-sandbox should be defined").toBeTruthy();
    expect(es?.gateway?.expected).toBe("absent");
    expect(es?.sandbox?.expected).toBe("absent");
    expect(es?.failure?.expected).toBe(true);
  });
});
