// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelInputSpec,
  ChannelManifest,
  ChannelManifestAvailabilityContext,
  MessagingAgentId,
  MessagingChannelId,
  SandboxMessagingPlan,
} from "./manifest";

export interface MessagingAgentDescriptor {
  readonly name?: string;
  readonly messagingPlatforms?: readonly MessagingChannelId[] | null;
}

export type MessagingInputResolver = (input: ChannelInputSpec) => string | null;

export function toMessagingAgentId(
  agent: MessagingAgentDescriptor | null | undefined,
): MessagingAgentId {
  return agent?.name === "hermes" ? "hermes" : "openclaw";
}

export function getMessagingManifestAvailabilityContext(
  agent: MessagingAgentDescriptor | null | undefined,
): ChannelManifestAvailabilityContext {
  return {
    agent: toMessagingAgentId(agent),
    supportedChannelIds:
      agent?.messagingPlatforms && agent.messagingPlatforms.length > 0
        ? agent.messagingPlatforms
        : null,
  };
}

export function resolveMessagingManifestSeed(
  manifests: readonly ChannelManifest[],
  existingChannels: readonly string[] | null | undefined,
  hasChannelRequiredInputs: (manifest: ChannelManifest) => boolean,
  { includeAllExisting = false }: { readonly includeAllExisting?: boolean } = {},
): string[] {
  const seeded = new Set(manifests.filter(hasChannelRequiredInputs).map((manifest) => manifest.id));
  if (!Array.isArray(existingChannels)) return Array.from(seeded);

  const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  for (const channelId of existingChannels) {
    const manifest = manifestById.get(channelId);
    if (!manifest) continue;
    if (includeAllExisting || manifest.auth.mode === "in-sandbox-qr") {
      seeded.add(channelId);
    }
  }
  return Array.from(seeded);
}

export function hasMessagingManifestRequiredInputs(
  manifest: ChannelManifest,
  resolveInput: MessagingInputResolver,
): boolean {
  const requiredInputs = manifest.inputs.filter((input) => input.required);
  if (requiredInputs.length === 0) return false;
  return requiredInputs.every((input) => {
    if (!input.envKey) return false;
    return hasResolvedInputValue(resolveInput(input));
  });
}

export function getConfiguredChannelIdsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  if (!plan) return null;
  return plan.channels.map((channel) => channel.channelId);
}

export function getActiveChannelIdsFromMessagingPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  if (!plan) return null;
  const disabled = new Set(plan.disabledChannels);
  const active = plan.channels
    .filter((channel) => channel.active && !channel.disabled && !disabled.has(channel.channelId))
    .map((channel) => channel.channelId);
  return active.length > 0 ? active : [];
}

export function getDisabledChannelIdsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  if (!plan) return null;
  return plan.disabledChannels.length > 0 ? [...plan.disabledChannels] : [];
}

export interface MessagingPlanStateLike {
  readonly messaging?: {
    readonly plan?: SandboxMessagingPlan | null;
  } | null;
  readonly messagingChannels?: readonly string[] | null;
  readonly disabledChannels?: readonly string[] | null;
  readonly messagingChannelConfig?: Readonly<Record<string, string>> | null;
}

export function getConfiguredChannelIdsFromMessagingState(
  state: MessagingPlanStateLike | null | undefined,
): string[] {
  return (
    getConfiguredChannelIdsFromPlan(state?.messaging?.plan) ??
    uniqueStringArray(state?.messagingChannels)
  );
}

export function getActiveChannelIdsFromMessagingState(
  state: MessagingPlanStateLike | null | undefined,
): string[] {
  const fromPlan = getActiveChannelIdsFromMessagingPlan(state?.messaging?.plan);
  if (fromPlan) return fromPlan;
  const disabled = new Set(uniqueStringArray(state?.disabledChannels));
  return uniqueStringArray(state?.messagingChannels).filter(
    (channelId) => !disabled.has(channelId),
  );
}

export function getDisabledChannelIdsFromMessagingState(
  state: MessagingPlanStateLike | null | undefined,
): string[] {
  return (
    getDisabledChannelIdsFromPlan(state?.messaging?.plan) ??
    uniqueStringArray(state?.disabledChannels)
  );
}

export function getMessagingChannelConfigFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): Record<string, string> | null {
  if (!plan) return null;
  const config: Record<string, string> = {};
  for (const channel of plan.channels) {
    for (const input of channel.inputs) {
      if (
        input.kind === "config" &&
        input.sourceEnv &&
        typeof input.value === "string" &&
        input.value.length > 0
      ) {
        config[input.sourceEnv] = input.value;
      }
    }
  }
  return Object.keys(config).length > 0 ? config : null;
}

export function getMessagingChannelConfigFromMessagingState(
  state: MessagingPlanStateLike | null | undefined,
): Record<string, string> | null {
  if (state?.messaging?.plan) return getMessagingChannelConfigFromPlan(state.messaging.plan);
  return sanitizeStringRecord(state?.messagingChannelConfig);
}

function hasResolvedInputValue(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStringArray(values: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function sanitizeStringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === "string" && typeof entry === "string") record[key] = entry;
  }
  return Object.keys(record).length > 0 ? record : null;
}
