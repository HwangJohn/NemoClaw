// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";

import { compileRunPlans } from "../scenarios/compiler.ts";
import {
  getExpectedState,
  listExpectedStates,
  probesForState,
  requireExpectedState,
} from "../scenarios/expected-states.ts";
import { ScenarioRunner } from "../scenarios/orchestrators/runner.ts";
import { listScenarios } from "../scenarios/registry.ts";
import type { ExpectedState, PhaseName, PhaseResult, RunContext, RunPlanPhase } from "../scenarios/types.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STATES_YAML_PATH = path.join(
  REPO_ROOT,
  "test/e2e-scenario/nemoclaw_scenarios/expected-states.yaml",
);

function freshCtx(): RunContext {
  return { contextDir: fs.mkdtempSync(path.join(os.tmpdir(), "e2e-state-")) };
}

describe("typed expected-state registry mirrors expected-states.yaml", () => {
  it("typed registry covers every YAML expected_state id", () => {
    const yamlDoc = yaml.load(fs.readFileSync(STATES_YAML_PATH, "utf8")) as {
      expected_states: Record<string, unknown>;
    };
    const yamlIds = Object.keys(yamlDoc.expected_states).sort();
    const typedIds = listExpectedStates()
      .map((s) => s.id)
      .sort();
    expect(typedIds).toEqual(yamlIds);
  });

  it("structural cli/gateway/sandbox dimensions match the YAML for each shared id", () => {
    const yamlDoc = yaml.load(fs.readFileSync(STATES_YAML_PATH, "utf8")) as {
      expected_states: Record<string, Record<string, Record<string, unknown>>>;
    };
    for (const state of listExpectedStates()) {
      const yamlEntry = yamlDoc.expected_states[state.id];
      expect(yamlEntry, `YAML entry for ${state.id}`).toBeTruthy();
      // cli.installed
      if (state.cli?.installed !== undefined) {
        expect(yamlEntry.cli?.installed).toBe(state.cli.installed);
      }
      // gateway.expected
      if (state.gateway) {
        expect(yamlEntry.gateway?.expected).toBe(state.gateway.expected);
        if (state.gateway.health) {
          expect(yamlEntry.gateway?.health).toBe(state.gateway.health);
        }
      }
      // sandbox.expected
      if (state.sandbox) {
        expect(yamlEntry.sandbox?.expected).toBe(state.sandbox.expected);
        if (state.sandbox.status) {
          expect(yamlEntry.sandbox?.status).toBe(state.sandbox.status);
        }
        if (state.sandbox.agent) {
          expect(yamlEntry.sandbox?.agent).toBe(state.sandbox.agent);
        }
      }
    }
  });

  it("requireExpectedState throws on unknown id with available list", () => {
    expect(() => requireExpectedState("does-not-exist")).toThrow(/Unknown expected_state/);
  });

  it("getExpectedState returns the state for known ids", () => {
    expect(getExpectedState("cloud-openclaw-ready")?.id).toBe("cloud-openclaw-ready");
  });
});

describe("probesForState maps typed expected-state into probe ids", () => {
  it("ready cloud state emits cli-installed, gateway-healthy, sandbox-running", () => {
    expect(probesForState(requireExpectedState("cloud-openclaw-ready"))).toEqual([
      "cli-installed",
      "gateway-healthy",
      "sandbox-running",
    ]);
  });

  it("preflight-failure state emits cli-installed, gateway-absent, sandbox-absent", () => {
    expect(probesForState(requireExpectedState("preflight-failure-no-sandbox"))).toEqual([
      "cli-installed",
      "gateway-absent",
      "sandbox-absent",
    ]);
  });

  it("optional-dimension state emits cli-installed only", () => {
    expect(probesForState(requireExpectedState("macos-cli-ready-docker-optional"))).toEqual([
      "cli-installed",
    ]);
  });

  it("inference and credentials probes are intentionally NOT emitted yet", () => {
    // The typed registry declares inference.expected=available and
    // credentials.expected=present for ready states; the compiler does
    // not yet emit probe actions for those dimensions because the
    // probe scripts aren't written. This test pins that gap so a
    // future probe-script PR is forced to update probesForState too.
    const state: ExpectedState = {
      id: "synthetic",
      inference: { expected: "available", provider: "nvidia" },
      credentials: { expected: "present" },
    };
    expect(probesForState(state)).toEqual([]);
  });
});

describe("compiler emits state-validation phase actions from expected-state registry", () => {
  it("positive scenario gets cli-installed + gateway-healthy + sandbox-running probe actions", () => {
    const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
    const stateValidationPhase = plan.phases.find((p) => p.name === "state-validation");
    expect(stateValidationPhase).toBeTruthy();
    expect(stateValidationPhase!.actions.map((a) => a.id)).toEqual([
      "state-validation.cli-installed",
      "state-validation.gateway-healthy",
      "state-validation.sandbox-running",
    ]);
    // Probes are typed shell-fn actions that go through the shared
    // dispatcher; the orchestrator owns timeouts and redaction.
    for (const action of stateValidationPhase!.actions) {
      expect(action.kind).toBe("shell-fn");
      expect(action.fn).toBe("e2e_state_probe");
      expect(action.scriptRef).toBe(
        "test/e2e-scenario/nemoclaw_scenarios/probes/dispatch.sh",
      );
      expect(action.timeoutSeconds).toBe(30);
    }
  });

  it("negative scenario gets cli-installed + gateway-absent + sandbox-absent probe actions", () => {
    const [plan] = compileRunPlans(["ubuntu-no-docker-preflight-negative"]);
    const stateValidationPhase = plan.phases.find((p) => p.name === "state-validation");
    expect(stateValidationPhase).toBeTruthy();
    expect(stateValidationPhase!.actions.map((a) => a.id)).toEqual([
      "state-validation.cli-installed",
      "state-validation.gateway-absent",
      "state-validation.sandbox-absent",
    ]);
  });

  it("compiler hard-errors on a scenario referencing an unknown expected_state id", () => {
    expect(() =>
      compileRunPlans([
        {
          id: "synthetic-unknown-state",
          assertionGroups: [],
          expectedStateId: "definitely-not-a-state",
        },
      ]),
    ).toThrow(/unknown expected_state/);
  });

  it("phase order is environment -> onboarding -> state-validation -> runtime", () => {
    const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
    expect(plan.phases.map((p) => p.name)).toEqual([
      "environment",
      "onboarding",
      "state-validation",
      "runtime",
    ]);
  });
});

describe("ScenarioRunner short-circuit semantics around state-validation", () => {
  it("onboarding action failure does NOT block state-validation (negative scenarios verify absent state)", async () => {
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-no-docker-preflight-negative"]);
      const phase = (
        name: PhaseName,
        outcome: PhaseResult,
      ): { run: (ctx: RunContext, p: RunPlanPhase) => Promise<PhaseResult> } => ({
        run: async () => outcome,
      });

      let stateValidationCalled = false;
      let runtimeCalled = false;
      const runner = new ScenarioRunner({
        environment: phase("environment", {
          phase: "environment",
          status: "passed",
          actions: [],
          assertions: [],
        }),
        onboarding: phase("onboarding", {
          phase: "onboarding",
          status: "failed",
          actions: [
            {
              id: "onboarding.profile.cloud-openclaw-no-docker",
              status: "failed",
              durationMs: 1,
              message: "preflight detected docker-missing",
            },
          ],
          assertions: [],
        }),
        stateValidation: {
          run: async () => {
            stateValidationCalled = true;
            return {
              phase: "state-validation",
              status: "passed",
              actions: [],
              assertions: [],
            };
          },
        },
        runtime: {
          run: async () => {
            runtimeCalled = true;
            return { phase: "runtime", status: "passed", actions: [], assertions: [] };
          },
        },
      });

      const results = await runner.run(ctx, plan);
      expect(stateValidationCalled).toBe(true);
      expect(runtimeCalled).toBe(false);
      // state-validation has its real result; runtime is skipped with
      // the blocking-action message.
      const stateRes = results.find((r) => r.phase === "state-validation")!;
      expect(stateRes.status).toBe("passed");
      const runtimeRes = results.find((r) => r.phase === "runtime")!;
      expect(runtimeRes.status).toBe("skipped");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("environment action failure blocks state-validation AND runtime", async () => {
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      let stateValidationCalled = false;
      let runtimeCalled = false;
      const runner = new ScenarioRunner({
        environment: {
          run: async () => ({
            phase: "environment",
            status: "failed",
            actions: [
              {
                id: "environment.install.repo-current",
                status: "failed",
                durationMs: 1,
                message: "install dispatcher exit 1",
              },
            ],
            assertions: [],
          }),
        },
        onboarding: {
          run: async () => ({ phase: "onboarding", status: "passed", actions: [], assertions: [] }),
        },
        stateValidation: {
          run: async () => {
            stateValidationCalled = true;
            return {
              phase: "state-validation",
              status: "passed",
              actions: [],
              assertions: [],
            };
          },
        },
        runtime: {
          run: async () => {
            runtimeCalled = true;
            return { phase: "runtime", status: "passed", actions: [], assertions: [] };
          },
        },
      });
      await runner.run(ctx, plan);
      expect(stateValidationCalled).toBe(false);
      expect(runtimeCalled).toBe(false);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("state-validation action failure blocks runtime", async () => {
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      let runtimeCalled = false;
      const runner = new ScenarioRunner({
        environment: {
          run: async () => ({ phase: "environment", status: "passed", actions: [], assertions: [] }),
        },
        onboarding: {
          run: async () => ({ phase: "onboarding", status: "passed", actions: [], assertions: [] }),
        },
        stateValidation: {
          run: async () => ({
            phase: "state-validation",
            status: "failed",
            actions: [
              {
                id: "state-validation.gateway-healthy",
                status: "failed",
                durationMs: 1,
                message: "gateway unreachable at http://127.0.0.1:18789",
              },
            ],
            assertions: [],
          }),
        },
        runtime: {
          run: async () => {
            runtimeCalled = true;
            return { phase: "runtime", status: "passed", actions: [], assertions: [] };
          },
        },
      });
      const results = await runner.run(ctx, plan);
      expect(runtimeCalled).toBe(false);
      const runtimeRes = results.find((r) => r.phase === "runtime")!;
      expect(runtimeRes.status).toBe("skipped");
      expect(runtimeRes.assertions[0].message).toMatch(/state-validation\.gateway-healthy/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });
});

describe("expected-state registry covers every scenario referenced in the typed registry", () => {
  it("every ScenarioDefinition.expectedStateId resolves in the typed expected-state registry", () => {
    const referenced = new Set<string>();
    for (const scenario of listScenarios()) {
      if (scenario.expectedStateId) {
        referenced.add(scenario.expectedStateId);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(getExpectedState(id), `expected_state '${id}' must be in the typed registry`).toBeDefined();
    }
  });
});
