// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PhaseActionResult, PhaseResult, RunContext, RunPlan, RunPlanPhase } from "../types.ts";
import { seedContextEnv } from "./context.ts";
import { EnvironmentOrchestrator } from "./environment.ts";
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
  phase: PhaseResult["phase"];
  action: PhaseActionResult;
}

function blockingPriorResult(results: PhaseResult[]): BlockingFailure | undefined {
  // A phase action failure (real setup work didn't succeed) blocks
  // downstream phases. Assertion failures do NOT block downstream
  // phases - they are expected to be reported alongside other phase
  // results so reviewers can see all failure layers at once.
  for (const result of results) {
    const failedAction = result.actions.find((action) => action.status === "failed");
    if (failedAction) {
      return { phase: result.phase, action: failedAction };
    }
  }
  return undefined;
}
