// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingChannelConfig } from "../messaging-channel-config";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import { enabledPlanChannelIds, filterEnabledPlanEntries } from "../messaging/applier/plan-filter";

export function parseSandboxMessagingPlan(value: unknown): SandboxMessagingPlan | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sandboxName !== "string" ||
    typeof value.agent !== "string" ||
    typeof value.workflow !== "string" ||
    !Array.isArray(value.channels) ||
    !value.channels.every(
      (c) => isObject(c) && typeof c.channelId === "string",
    ) ||
    !Array.isArray(value.disabledChannels) ||
    !value.disabledChannels.every((id) => typeof id === "string") ||
    !Array.isArray(value.credentialBindings) ||
    !isObject(value.networkPolicy) ||
    !Array.isArray(value.networkPolicy.presets) ||
    !value.networkPolicy.presets.every((p) => typeof p === "string") ||
    !Array.isArray(value.networkPolicy.entries) ||
    !value.networkPolicy.entries.every(
      (e) => isObject(e) && typeof e.channelId === "string" && typeof e.presetName === "string",
    ) ||
    !Array.isArray(value.agentRender) ||
    !Array.isArray(value.buildSteps) ||
    !Array.isArray(value.stateUpdates) ||
    !Array.isArray(value.healthChecks)
  ) {
    return null;
  }
  return value as unknown as SandboxMessagingPlan;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Derive the equivalent of session.messagingChannels from a plan. */
export function getChannelsFromPlan(plan: SandboxMessagingPlan | null | undefined): string[] | null {
  if (!plan || plan.channels.length === 0) return null;
  return plan.channels.map((c) => c.channelId);
}

/** Derive only enabled channel IDs from a plan (excludes disabled channels). */
export function getEnabledChannelIdsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  if (!plan) return null;
  const ids = [...enabledPlanChannelIds(plan)];
  return ids.length > 0 ? ids : null;
}

/** Derive the equivalent of session.disabledChannels from a plan. */
export function getDisabledChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  if (!plan) return null;
  return plan.disabledChannels.length > 0 ? [...plan.disabledChannels] : null;
}

/** Derive the messaging network policy presets for active channels from a plan. */
export function getPolicyPresetsFromPlan(plan: SandboxMessagingPlan | null | undefined): string[] {
  if (!plan) return [];
  const activeEntries = filterEnabledPlanEntries(plan, plan.networkPolicy.entries);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of activeEntries) {
    if (entry.presetName && !seen.has(entry.presetName)) {
      seen.add(entry.presetName);
      result.push(entry.presetName);
    }
  }
  return result;
}


/**
 * Derive the equivalent of session.messagingChannelConfig from a plan.
 * Config inputs (kind === "config") carry their resolved env-key/value pairs
 * in plan.channels[].inputs, populated at compile time from process.env.
 */
export function getMessagingChannelConfigFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): MessagingChannelConfig | null {
  if (!plan) return null;
  const config: Record<string, string> = {};
  for (const channel of plan.channels) {
    for (const input of channel.inputs) {
      if (input.kind === "config" && input.sourceEnv && input.value != null) {
        config[input.sourceEnv] = String(input.value);
      }
    }
  }
  return Object.keys(config).length > 0 ? config : null;
}
