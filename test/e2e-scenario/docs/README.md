<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E

End-to-end tests organized around **setup scenarios** rather than
one-off shell scripts. A scenario declares *how you got to a working
NemoClaw* (platform + install + runtime + onboarding); a scenario
resolves to an **expected state** contract; once that state validates,
one or more **suites** run functional assertions against it.

```text
setup scenario → expected state → suite sequence
```

The declarative sources of truth live in three files — read these
first, they are short and deliberately not redundant with prose:

- [`../nemoclaw_scenarios/scenarios.yaml`](../nemoclaw_scenarios/scenarios.yaml)
  — platforms, installs, runtimes, onboarding choices, and the
  concrete scenarios that combine them.
- [`../scenarios/expected-states.ts`](../scenarios/expected-states.ts)
  — typed registry of reusable structural contracts (gateway health,
  sandbox status, inference routing, etc.). Single source of truth
  since the legacy YAML resolver was retired.

- [`../validation_suites/suites.yaml`](../validation_suites/suites.yaml)
  — ordered validation steps, each with a `requires_state` predicate.

This hybrid model is transitional. The target architecture for #3588 is a
single scenario runner that owns scenario resolution, orchestration, evidence
collection, redaction, and assertion dispatch. Shell scripts should be kept to
the smallest practical set of system-boundary probes or command fixtures, not a
second planning or assertion-control runtime.

## Current sources of truth

Use the source that matches the task while the migration is in progress:

| Task | Current source |
| --- | --- |
| Scenario workflow fan-out and live execution | `test/e2e-scenario/scenarios/registry.ts`, `test/e2e-scenario/scenarios/scenarios/baseline.ts`, and `test/e2e-scenario/scenarios/run.ts` |
| Typed expected-state registry (single source of truth) | `test/e2e-scenario/scenarios/expected-states.ts` |
| Product-facing desired setup/onboarding state | `test/e2e-scenario/manifests/*.yaml` |
| Reusable live suite assertions | `test/e2e-scenario/validation_suites/` |
| Existing nightly and platform E2E coverage | legacy `test/e2e/test-*.sh` scripts and their workflows |

The near-term migration goal is to keep these surfaces aligned while coverage is
being moved into scenario contracts and suites. The long-term goal is to remove
the split between typed planning and shell execution. The legacy YAML resolver
under `runtime/resolver/` and `nemoclaw_scenarios/expected-states.yaml` have
been retired; the typed registry is the single source of truth for expected
states. Do not add new legacy-style `test/e2e/test-*.sh` entrypoints unless
there is a specific maintainer-approved reason.

## Target runner model

Future scenario coverage should move toward one runner with these properties:

- the runner compiles one typed plan for each scenario and treats that plan as
  the source of truth for setup, onboarding, expected state, suites, assertions,
  evidence paths, and expected failures;
- product-facing manifests remain declarative setup inputs, not executable test
  programs;
- assertion modules prefer TypeScript probes and typed client helpers;
- shell is used only when the system under test is a shell command, host
  process, container command, or platform-specific probe;
- every shell call goes through a controlled spawn boundary with scoped
  environment, timeout, redaction, artifact capture, and command/argument
  validation;
- bridge work that expands the YAML/bash runner must also identify how that
  behavior will move into the single runner before legacy runner paths are
  removed.

The #4347-#4357 audit-phase issues should be read as acceptance coverage
requirements, not as a permanent requirement to keep YAML resolver or bash
runner deliverables. If a phase issue names YAML or shell-runner artifacts, map
that requirement to equivalent single-runner behavior unless maintainers
explicitly decide to keep a bridge path for the current migration step.

## Layered scenario model

The E2E source of truth is layered as base environment, onboarding profile,
test plan, expected state, and post-onboard suites. Test plans can also declare
onboarding assertions that run after install/onboard and before expected-state
validation.

The typed TS runner enforces the contract by inserting a dedicated
`state-validation` phase between onboarding and runtime. Probe actions
are emitted from the typed expected-state registry
(`scenarios/expected-states.ts`, mirrored to
`nemoclaw_scenarios/expected-states.yaml` during transition):

- `cli-installed`, `gateway-healthy`, `sandbox-running` for ready states.
- `gateway-absent`, `sandbox-absent` for negative/preflight-failure states.

A failed probe is a phase-action failure; the runner short-circuits
the runtime phase rather than running suite assertions against a
missing or wedged environment. An onboarding-phase failure does NOT
block state-validation — negative scenarios depend on absent-state
probes running after the deliberate onboarding failure to verify
forbidden side effects (gateway/sandbox left behind) did not occur.

The target single runner should collapse the legacy parallel YAML expressions
(`base_scenarios`, `onboarding_profiles`, `test_plans`, `setup_scenarios`,
`onboarding_assertions`) into the single executable typed plan model above.

## How to run

The TypeScript runner is the only supported entrypoint. There is one
execution mode: live. There is no `--dry-run`, no `--validate-only`, no
fake-pass code path. Plan output is emitted as a side effect of the
live run.

```bash
npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id[,id...]>     # live execution (the only mode)
npx tsx test/e2e-scenario/scenarios/run.ts --list                       # list canonical scenario ids
npx tsx test/e2e-scenario/scenarios/run.ts --emit-matrix                # JSON registry payload for CI matrix fan-out
npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id> --plan-only # local debug only; MUST NOT appear in any workflow
bash test/e2e-scenario/runtime/coverage-report.sh                       # Markdown matrix of scenario × suite
```

The deprecated bash entrypoints `runtime/run-scenario.sh` and
`runtime/run-suites.sh` exist only as fail-fast stubs; they print a
pointer at `run.ts` and exit non-zero.

Override the runtime context dir with `E2E_CONTEXT_DIR=<path>` (default
`.e2e/`, gitignored). The scenario runner and suites communicate only
through `$E2E_CONTEXT_DIR/context.env` — suites do not rediscover
setup state.

## Where things live

```text
test/e2e/
  docs/                              # README.md, MIGRATION.md
  nemoclaw_scenarios/                # declarative scenario inputs + setup machinery
    scenarios.yaml / expected-states.yaml
    install/       # install dispatcher + one file per install profile
    onboard/       # onboard dispatcher + one file per onboarding profile
    fixtures/      # reusable stubs (fake-openai, fake-{telegram,discord,slack}, older-base-image)
    helpers/       # scenario-side shell utilities (e.g. emit-context-from-plan.sh)
  validation_suites/                 # suite definitions and outcome assertions
    suites.yaml
    sandbox-exec.sh
    assert/        # outcome assertions (inference, credentials, policy, messaging)
    smoke/ inference/ hermes/ platform/ security/   # suite scripts grouped by concern
  runtime/                           # entry points + cross-cutting shared libs
    run-scenario.sh / run-suites.sh    # DEPRECATED fail-fast stubs (see above)
    coverage-report.sh
    resolver/      # TypeScript: load, plan, validate, coverage (invoked via tsx)
    lib/           # shared shell helpers: context, env, cleanup, logging, artifacts, sandbox-teardown
```

The CI entry point is `.github/workflows/e2e-scenarios.yaml` (manual dispatch). Existing legacy workflows (`nightly-e2e.yaml`, `macos-e2e.yaml`, `wsl-e2e.yaml`, etc.) remain in place during the migration.

Migration status is tracked outside the repository in GitHub issues and pull requests, not in repo-local checklists. The parent architecture issue is #3588. Do not add a workflow-level parity report or assertion-ledger gate; use focused code review, framework tests, and the scenario coverage report to decide what to migrate next.

## How to add a scenario, state, or suite

Add-a-scenario, add-a-state, and add-a-suite are short edits to the
three YAML files above, plus shell scripts under
`nemoclaw_scenarios/install/`, `nemoclaw_scenarios/onboard/`,
`validation_suites/assert/`, or `validation_suites/<category>/`. The
typed contracts in
[`../scenarios/types.ts`](../scenarios/types.ts) and
[`../scenarios/expected-states.ts`](../scenarios/expected-states.ts)
describe the required shape; `npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id> --plan-only`
validates your change without running anything destructive.

When adding a suite assertion, emit or preserve a stable `PASS: <id>` /
`FAIL: <id>` log line, and update migration coverage through the scenario coverage report and the domain issues under `#3588`. Sandbox lifecycle assertions should use `validation_suites/lib/sandbox_lifecycle.sh`, consume `$E2E_CONTEXT_DIR/context.env`, and keep destructive snapshot restore checks isolated in the opt-in `snapshot-lifecycle` suite. Platform-specific scenarios such as GPU, macOS, WSL, Brev, or DGX Spark must also list `runner_requirements` in `scenarios.yaml`.

Prefer new scenario-matrix coverage over new legacy-style `test-*.sh` scripts.
