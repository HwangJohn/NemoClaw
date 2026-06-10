// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  prepareSandboxMessagingPreflight,
  type SandboxMessagingPreflightDeps,
} from "../../../dist/lib/onboard/sandbox-messaging-preflight";
import { listChannels } from "../../../dist/lib/sandbox/channels";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function createResult(overrides = {}) {
  return {
    disabledChannelNames: new Set<string>(),
    messagingTokenDefs: [],
    extraPlaceholderKeys: [],
    hasMessagingTokens: false,
    reusableMessagingProviders: [],
    reusableMessagingChannels: [],
    missingBraveApiKey: false,
    ...overrides,
  };
}

function createPlan(
  sandboxName = "demo",
): NonNullable<ReturnType<SandboxMessagingPreflightDeps["readMessagingPlanFromEnv"]>> {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [{ credentialAvailable: true }],
    networkPolicy: { presets: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  } as unknown as NonNullable<
    ReturnType<SandboxMessagingPreflightDeps["readMessagingPlanFromEnv"]>
  >;
}

function createDeps(
  overrides: Partial<SandboxMessagingPreflightDeps> = {},
): SandboxMessagingPreflightDeps {
  return {
    readMessagingPlanFromEnv: vi.fn(() => null),
    resolveDisabledChannels: vi.fn(() => []),
    registry: {
      listSandboxes: vi.fn(() => ({ sandboxes: [] })),
      updateSandbox: vi.fn(() => true),
    },
    checkGatewayLiveness: vi.fn(() => true),
    providerExistsInGateway: vi.fn(() => false),
    isNonInteractive: vi.fn(() => false),
    promptYesNoOrDefault: vi.fn(async () => true),
    cliName: vi.fn(() => "nemoclaw"),
    log: vi.fn(),
    error: vi.fn(),
    exitProcess: vi.fn((code: number) => {
      throw new ExitError(code);
    }) as (code: number) => never,
    getValidatedMessagingTokenByEnvKey: vi.fn(() => null),
    getCredential: vi.fn(() => null),
    normalizeCredentialValue: vi.fn((value: unknown) =>
      typeof value === "string" ? value.trim() : "",
    ),
    registerExtraPlaceholderProviders: vi.fn(() => []),
    getMessagingChannelForEnvKey: vi.fn(() => null),
    prepareCreateSandboxMessaging: vi.fn((input) =>
      createResult({ disabledChannelNames: new Set(input.disabledChannels) }),
    ),
    createMessagingConflictProbe: vi.fn(() => ({ providerExists: vi.fn(() => "absent" as const) })),
    backfillMessagingChannels: vi.fn(),
    findChannelConflictsFromPlan: vi.fn(() => []),
    ...overrides,
  };
}

const baseInput = {
  sandboxName: "demo",
  channels: listChannels(),
  enabledChannels: ["slack"],
  webSearchConfig: null,
  env: {},
};

describe("prepareSandboxMessagingPreflight", () => {
  it("passes resolved disabled channels into messaging prep", async () => {
    const deps = createDeps({
      resolveDisabledChannels: vi.fn(() => ["telegram"]),
    });

    const result = await prepareSandboxMessagingPreflight(baseInput, deps);

    expect([...result.disabledChannelNames]).toEqual(["telegram"]);
    expect(deps.prepareCreateSandboxMessaging).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "demo",
        enabledChannels: ["slack"],
        disabledChannels: ["telegram"],
      }),
    );
  });

  it("ignores stale env plans for a different sandbox", async () => {
    const deps = createDeps({
      readMessagingPlanFromEnv: vi.fn(() => createPlan("other")),
    });

    await prepareSandboxMessagingPreflight(baseInput, deps);

    expect(deps.backfillMessagingChannels).not.toHaveBeenCalled();
    expect(deps.findChannelConflictsFromPlan).not.toHaveBeenCalled();
    expect(deps.prepareCreateSandboxMessaging).toHaveBeenCalled();
  });

  it("lets interactive users continue through a matching-token conflict", async () => {
    const deps = createDeps({
      readMessagingPlanFromEnv: vi.fn(() => createPlan()),
      findChannelConflictsFromPlan: vi.fn(() => [
        { channel: "slack", sandbox: "other", reason: "matching-token" as const },
      ]),
      promptYesNoOrDefault: vi.fn(async () => true),
    });

    await prepareSandboxMessagingPreflight(baseInput, deps);

    expect(deps.backfillMessagingChannels).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining("uses the same slack credential"),
    );
    expect(deps.promptYesNoOrDefault).toHaveBeenCalledWith("  Continue anyway?", null, false);
    expect(deps.prepareCreateSandboxMessaging).toHaveBeenCalled();
  });

  it("aborts non-interactive runs when the current plan conflicts", async () => {
    const deps = createDeps({
      readMessagingPlanFromEnv: vi.fn(() => createPlan()),
      isNonInteractive: vi.fn(() => true),
      findChannelConflictsFromPlan: vi.fn(() => [
        { channel: "discord", sandbox: "other", reason: "unknown-token" as const },
      ]),
    });

    await expect(prepareSandboxMessagingPreflight(baseInput, deps)).rejects.toMatchObject({
      code: 1,
    });
    expect(deps.error).toHaveBeenCalledWith(expect.stringContaining("channels stop <channel>"));
    expect(deps.promptYesNoOrDefault).not.toHaveBeenCalled();
  });

  it("fails before recreate/delete when Brave search has no API key", async () => {
    const deps = createDeps({
      prepareCreateSandboxMessaging: vi.fn(() => createResult({ missingBraveApiKey: true })),
    });

    await expect(prepareSandboxMessagingPreflight(baseInput, deps)).rejects.toMatchObject({
      code: 1,
    });
    expect(deps.error).toHaveBeenCalledWith(
      "  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.",
    );
  });
});
