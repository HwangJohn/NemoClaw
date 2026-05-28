// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HostCliClient } from "../scenarios/clients/host-cli.ts";
import { compileRunPlans } from "../scenarios/compiler.ts";
import { PhaseOrchestrator } from "../scenarios/orchestrators/phase.ts";
import { ScenarioRunner } from "../scenarios/orchestrators/runner.ts";
import type { AssertionStep, PhaseName, PhaseResult, RunContext, RunPlanPhase } from "../scenarios/types.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function freshCtx(): RunContext {
  return { contextDir: fs.mkdtempSync(path.join(os.tmpdir(), "e2e-phase-")) };
}

function shellStep(id: string, phase: PhaseName, ref: string, reliability?: AssertionStep["reliability"]): AssertionStep {
  return {
    id,
    phase,
    implementation: { kind: "shell", ref },
    evidencePath: `.e2e/assertions/${id}.log`,
    reliability,
  };
}

function probeStep(id: string, phase: PhaseName, ref = "no-such-probe"): AssertionStep {
  return {
    id,
    phase,
    implementation: { kind: "probe", ref },
    evidencePath: `.e2e/assertions/${id}.json`,
  };
}

function pendingStep(id: string, phase: PhaseName): AssertionStep {
  return {
    id,
    phase,
    implementation: { kind: "pending", ref: "not-yet" },
  };
}

function makePhase(steps: AssertionStep[]): RunPlanPhase {
  return {
    name: steps[0].phase,
    actions: [],
    assertionGroups: [{ id: `group.${steps[0].id}`, phase: steps[0].phase, migrationStatus: "complete", steps }],
  };
}

function writeTempScript(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  return p;
}

describe("phase orchestrators - top-level delegation", () => {
  it("test_should_execute_phase_assertions_from_phase_orchestrators_not_top_level_runner", async () => {
    const ctx = freshCtx();
    try {
      const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);
      const calls: string[] = [];
      const fakeOrchestrator = (phase: PhaseName) => ({
        run: async (_ctx: RunContext, runPhase: RunPlanPhase, _prior?: PhaseResult[]): Promise<PhaseResult> => {
          calls.push(runPhase.name);
          return { phase, status: "passed", assertions: [] };
        },
      });
      const runner = new ScenarioRunner({
        environment: fakeOrchestrator("environment"),
        onboarding: fakeOrchestrator("onboarding"),
        runtime: fakeOrchestrator("runtime"),
      });

      const results = await runner.run(ctx, plan);

      expect(calls).toEqual(["environment", "onboarding", "runtime"]);
      expect(results.map((result) => result.phase)).toEqual(["environment", "onboarding", "runtime"]);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });
});

describe("phase orchestrators - real shell execution", () => {
  it("shell_step_passes_when_script_exits_zero", async () => {
    const ctx = freshCtx();
    try {
      const script = writeTempScript(ctx.contextDir, "ok.sh", "echo hello-from-real-shell");
      const ref = path.relative(REPO_ROOT, script);
      const step = shellStep("runtime.real-pass", "runtime", ref);
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("passed");
      expect(result.assertions[0]).toEqual(
        expect.objectContaining({ id: "runtime.real-pass", status: "passed", attempts: 1 }),
      );
      const log = fs.readFileSync(result.assertions[0].evidence!, "utf8");
      expect(log).toContain("hello-from-real-shell");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("shell_step_fails_when_script_exits_nonzero_and_records_stderr_tail", async () => {
    const ctx = freshCtx();
    try {
      const script = writeTempScript(ctx.contextDir, "fail.sh", 'echo "boom: real failure" >&2; exit 7');
      const ref = path.relative(REPO_ROOT, script);
      const step = shellStep("runtime.real-fail", "runtime", ref);
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("failed");
      expect(result.assertions[0].status).toBe("failed");
      expect(result.assertions[0].message).toMatch(/exit 7/);
      expect(result.assertions[0].message).toMatch(/boom: real failure/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("shell_step_times_out_via_orchestrator_policy_not_script", async () => {
    const ctx = freshCtx();
    try {
      const script = writeTempScript(ctx.contextDir, "slow.sh", "sleep 30");
      const ref = path.relative(REPO_ROOT, script);
      const step = shellStep("runtime.real-timeout", "runtime", ref, { timeoutSeconds: 1 });
      const orchestrator = new PhaseOrchestrator("runtime");

      const started = Date.now();
      const result = await orchestrator.run(ctx, makePhase([step]));
      const elapsed = Date.now() - started;

      expect(result.status).toBe("failed");
      expect(result.assertions[0].message).toMatch(/exceeded 1s/);
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("shell_step_retries_on_classified_transient_then_passes", async () => {
    const ctx = freshCtx();
    try {
      const counterFile = path.join(ctx.contextDir, "counter");
      fs.writeFileSync(counterFile, "0");
      const script = writeTempScript(
        ctx.contextDir,
        "gateway-flaky.sh",
        `n=$(cat "${counterFile}"); n=$((n+1)); echo "$n" > "${counterFile}"; if [ "$n" -lt 2 ]; then echo "gateway-transient: try again" >&2; exit 1; fi; echo ok`,
      );
      const ref = path.relative(REPO_ROOT, script);
      const step = shellStep("runtime.gateway-retry", "runtime", ref, {
        retry: { attempts: 2, on: ["gateway-transient"] },
      });
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("passed");
      expect(result.assertions[0].attempts).toBe(2);
      expect(result.assertions[0].classifier).toBe("gateway-transient");
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("shell_step_fails_with_clear_message_when_script_missing", async () => {
    const ctx = freshCtx();
    try {
      const step = shellStep("runtime.missing", "runtime", "test/e2e-scenario/does-not-exist.sh");
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.status).toBe("failed");
      expect(result.assertions[0].message).toMatch(/script not found/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("probe_step_without_registered_probe_skips_visibly_never_passes_falsely", async () => {
    const ctx = freshCtx();
    try {
      const step = probeStep("runtime.probe-pending", "runtime");
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.assertions[0].status).toBe("skipped");
      expect(result.assertions[0].message).toMatch(/probe not registered/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });

  it("pending_step_skips_visibly_with_pending_marker", async () => {
    const ctx = freshCtx();
    try {
      const step = pendingStep("runtime.pending", "runtime");
      const orchestrator = new PhaseOrchestrator("runtime");

      const result = await orchestrator.run(ctx, makePhase([step]));

      expect(result.assertions[0].status).toBe("skipped");
      expect(result.assertions[0].message).toMatch(/^pending:/);
    } finally {
      fs.rmSync(ctx.contextDir, { recursive: true, force: true });
    }
  });
});

describe("clients are pass/fail/policy free", () => {
  it("test_should_keep_clients_free_of_pass_fail_and_retry_semantics", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "test/e2e-scenario/scenarios/clients/host-cli.ts"),
      "utf8",
    );
    const observation = new HostCliClient().observeVersion();

    expect(observation).toEqual(expect.objectContaining({ command: ["nemoclaw", "--version"] }));
    expect(source).not.toMatch(/AssertionResult|PhaseResult|retry|timeout|passed|failed/);
  });
});
