// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import {
  backfillMessagingChannels as defaultBackfillMessagingChannels,
  createMessagingConflictProbe as defaultCreateMessagingConflictProbe,
  findChannelConflictsFromPlan as defaultFindChannelConflictsFromPlan,
  type ConflictMatch,
  type ConflictRegistry,
  type MessagingConflictProbe,
  type MessagingConflictProbeGatewayDeps,
} from "../messaging/applier";
import type { SandboxMessagingPlan } from "../messaging/manifest/types";
import { resolveDisabledChannels as defaultResolveDisabledChannels } from "./channel-state";
import {
  prepareCreateSandboxMessaging as defaultPrepareCreateSandboxMessaging,
  type CreateSandboxMessagingPrepInput,
  type CreateSandboxMessagingPrepResult,
  type NamedMessagingChannel,
} from "./messaging-prep";

export interface SandboxMessagingPreflightInput {
  sandboxName: string;
  channels: readonly NamedMessagingChannel[];
  enabledChannels: readonly string[] | null;
  webSearchConfig: WebSearchConfig | null;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface SandboxMessagingPreflightDeps {
  readMessagingPlanFromEnv(): SandboxMessagingPlan | null;
  resolveDisabledChannels?: (sandboxName: string) => string[];
  registry: ConflictRegistry;
  checkGatewayLiveness(): boolean;
  providerExistsInGateway(name: string): boolean;
  isNonInteractive(): boolean;
  promptYesNoOrDefault(
    message: string,
    defaultValue: string | null,
    fallback: boolean,
  ): Promise<boolean>;
  cliName(): string;
  log(message: string): void;
  error(message: string): void;
  exitProcess(code: number): never;
  getValidatedMessagingTokenByEnvKey(
    channels: readonly NamedMessagingChannel[],
    envKey: string,
  ): string | null;
  getCredential(envKey: string): string | null;
  normalizeCredentialValue(value: unknown): string;
  registerExtraPlaceholderProviders(
    sandboxName: string,
    messagingTokenDefs: CreateSandboxMessagingPrepResult["messagingTokenDefs"],
  ): string[];
  getMessagingChannelForEnvKey(envKey: string): string | null;
  prepareCreateSandboxMessaging?: (
    input: CreateSandboxMessagingPrepInput,
  ) => CreateSandboxMessagingPrepResult;
  createMessagingConflictProbe?: (
    deps: MessagingConflictProbeGatewayDeps,
  ) => MessagingConflictProbe;
  backfillMessagingChannels?: (registry: ConflictRegistry, probe: MessagingConflictProbe) => void;
  findChannelConflictsFromPlan?: (
    currentSandbox: string | null,
    plan: SandboxMessagingPlan,
    registry: ConflictRegistry,
  ) => ConflictMatch[];
}

export interface SandboxMessagingPreflightResult extends CreateSandboxMessagingPrepResult {
  disabledChannels: string[];
}

export async function prepareSandboxMessagingPreflight(
  input: SandboxMessagingPreflightInput,
  deps: SandboxMessagingPreflightDeps,
): Promise<SandboxMessagingPreflightResult> {
  await checkMessagingPlanConflicts(input.sandboxName, deps);

  const disabledChannels = (deps.resolveDisabledChannels ?? defaultResolveDisabledChannels)(
    input.sandboxName,
  );
  const result = (deps.prepareCreateSandboxMessaging ?? defaultPrepareCreateSandboxMessaging)({
    sandboxName: input.sandboxName,
    channels: input.channels,
    enabledChannels: input.enabledChannels,
    disabledChannels,
    webSearchConfig: input.webSearchConfig,
    env: input.env,
    getValidatedMessagingTokenByEnvKey: deps.getValidatedMessagingTokenByEnvKey,
    getCredential: deps.getCredential,
    normalizeCredentialValue: deps.normalizeCredentialValue,
    registerExtraPlaceholderProviders: deps.registerExtraPlaceholderProviders,
    getMessagingChannelForEnvKey: deps.getMessagingChannelForEnvKey,
    providerExistsInGateway: deps.providerExistsInGateway,
  });

  if (result.missingBraveApiKey) {
    deps.error("  Brave Search is enabled, but BRAVE_API_KEY is not available in this process.");
    deps.error(
      "  Re-run with BRAVE_API_KEY set, or disable Brave Search before recreating the sandbox.",
    );
    deps.exitProcess(1);
  }

  return { ...result, disabledChannels };
}

async function checkMessagingPlanConflicts(
  sandboxName: string,
  deps: SandboxMessagingPreflightDeps,
): Promise<void> {
  const envPlan = deps.readMessagingPlanFromEnv();
  const currentPlan = envPlan?.sandboxName === sandboxName ? envPlan : null;
  const hasPlanCredentials =
    currentPlan?.credentialBindings.some((binding) => binding.credentialAvailable) ?? false;
  if (!currentPlan || !hasPlanCredentials) return;

  const createMessagingConflictProbe =
    deps.createMessagingConflictProbe ?? defaultCreateMessagingConflictProbe;
  const backfillMessagingChannels =
    deps.backfillMessagingChannels ?? defaultBackfillMessagingChannels;
  const findChannelConflictsFromPlan =
    deps.findChannelConflictsFromPlan ?? defaultFindChannelConflictsFromPlan;
  const probe = createMessagingConflictProbe({
    checkGatewayLiveness: deps.checkGatewayLiveness,
    providerExists: deps.providerExistsInGateway,
  });
  backfillMessagingChannels(deps.registry, probe);
  const conflicts = findChannelConflictsFromPlan(sandboxName, currentPlan, deps.registry);
  if (conflicts.length === 0) return;

  for (const { channel, sandbox, reason } of conflicts) {
    const detail =
      reason === "matching-token"
        ? `uses the same ${channel} credential`
        : `already has ${channel} enabled, but its credential hash is unavailable`;
    deps.log(
      `  ⚠ Sandbox '${sandbox}' ${detail}. Shared channel credentials only allow one sandbox to poll/connect — continuing may break both bridges.`,
    );
  }
  if (deps.isNonInteractive()) {
    deps.error(
      `  Aborting: resolve the messaging channel conflict above or run \`${deps.cliName()} <sandbox> channels stop <channel>\` / \`${deps.cliName()} <sandbox> channels remove <channel>\` on the other sandbox.`,
    );
    deps.exitProcess(1);
  }
  if (!(await deps.promptYesNoOrDefault("  Continue anyway?", null, false))) {
    deps.log("  Aborting sandbox creation.");
    deps.exitProcess(1);
  }
}
