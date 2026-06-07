// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  filterActiveMessagingPresets,
  hasDisabledMessagingPreset,
  pruneDisabledMessagingPolicyPresets,
  requiredMessagingChannelPolicyPresets,
} from "../messaging/applier/policy-presets";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import {
  getDisabledChannelsFromPlan,
  getEnabledChannelIdsFromPlan,
  getPolicyPresetsFromPlan,
} from "./messaging-plan-session";

export interface ActiveSandboxPolicyState {
  messagingChannels?: string[] | null;
  disabledChannels?: string[] | null;
}

export interface ResolvedMessagingPolicyState {
  /** Null means no compiled plan source is available. [] means the plan has no active presets. */
  messagingPolicyPresets: string[] | null;
  messagingChannelIds: string[];
  disabledChannels: string[] | null;
}

function normalizedNames(values: string[] | null | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const names: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const name = value.trim().toLowerCase();
    if (!name || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

export function mergePolicyMessagingChannels(
  selectedChannels: string[] | null | undefined,
  recordedChannels: string[] | null | undefined,
  activeChannels: string[] | null | undefined,
  disabledChannels: string[] | null | undefined = null,
): string[] {
  const disabled = new Set(normalizedNames(disabledChannels));
  const merged: string[] = [];
  for (const channels of [selectedChannels, recordedChannels, activeChannels]) {
    for (const channel of normalizedNames(channels)) {
      if (!channel || disabled.has(channel) || merged.includes(channel)) continue;
      merged.push(channel);
    }
  }
  return merged;
}

export function resolveMessagingPolicyState(options: {
  plan?: SandboxMessagingPlan | null;
  selectedChannels?: string[] | null;
  recordedChannels?: string[] | null;
  activeSandbox?: ActiveSandboxPolicyState | null;
  sessionDisabledChannels?: string[] | null;
}): ResolvedMessagingPolicyState {
  const planPolicyPresets = getPolicyPresetsFromPlan(options.plan);
  if (planPolicyPresets !== null) {
    return {
      messagingPolicyPresets: planPolicyPresets,
      messagingChannelIds: getEnabledChannelIdsFromPlan(options.plan) ?? [],
      disabledChannels: getDisabledChannelsFromPlan(options.plan),
    };
  }

  const disabledChannels =
    options.activeSandbox?.disabledChannels ?? options.sessionDisabledChannels ?? null;
  return {
    messagingPolicyPresets: null,
    messagingChannelIds: mergePolicyMessagingChannels(
      options.selectedChannels,
      options.recordedChannels,
      options.activeSandbox?.messagingChannels,
      disabledChannels,
    ),
    disabledChannels,
  };
}

export function requiredMessagingPolicyPresets(options: {
  messagingPolicyPresets?: string[] | null;
  messagingChannelIds?: string[] | null;
}): string[] {
  const merged: string[] = [];
  for (const preset of options.messagingPolicyPresets ?? []) {
    if (!merged.includes(preset)) merged.push(preset);
  }
  for (const preset of requiredMessagingChannelPolicyPresets(options.messagingChannelIds)) {
    if (!merged.includes(preset)) merged.push(preset);
  }
  return merged;
}

export function mergeRequiredMessagingPolicyPresets(
  selectedPresets: string[],
  options: {
    messagingPolicyPresets?: string[] | null;
    messagingChannelIds?: string[] | null;
    knownPresetNames?: Iterable<string> | null;
  },
): string[] {
  const known = options.knownPresetNames ? new Set(options.knownPresetNames) : null;
  const merged = [...selectedPresets];
  for (const preset of requiredMessagingPolicyPresets(options)) {
    if (known && !known.has(preset)) continue;
    if (merged.includes(preset)) continue;
    merged.push(preset);
  }
  return merged;
}

export function filterMessagingPolicyPresetsForSelection(
  presets: readonly string[],
  options: {
    messagingPolicyPresets?: string[] | null;
    disabledChannels?: string[] | null;
  },
): string[] {
  if (Array.isArray(options.messagingPolicyPresets)) {
    return filterActiveMessagingPresets(presets, new Set(options.messagingPolicyPresets));
  }
  return pruneDisabledMessagingPolicyPresets([...presets], options.disabledChannels);
}

export function hasMessagingPolicyPresetNeedingReconcile(
  presets: readonly string[],
  options: {
    messagingPolicyPresets?: string[] | null;
    disabledChannels?: string[] | null;
  },
): boolean {
  if (Array.isArray(options.messagingPolicyPresets)) {
    return hasDisabledMessagingPreset(presets, new Set(options.messagingPolicyPresets));
  }
  return filterMessagingPolicyPresetsForSelection(presets, options).length !== presets.length;
}
