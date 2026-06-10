// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../framework/availability-env.ts";
import { expect, test } from "../framework/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../framework/live-project-gate.ts";

// Migrated from test/e2e/test-onboard-resume.sh — regression for #446.
//
// Disruption-recovery shape: drives the real `nemoclaw onboard` CLI through
// the deterministic E2E failure-injection hook
// (NEMOCLAW_E2E_FAILURE_INJECTION + NEMOCLAW_E2E_FORCE_FAIL_AT_STEP), then
// invokes `nemoclaw onboard --resume --non-interactive` with NVIDIA_API_KEY
// stripped from the environment to prove the credential is hydrated from the
// onboard session file.
//
// Free-standing per #5049/#5107 precedent: the steady-state expected-state
// probe model in expected-states.ts does not capture log-grep contracts
// ("[resume] Skipping preflight (cached)") or the JSON-shape of an interrupted
// onboard session. Asserts inline, helpers-not-bridges.
//
// The legacy bash workflow (`onboard-resume-e2e` in nightly-e2e.yaml) is kept
// untouched per epic #5098 suite-separation rule until typed coverage soaks.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SESSION_FILE = path.join(os.homedir(), ".nemoclaw", "onboard-session.json");
const REGISTRY_FILE = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-resume";

// 15 minutes per onboard run; matches NEMOCLAW_E2E_DEFAULT_TIMEOUT in the
// legacy bash test (`export NEMOCLAW_E2E_DEFAULT_TIMEOUT=600` is per-step;
// the full onboard sequence dominates).
const ONBOARD_TIMEOUT_MS = 15 * 60_000;

interface SessionStateInterrupted {
  status: "failed";
  lastCompletedStep: "openclaw";
  failure: { step: "policies" };
}

interface SessionStateComplete {
  status: "complete";
  provider: "nvidia-prod";
  steps: Record<
    | "preflight"
    | "gateway"
    | "sandbox"
    | "provider_selection"
    | "inference"
    | "openclaw"
    | "policies",
    { status: "complete" }
  >;
}

function readSession<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

// Gate the test on NEMOCLAW_RUN_E2E_SCENARIOS=1 so it only runs under the
// `e2e-scenarios-live` Vitest project (dispatched by the
// onboard-resume-vitest workflow job). The `cli` project's glob
// `test/**/*.test.{js,ts}` would otherwise pick this file up in cli-test-shards
// where there's no real `openshell` CLI, no Docker daemon, and no
// NVIDIA_API_KEY — producing a guaranteed ENOENT/skip noise. Mirrors the
// gate enforced by the `e2e-scenarios-live` project's `include:` glob in
// vitest.config.ts; live-only tests opt in to that gate explicitly.
test.skipIf(!shouldRunLiveE2EScenarios())(
  "onboard-resume: interrupted onboard then --resume completes without redoing cached steps",
  async ({ artifacts, cleanup, host, sandbox, secrets }) => {
    // ──────────────────────────────────────────────────────────────────
    // Phase 1: prerequisites (host-side, all faithful on ubuntu-latest)
    // ──────────────────────────────────────────────────────────────────

    // Assertion: cli-built — `bin/nemoclaw.js` exists in the repo checkout.
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      `bin/nemoclaw.js missing — ensure the workflow runs npm ci + npm run build:cli before this test`,
    ).toBe(true);

    // Assertion: docker-running — `docker info` exits 0. Pass framework
    // allowlist env (includes PATH, HOME, etc.) so spawn can locate `docker`.
    // The shell-probe boundary defaults to no env inheritance; framework spawns
    // must opt in via buildAvailabilityProbeEnv() to keep secret-passthrough
    // explicit (NVIDIA_API_KEY is NOT in the allowlist; we layer it explicitly
    // in Phase 2 below).
    const dockerInfo = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(dockerInfo.exitCode, dockerInfo.stderr).toBe(0);

    // Assertion: openshell-installed — openshell CLI is on PATH (installed by
    // the workflow's `bash install.sh` step before this test runs).
    const openshellVersion = await host.command("openshell", ["--version"], {
      artifactName: "prereq-openshell-version",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    expect(openshellVersion.exitCode, openshellVersion.stderr).toBe(0);

    // Assertion: nvidia-api-key-present — secrets.required(...) skips the test
    // if NVIDIA_API_KEY is unset (correct behavior under workflow_dispatch
    // without the secret wired in).
    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey).toMatch(/^nvapi-/);

    // ──────────────────────────────────────────────────────────────────
    // Phase 0 (deferred): pre-cleanup of leftover sandbox/session state.
    // Done after the prereq gates pass so we don't mutate host state if
    // the test would have skipped anyway.
    // ──────────────────────────────────────────────────────────────────
    const probeEnv = buildAvailabilityProbeEnv();
    await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy",
      env: probeEnv,
      timeoutMs: 60_000,
    });
    await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "pre-cleanup-openshell-sandbox-delete",
      env: probeEnv,
      timeoutMs: 60_000,
    });
    await sandbox.openshell(["forward", "stop", "18789"], {
      artifactName: "pre-cleanup-openshell-forward-stop",
      env: probeEnv,
      timeoutMs: 30_000,
    });
    await sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "pre-cleanup-openshell-gateway-destroy",
      env: probeEnv,
      timeoutMs: 60_000,
    });
    fs.rmSync(SESSION_FILE, { force: true });

    // Register cleanup for the sandbox we are about to create. The cleanup
    // fixture runs these in LIFO at end-of-test regardless of pass/fail.
    cleanup.add(`destroy sandbox ${SANDBOX_NAME}`, async () => {
      const cleanupEnv = buildAvailabilityProbeEnv();
      await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "cleanup-nemoclaw-destroy",
        env: cleanupEnv,
        timeoutMs: 120_000,
      });
      await sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "cleanup-openshell-sandbox-delete",
        env: cleanupEnv,
        timeoutMs: 60_000,
      });
      await sandbox.openshell(["forward", "stop", "18789"], {
        artifactName: "cleanup-openshell-forward-stop",
        env: cleanupEnv,
        timeoutMs: 30_000,
      });
      await sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "cleanup-openshell-gateway-destroy",
        env: cleanupEnv,
        timeoutMs: 60_000,
      });
      fs.rmSync(SESSION_FILE, { force: true });
    });

    // ──────────────────────────────────────────────────────────────────
    // Phase 2: first onboard (forced failure at the policies step)
    // ──────────────────────────────────────────────────────────────────
    const firstRun = await host.command("node", [CLI_ENTRYPOINT, "onboard", "--non-interactive"], {
      artifactName: "phase-2-onboard-interrupted",
      env: {
        ...buildAvailabilityProbeEnv(),
        NVIDIA_API_KEY: apiKey,
        NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        NEMOCLAW_RECREATE_SANDBOX: "1",
        NEMOCLAW_POLICY_MODE: "suggested",
        NEMOCLAW_E2E_FAILURE_INJECTION: "1",
        NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: "policies",
      },
      redactionValues: [apiKey],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    });
    const firstText = `${firstRun.stdout}\n${firstRun.stderr}`;

    // Assertion: interrupted-exit-1.
    expect(firstRun.exitCode, firstText).toBe(1);

    // Assertion: sandbox-created-log.
    expect(firstText).toContain(`Sandbox '${SANDBOX_NAME}' created`);

    // Assertion: forced-failure-log — failure injection fired at the policies step.
    expect(firstText).toContain("[e2e] Forced onboarding failure at step 'policies'.");

    // Assertion: sandbox-exists-after-interrupt — `openshell sandbox get` exits 0.
    // Pass framework env so the spawn can locate `openshell` on PATH; the
    // SandboxClient threads options through to ShellProbe but does not
    // auto-supply env (mirrors HostCliClient — callers stay explicit about the
    // env boundary).
    expect(await sandbox.exists(SANDBOX_NAME, { env: buildAvailabilityProbeEnv() })).toBe(true);

    // Assertion: session-file-present.
    expect(fs.existsSync(SESSION_FILE)).toBe(true);

    // Assertion: session-file-interrupted-state.
    const interrupted = readSession<SessionStateInterrupted>(SESSION_FILE);
    await artifacts.writeJson("phase-2-session-state.json", interrupted);
    expect(interrupted.status).toBe("failed");
    expect(interrupted.lastCompletedStep).toBe("openclaw");
    expect(interrupted.failure?.step).toBe("policies");

    // ──────────────────────────────────────────────────────────────────
    // Phase 3: resume — NVIDIA_API_KEY removed from env so the resume run
    // must hydrate the credential from the session file.
    // ──────────────────────────────────────────────────────────────────
    const resumeRun = await host.command(
      "node",
      [CLI_ENTRYPOINT, "onboard", "--resume", "--non-interactive"],
      {
        artifactName: "phase-3-onboard-resume",
        // buildAvailabilityProbeEnv() does NOT pass NVIDIA_API_KEY through —
        // it's outside the framework allowlist. Resume must hydrate the
        // credential from the session file. This is exactly the bash test's
        // `env -u NVIDIA_API_KEY` invariant, expressed via the framework's
        // explicit secret-passthrough rule.
        env: {
          ...buildAvailabilityProbeEnv(),
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
          NEMOCLAW_POLICY_MODE: "skip",
        },
        redactionValues: [apiKey],
        timeoutMs: ONBOARD_TIMEOUT_MS,
      },
    );
    const resumeText = `${resumeRun.stdout}\n${resumeRun.stderr}`;

    // Assertion: resume-exit-0.
    expect(resumeRun.exitCode, resumeText).toBe(0);

    // Assertion: resume-skipped-{preflight,gateway,sandbox}-log.
    expect(resumeText).toContain("[resume] Skipping preflight (cached)");
    expect(resumeText).toContain("[resume] Skipping gateway (running)");
    expect(resumeText).toContain(`[resume] Skipping sandbox (${SANDBOX_NAME})`);

    // Assertion: resume-no-{preflight,gateway,sandbox}-rerun.
    expect(resumeText).not.toContain("[1/7] Preflight checks");
    expect(resumeText).not.toContain("[2/7] Starting OpenShell gateway");
    expect(resumeText).not.toContain("[5/7] Creating sandbox");

    // Assertion: resume-inference-handled — first onboard completed through
    // openclaw (step 7) before failing at policies (step 8). Inference was
    // already configured during that run, so the resume path either re-runs
    // it or detects readiness and skips. Both are valid.
    const ranInference = resumeText.includes("[4/7] Setting up inference provider");
    const skippedInference =
      resumeText.includes("[resume] Skipping inference") ||
      resumeText.includes("[reuse] Skipping inference");
    expect(ranInference || skippedInference, resumeText).toBe(true);

    // Assertion: sandbox-manageable-after-resume.
    const sandboxStatus = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "status"], {
      artifactName: "phase-3-nemoclaw-status",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    });
    expect(sandboxStatus.exitCode, sandboxStatus.stderr).toBe(0);

    // Assertion: session-file-complete-state.
    const complete = readSession<SessionStateComplete>(SESSION_FILE);
    await artifacts.writeJson("phase-3-session-state.json", complete);
    expect(complete.status).toBe("complete");
    expect(complete.provider).toBe("nvidia-prod");
    for (const step of [
      "preflight",
      "gateway",
      "sandbox",
      "provider_selection",
      "inference",
      "openclaw",
      "policies",
    ] as const) {
      expect(complete.steps[step]?.status, `step ${step}`).toBe("complete");
    }

    // Assertion: registry-has-sandbox.
    expect(fs.existsSync(REGISTRY_FILE)).toBe(true);
    expect(fs.readFileSync(REGISTRY_FILE, "utf8")).toContain(SANDBOX_NAME);
  },
);
