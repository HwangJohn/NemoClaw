// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type PhaseName = "environment" | "onboarding" | "runtime";

// Synthetic phase appended by the scenario runner when a scenario
// declares plan.expectedFailure. Distinct from PhaseName so a scenario
// builder cannot accidentally declare an assertion or action against
// it. Only the runner emits PhaseResult entries with this name.
export type NegativeContractPhase = "negative-contract";

export type PhaseResultName = PhaseName | NegativeContractPhase;

// User-facing phase the negative-scenario contract advertises. Wider
// than PhaseName because manifests may declare "preflight" failures,
// which the matcher resolves to the onboarding phase orchestrator.
export type ExpectedFailurePhase = PhaseName | "preflight";

export interface ExpectedFailureContract {
  phase: ExpectedFailurePhase;
  errorClass: string;
  forbiddenSideEffects?: readonly string[];
}

export type TransientClassifier =
  | "empty-event-capture"
  | "provider-transient"
  | "gateway-transient"
  | "external-tunnel"
  | "model-toolcall-transient"
  | "runner-infra"
  | "wrong-installed-ref";

export interface SutBoundary {
  id: "host-cli" | "gateway" | "sandbox" | "agent" | "provider" | "state";
  client: string;
}

export interface NemoClawInstanceManifest {
  apiVersion: "nemoclaw.io/v1";
  kind: "NemoClawInstance";
  metadata: {
    name: string;
  };
  spec: {
    setup: {
      install: Record<string, unknown>;
      runtime: Record<string, unknown>;
      platform: Record<string, unknown>;
    };
    onboarding: {
      agent: string;
      provider: string;
      modelRoute?: string;
      policyTier?: string;
      messaging?: string[];
      features?: Record<string, unknown>;
      lifecycle?: string;
      gateway?: Record<string, unknown>;
    };
    state?: {
      workspaceRef?: string;
      credentialRefs?: string[];
      [key: string]: unknown;
    };
  };
}

export interface AssertionStepReliability {
  timeoutSeconds?: number;
  retry?: {
    attempts: number;
    on: TransientClassifier[];
  };
  productRetry?: string;
}

export interface AssertionStep {
  id: string;
  phase: PhaseName;
  description?: string;
  implementation?: {
    kind: "shell" | "probe" | "pending";
    ref: string;
  };
  evidencePath?: string;
  reliability?: AssertionStepReliability;
  // Declared parent-env keys this step requires beyond the framework's
  // allowlist. Anything not allowlisted and not declared here is
  // dropped before spawn. See orchestrators/redaction.ts. Each entry
  // must match the secret-key shape; the framework rejects non-secret
  // names to keep the allowlist-vs-declared-secret boundary honest.
  secretEnv?: readonly string[];
  // When true, a probe/pending step that resolves as "skipped" is
  // reclassified as "failed" by the phase orchestrator. Required
  // steps fail closed when their underlying implementation isn't
  // available yet (probe registry not landed, expected-failure
  // side-effect validator not implemented, ...) instead of silently
  // producing fake green. Defaults to false; set true for security-
  // sensitive suites and expected-failure validators that the run
  // is not safe without.
  required?: boolean;
}

export interface AssertionGroup {
  id: string;
  phase: PhaseName;
  description?: string;
  suiteId?: string;
  onboardingAssertionId?: string;
  migrationStatus?: "complete" | "pending";
  steps: AssertionStep[];
}

export interface ScenarioEnvironment {
  platform: string;
  install: string;
  runtime: string;
  onboarding: string;
}

export interface ScenarioDefinition {
  id: string;
  description?: string;
  manifestPath?: string;
  environment?: ScenarioEnvironment;
  assertionGroups: AssertionGroup[];
  expectedStateId?: string;
  suiteIds?: string[];
  onboardingAssertionIds?: string[];
  runnerRequirements?: string[];
  requiredSecrets?: string[];
  skippedCapabilities?: Array<Record<string, unknown>>;
  expectedFailure?: ExpectedFailureContract;
}

// A phase action is real, deterministic setup work the phase orchestrator
// performs BEFORE running its assertions: install nemoclaw, run
// onboarding, emit context.env, etc. Actions short-circuit assertions on
// failure (assertions don't run if the action they depend on failed).
//
// Spec ownership: phase orchestrators own actions. The top-level runner
// must not execute actions; clients must not embed action policy.
export interface PhaseAction {
  id: string;
  phase: PhaseName;
  description?: string;
  // "shell-fn" sources the bash dispatcher and invokes the named function.
  // "shell"    runs an executable script (used for context-emit helper).
  kind: "shell-fn" | "shell";
  // Repo-relative path to the script.
  scriptRef: string;
  // For "shell-fn": the bash function to invoke after sourcing scriptRef.
  fn?: string;
  // Single positional arg passed to the function/script (install method or
  // onboarding profile id today). Kept as a single string to keep stable
  // ids predictable; multi-arg variants can extend this later.
  arg?: string;
  // Per-action timeout. No retry by default - install/onboard must fail
  // loudly so the regression is visible. Retry stays a property of
  // assertion steps, not actions.
  timeoutSeconds?: number;
  // Repo-relative evidence log path.
  evidencePath?: string;
  // Optional stable alias the orchestrator copies the evidence log to
  // after a successful action. Lets legacy shell assertions that
  // reference well-known filenames (e.g. ${E2E_CONTEXT_DIR}/onboard.log)
  // keep working without coupling them to the action's stable id.
  aliasPath?: string;
  // Declared parent-env keys this action requires beyond the
  // framework's allowlist (PATH, HOME, E2E_*, NEMOCLAW_*, ...).
  // Anything not allowlisted and not declared here is dropped before
  // spawn. See orchestrators/redaction.ts. Each entry must match the
  // secret-key shape; the framework rejects non-secret names so the
  // allowlist-vs-declared-secret boundary stays honest. Cloud install
  // declares ["NVIDIA_API_KEY"]; slack onboarding declares the slack
  // tokens it actually needs; etc.
  secretEnv?: readonly string[];
}

export interface RunPlanPhase {
  name: PhaseName;
  actions: PhaseAction[];
  assertionGroups: AssertionGroup[];
}

export interface RunPlan {
  scenarioId: string;
  status: "skeleton" | "compiled";
  note?: string;
  manifestPath?: string;
  manifest?: NemoClawInstanceManifest;
  environment?: ScenarioEnvironment;
  expectedStateId?: string;
  suiteIds: string[];
  onboardingAssertionIds: string[];
  phases: RunPlanPhase[];
  runnerRequirements: string[];
  requiredSecrets: string[];
  skippedCapabilities: Array<Record<string, unknown>>;
  expectedFailure?: ExpectedFailureContract;
  sutBoundaries: SutBoundary[];
}

export interface RunContext {
  contextDir: string;
}

export interface AssertionResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  attempts: number;
  durationMs: number;
  classifier?: TransientClassifier;
  evidence?: string;
  message?: string;
}

export interface PhaseActionResult {
  id: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  evidence?: string;
  message?: string;
}

export interface PhaseResult {
  phase: PhaseResultName;
  status: "passed" | "failed" | "skipped";
  // Action results are recorded distinctly from assertion results so
  // failure-layer attribution stays unambiguous: a failure in actions
  // means setup never completed; assertions did not have a fair chance.
  actions: PhaseActionResult[];
  assertions: AssertionResult[];
}
