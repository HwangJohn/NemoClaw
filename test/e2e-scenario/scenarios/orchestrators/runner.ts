// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { PhaseActionResult, PhaseResult, RunContext, RunPlan, RunPlanPhase } from "../types.ts";
import { seedContextEnv } from "./context.ts";
import { EnvironmentOrchestrator } from "./environment.ts";
import { evaluateNegativeContract, negativeContractPhaseResult } from "./negative-matcher.ts";
import { OnboardingOrchestrator } from "./onboarding.ts";
import { RuntimeOrchestrator } from "./runtime.ts";

interface PhaseRunner {
  run(ctx: RunContext, phase: RunPlanPhase, priorResults?: PhaseResult[]): Promise<PhaseResult>;
}

export interface ScenarioRunnerDeps {
  environment?: PhaseRunner;
  onboarding?: PhaseRunner;
  runtime?: PhaseRunner;
}

export class ScenarioRunner {
  private readonly environment: PhaseRunner;
  private readonly onboarding: PhaseRunner;
  private readonly runtime: PhaseRunner;

  constructor(deps: ScenarioRunnerDeps = {}) {
    this.environment = deps.environment ?? new EnvironmentOrchestrator();
    this.onboarding = deps.onboarding ?? new OnboardingOrchestrator();
    this.runtime = deps.runtime ?? new RuntimeOrchestrator();
  }

  async run(ctx: RunContext, plan: RunPlan): Promise<PhaseResult[]> {
    // Seed context.env from the typed RunPlan once, before any phase
    // runs. Spec ownership: framework infrastructure (the runner), not
    // a shell action. Onboarding may extend context.env via
    // e2e_context_set; the runtime phase reads whatever is on disk.
    seedContextEnv(ctx, plan);

    const results: PhaseResult[] = [];
    for (const phase of plan.phases) {
      const blocked = blockingPriorResult(results);
      if (blocked) {
        // Cross-phase short-circuit: the previous phase's setup work
        // failed, so this phase cannot meaningfully run. Synthesize a
        // skipped PhaseResult with a clear reason so artifacts stay
        // honest (no false greens, no <1s assertion explosion).
        results.push({
          phase: phase.name,
          status: "skipped",
          actions: [],
          assertions: [
            {
              id: `${phase.name}.blocked`,
              status: "skipped",
              attempts: 0,
              durationMs: 0,
              message: `phase blocked by prior failure: ${blocked.phase} action ${blocked.action.id} failed (${blocked.action.message ?? "no message"})`,
            },
          ],
        });
        continue;
      }
      const orchestrator = this.orchestratorFor(phase.name);
      results.push(await orchestrator.run(ctx, phase, results));
    }

    // Negative-scenario contract verification. Single decision point:
    // if the plan declared expectedFailure, evaluate the matcher and
    // append a synthetic phase result. Positive scenarios are
    // unaffected. Side-effect verification stays the responsibility of
    // the runtime control group's required pending step (kept red
    // until the probe lands); the matcher only judges phase + errorClass.
    if (plan.expectedFailure) {
      const contractResult = evaluateNegativeContract(plan, results);
      const synthetic = negativeContractPhaseResult(contractResult);
      results.push(synthetic);
      writeNegativeContractArtifact(ctx, contractResult, synthetic);
    }

    return results;
  }

  private orchestratorFor(name: RunPlanPhase["name"]): PhaseRunner {
    if (name === "environment") return this.environment;
    if (name === "onboarding") return this.onboarding;
    if (name === "runtime") return this.runtime;
    throw new Error(`Unsupported phase: ${String(name)}`);
  }
}

interface BlockingFailure {
  phase: "environment" | "onboarding" | "runtime";
  action: PhaseActionResult;
}

function writeNegativeContractArtifact(
  ctx: RunContext,
  contractResult: ReturnType<typeof evaluateNegativeContract>,
  synthetic: PhaseResult,
): void {
  try {
    const outputDir = path.join(ctx.contextDir, ".e2e");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "negative-contract.json"),
      `${JSON.stringify(contractResult, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(outputDir, `${synthetic.phase}.result.json`),
      `${JSON.stringify(synthetic, null, 2)}\n`,
    );
  } catch {
    /* artifact emission is best-effort; matcher result already in memory */
  }
}

function blockingPriorResult(results: PhaseResult[]): BlockingFailure | undefined {
  // A phase action failure (real setup work didn't succeed) blocks
  // downstream phases. Assertion failures do NOT block downstream
  // phases - they are expected to be reported alongside other phase
  // results so reviewers can see all failure layers at once.
  for (const result of results) {
    if (result.phase !== "environment" && result.phase !== "onboarding" && result.phase !== "runtime") {
      continue;
    }
    const failedAction = result.actions.find((action) => action.status === "failed");
    if (failedAction) {
      return { phase: result.phase, action: failedAction };
    }
  }
  return undefined;
}
