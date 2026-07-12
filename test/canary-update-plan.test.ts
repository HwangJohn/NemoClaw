// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  allowedCanaryChangedPaths,
  buildCanaryUpdatePlan,
  canonicalCanaryCandidate,
  parseCanaryUpdatePlanArgs,
} from "../scripts/canary-update-plan";

const BASE_SHA = "a".repeat(40);

describe("canary update planner", () => {
  it("emits deterministic dry-run JSON with OpenShell metadata placeholders (#6691)", () => {
    const plan = buildCanaryUpdatePlan({
      baseSha: BASE_SHA,
      component: "openshell",
      candidate: "0.0.73",
    });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      mode: "dry-run",
      mutating: false,
      baseSha: BASE_SHA,
      component: "openshell",
      candidate: "0.0.73",
      metadata: {
        checkout_sha: "<checkout_sha>",
        plan_hash: "<plan_hash>",
        correlation: "<correlation>",
      },
    });
    expect(plan.forbiddenOperations).toEqual([
      "create branch",
      "commit changes",
      "push branch",
      "create draft PR",
      "create pull request",
      "dispatch workflow",
      "publish package",
      "build or push image",
    ]);
    expect(plan.expectedUpdateSurfaces.map((surface) => surface.name)).toEqual([
      "openshell-runtime-pins",
      "openshell-child-credential-boundary",
      "openshell-review-evidence",
    ]);
    expect(JSON.stringify(plan, null, 2)).toBe(
      JSON.stringify(
        buildCanaryUpdatePlan({
          baseSha: BASE_SHA,
          component: "openshell",
          candidate: "0.0.73",
        }),
        null,
        2,
      ),
    );
  });

  it("defines exact allowed changed-path sets for each canary component (#6691)", () => {
    expect(allowedCanaryChangedPaths("openshell", "0.0.73")).toEqual([
      "agents/hermes/Dockerfile",
      "agents/hermes/mcp-config-transaction.py",
      "docs/security/openshell-0.0.73-compatibility-review.mdx",
      "nemoclaw-blueprint/blueprint.yaml",
      "scripts/brev-launchable-ci-cpu.sh",
      "scripts/check-installer-hash.sh",
      "scripts/install-openshell.sh",
      "scripts/update-hermes-agent.sh",
      "src/lib/actions/sandbox/mcp-bridge-validation.ts",
      "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.73.json",
      "src/lib/onboard/docker-driver-gateway-runtime.ts",
      "src/lib/onboard/openshell-feature-gate.ts",
      "src/lib/onboard/openshell-install.ts",
      "src/lib/onboard/openshell-version.ts",
    ]);

    expect(allowedCanaryChangedPaths("openclaw", "2026.7.13")).toEqual([
      "Dockerfile",
      "Dockerfile.base",
      "agents/openclaw/manifest.yaml",
      "ci/reviewed-npm-lifecycle-allowlist.json",
      "docs/security/openclaw-2026.7.13-dependency-review.md",
      "nemoclaw/package.json",
      "src/lib/messaging/channels/discord/manifest.ts",
      "src/lib/messaging/channels/manifests.test.ts",
      "src/lib/messaging/channels/metadata.test.ts",
      "src/lib/messaging/channels/slack/manifest.ts",
      "src/lib/messaging/channels/teams/manifest.ts",
      "src/lib/messaging/channels/whatsapp/manifest.ts",
      "test/openclaw-integrity-pin-suite.ts",
      "test/openclaw-lifecycle-policy.test.ts",
    ]);

    expect(allowedCanaryChangedPaths("hermes", "v2026.7.13")).toEqual([
      "agents/hermes/Dockerfile",
      "agents/hermes/Dockerfile.base",
      "agents/hermes/hermes-wrapper.py",
      "agents/hermes/manifest.yaml",
      "agents/hermes/patch-session-list-preview.py",
      "src/lib/domain/sandbox/connect-env.ts",
    ]);
  });

  it("validates and normalizes component-specific candidate formats (#6691)", () => {
    expect(canonicalCanaryCandidate("openshell", "0.0.73")).toBe("0.0.73");
    expect(canonicalCanaryCandidate("openshell", "v0.0.73")).toBe("0.0.73");
    expect(canonicalCanaryCandidate("openclaw", "2026.7.13")).toBe("2026.7.13");
    expect(canonicalCanaryCandidate("hermes", "2026.7.13")).toBe("v2026.7.13");
    expect(canonicalCanaryCandidate("hermes", "v2026.7.13")).toBe("v2026.7.13");

    expect(() => canonicalCanaryCandidate("openshell", "release-0.0.73")).toThrow(
      "OpenShell candidate must match X.Y.Z or vX.Y.Z",
    );
    expect(() => canonicalCanaryCandidate("openclaw", "2026.13.1")).toThrow(
      "OpenClaw candidate must match YYYY.M.D",
    );
    expect(() => canonicalCanaryCandidate("hermes", "v2026/7/13")).toThrow(
      "--candidate must not contain whitespace or path separators",
    );
  });

  it("parses required CLI inputs without accepting mutation-oriented flags (#6691)", () => {
    expect(
      parseCanaryUpdatePlanArgs([
        "--component=openclaw",
        "--candidate",
        "2026.7.13",
        "--base-sha",
        BASE_SHA.toUpperCase(),
      ]),
    ).toEqual({
      baseSha: BASE_SHA,
      component: "openclaw",
      candidate: "2026.7.13",
    });

    expect(() =>
      parseCanaryUpdatePlanArgs(["--component", "docker", "--candidate", "1.2.3"]),
    ).toThrow("Invalid --component 'docker'. Expected one of: openshell, openclaw, hermes");
    expect(() =>
      parseCanaryUpdatePlanArgs(["--component", "openclaw", "--candidate", "2026.7.13", "--push"]),
    ).toThrow("Unknown argument: --push");
    expect(() =>
      parseCanaryUpdatePlanArgs([
        "--component",
        "openclaw",
        "--candidate",
        "2026.7.13",
        "--base-sha",
        "main",
      ]),
    ).toThrow("--base-sha must be a full 40-character Git SHA");
  });
});
