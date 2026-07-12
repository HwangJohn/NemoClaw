// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const canaryComponents = ["openshell", "openclaw", "hermes"] as const;

export type CanaryComponent = (typeof canaryComponents)[number];

export type CanaryUpdateSurface = Readonly<{
  name: string;
  allowedChangedPaths: readonly string[];
  metadataPlaceholders: readonly string[];
}>;

export type CanaryUpdatePlan = Readonly<{
  schemaVersion: 1;
  mode: "dry-run";
  mutating: false;
  baseSha: string;
  component: CanaryComponent;
  candidate: string;
  metadata: Readonly<{
    checkout_sha: "<checkout_sha>";
    plan_hash: "<plan_hash>";
    correlation: "<correlation>";
  }>;
  allowedChangedPaths: readonly string[];
  expectedUpdateSurfaces: readonly CanaryUpdateSurface[];
  forbiddenOperations: readonly string[];
}>;

type PlanOptions = Readonly<{
  baseSha: string;
  candidate: string;
  component: CanaryComponent;
}>;

type ParsedArgs = Readonly<{
  baseSha?: string;
  candidate: string;
  component: CanaryComponent;
}>;

const GIT_SHA_RE = /^[0-9a-f]{40}$/u;
const NUMERIC_SEMVER_RE = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const OPENSHELL_TAG_RE = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/u;
const OPENCLAW_CALVER_RE = /^20[0-9]{2}\.(?:[1-9]|1[0-2])\.(?:[1-9]|[12][0-9]|3[01])$/u;
const HERMES_CALVER_RE = /^v?20[0-9]{2}\.(?:[1-9]|1[0-2])\.(?:[1-9]|[12][0-9]|3[01])$/u;

const metadata = {
  checkout_sha: "<checkout_sha>",
  plan_hash: "<plan_hash>",
  correlation: "<correlation>",
} as const;

const forbiddenOperations = [
  "create branch",
  "commit changes",
  "push branch",
  "create draft PR",
  "create pull request",
  "dispatch workflow",
  "publish package",
  "build or push image",
] as const;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
}

function assertKnownComponent(component: string): CanaryComponent {
  if ((canaryComponents as readonly string[]).includes(component)) {
    return component as CanaryComponent;
  }
  throw new Error(
    `Invalid --component '${component}'. Expected one of: ${canaryComponents.join(", ")}`,
  );
}

function assertBaseSha(baseSha: string): string {
  const normalized = baseSha.toLowerCase();
  if (!GIT_SHA_RE.test(normalized)) {
    throw new Error("--base-sha must be a full 40-character Git SHA");
  }
  return normalized;
}

export function canonicalCanaryCandidate(component: CanaryComponent, candidate: string): string {
  const trimmed = candidate.trim();
  if (trimmed !== candidate || trimmed.length === 0) {
    throw new Error("--candidate must be a non-empty value without surrounding whitespace");
  }
  if (/[\\/\s]/u.test(trimmed)) {
    throw new Error("--candidate must not contain whitespace or path separators");
  }

  if (component === "openshell") {
    const tagMatch = trimmed.match(OPENSHELL_TAG_RE);
    const normalized = tagMatch?.[1] ?? trimmed;
    if (!NUMERIC_SEMVER_RE.test(normalized)) {
      throw new Error("OpenShell candidate must match X.Y.Z or vX.Y.Z");
    }
    return normalized;
  }

  if (component === "openclaw") {
    if (!OPENCLAW_CALVER_RE.test(trimmed)) {
      throw new Error("OpenClaw candidate must match YYYY.M.D");
    }
    return trimmed;
  }

  if (!HERMES_CALVER_RE.test(trimmed)) {
    throw new Error("Hermes candidate must match vYYYY.M.D or YYYY.M.D");
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function openshellSurfaces(candidate: string): CanaryUpdateSurface[] {
  return [
    {
      name: "openshell-runtime-pins",
      allowedChangedPaths: [
        "nemoclaw-blueprint/blueprint.yaml",
        "scripts/brev-launchable-ci-cpu.sh",
        "scripts/check-installer-hash.sh",
        "scripts/install-openshell.sh",
        "src/lib/onboard/docker-driver-gateway-runtime.ts",
        "src/lib/onboard/openshell-feature-gate.ts",
        "src/lib/onboard/openshell-install.ts",
        "src/lib/onboard/openshell-version.ts",
      ],
      metadataPlaceholders: [
        "openshell_cli_aarch64_sha256",
        "openshell_cli_x86_64_sha256",
        "openshell_gateway_aarch64_sha256",
        "openshell_gateway_x86_64_sha256",
        "openshell_sandbox_aarch64_sha256",
        "openshell_sandbox_x86_64_sha256",
      ],
    },
    {
      name: "openshell-child-credential-boundary",
      allowedChangedPaths: [
        "agents/hermes/Dockerfile",
        "agents/hermes/mcp-config-transaction.py",
        "scripts/update-hermes-agent.sh",
        "src/lib/actions/sandbox/mcp-bridge-validation.ts",
        `src/lib/actions/sandbox/openshell-child-visible-credentials.v${candidate}.json`,
      ],
      metadataPlaceholders: [
        "openshell_child_visible_credentials_commit",
        "openshell_child_visible_credentials_review",
      ],
    },
    {
      name: "openshell-review-evidence",
      allowedChangedPaths: [`docs/security/openshell-${candidate}-compatibility-review.mdx`],
      metadataPlaceholders: ["openshell_release_commit", "openshell_release_workflow_run"],
    },
  ];
}

function openclawSurfaces(candidate: string): CanaryUpdateSurface[] {
  return [
    {
      name: "openclaw-runtime-pins",
      allowedChangedPaths: [
        "Dockerfile",
        "Dockerfile.base",
        "agents/openclaw/manifest.yaml",
        "ci/reviewed-npm-lifecycle-allowlist.json",
        "nemoclaw/package.json",
      ],
      metadataPlaceholders: ["openclaw_npm_integrity", "openclaw_npm_tarball"],
    },
    {
      name: "openclaw-plugin-pins",
      allowedChangedPaths: [
        "src/lib/messaging/channels/discord/manifest.ts",
        "src/lib/messaging/channels/manifests.test.ts",
        "src/lib/messaging/channels/metadata.test.ts",
        "src/lib/messaging/channels/slack/manifest.ts",
        "src/lib/messaging/channels/teams/manifest.ts",
        "src/lib/messaging/channels/whatsapp/manifest.ts",
        "test/openclaw-lifecycle-policy.test.ts",
      ],
      metadataPlaceholders: [
        "openclaw_brave_plugin_npm_integrity",
        "openclaw_diagnostics_otel_npm_integrity",
        "openclaw_discord_plugin_npm_integrity",
        "openclaw_msteams_plugin_npm_integrity",
        "openclaw_slack_plugin_npm_integrity",
        "openclaw_whatsapp_plugin_npm_integrity",
      ],
    },
    {
      name: "openclaw-review-evidence",
      allowedChangedPaths: [
        `docs/security/openclaw-${candidate}-dependency-review.md`,
        "test/openclaw-integrity-pin-suite.ts",
      ],
      metadataPlaceholders: ["openclaw_release_commit", "openclaw_release_published_at"],
    },
  ];
}

function hermesSurfaces(): CanaryUpdateSurface[] {
  return [
    {
      name: "hermes-runtime-pins",
      allowedChangedPaths: ["agents/hermes/Dockerfile.base", "agents/hermes/manifest.yaml"],
      metadataPlaceholders: ["hermes_npm_integrity", "hermes_semver", "hermes_tarball_sha256"],
    },
    {
      name: "hermes-compatibility-review",
      allowedChangedPaths: [
        "agents/hermes/Dockerfile",
        "agents/hermes/hermes-wrapper.py",
        "agents/hermes/patch-session-list-preview.py",
        "src/lib/domain/sandbox/connect-env.ts",
      ],
      metadataPlaceholders: ["hermes_release_commit", "hermes_release_notes_review"],
    },
  ];
}

export function expectedCanaryUpdateSurfaces(
  component: CanaryComponent,
  candidate: string,
): CanaryUpdateSurface[] {
  const canonicalCandidate = canonicalCanaryCandidate(component, candidate);
  if (component === "openshell") return openshellSurfaces(canonicalCandidate);
  if (component === "openclaw") return openclawSurfaces(canonicalCandidate);
  return hermesSurfaces();
}

export function allowedCanaryChangedPaths(component: CanaryComponent, candidate: string): string[] {
  return sortedUnique(
    expectedCanaryUpdateSurfaces(component, candidate).flatMap(
      (surface) => surface.allowedChangedPaths,
    ),
  );
}

export function buildCanaryUpdatePlan(options: PlanOptions): CanaryUpdatePlan {
  const component = options.component;
  const candidate = canonicalCanaryCandidate(component, options.candidate);
  const baseSha = assertBaseSha(options.baseSha);
  const expectedUpdateSurfaces = expectedCanaryUpdateSurfaces(component, candidate).map(
    (surface) => ({
      name: surface.name,
      allowedChangedPaths: sortedUnique(surface.allowedChangedPaths),
      metadataPlaceholders: sortedUnique(surface.metadataPlaceholders),
    }),
  );

  return {
    schemaVersion: 1,
    mode: "dry-run",
    mutating: false,
    baseSha,
    component,
    candidate,
    metadata,
    allowedChangedPaths: allowedCanaryChangedPaths(component, candidate),
    expectedUpdateSurfaces,
    forbiddenOperations,
  };
}

export function parseCanaryUpdatePlanArgs(argv: readonly string[]): ParsedArgs {
  let baseSha: string | undefined;
  let candidate: string | undefined;
  let component: CanaryComponent | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-sha") {
      const value = argv[index + 1];
      if (!value) throw new Error("--base-sha requires a value");
      baseSha = assertBaseSha(value);
      index += 1;
    } else if (arg.startsWith("--base-sha=")) {
      baseSha = assertBaseSha(arg.slice("--base-sha=".length));
    } else if (arg === "--candidate") {
      const value = argv[index + 1];
      if (!value) throw new Error("--candidate requires a value");
      candidate = value;
      index += 1;
    } else if (arg.startsWith("--candidate=")) {
      candidate = arg.slice("--candidate=".length);
    } else if (arg === "--component") {
      const value = argv[index + 1];
      if (!value) throw new Error("--component requires a value");
      component = assertKnownComponent(value);
      index += 1;
    } else if (arg.startsWith("--component=")) {
      component = assertKnownComponent(arg.slice("--component=".length));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!component) throw new Error("--component is required");
  if (!candidate) throw new Error("--candidate is required");
  return { baseSha, candidate, component };
}

function readHeadSha(): string {
  return assertBaseSha(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
}

function printHelp(): void {
  console.log(
    [
      "Usage: tsx scripts/canary-update-plan.ts --component openshell|openclaw|hermes --candidate VERSION [--base-sha SHA]",
      "",
      "Prints a deterministic non-mutating canary-update dry-run plan as JSON.",
    ].join("\n"),
  );
}

function main(): void {
  try {
    const args = parseCanaryUpdatePlanArgs(process.argv.slice(2));
    const plan = buildCanaryUpdatePlan({
      baseSha: args.baseSha ?? readHeadSha(),
      candidate: args.candidate,
      component: args.component,
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) main();
