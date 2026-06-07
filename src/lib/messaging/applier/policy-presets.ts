// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createBuiltInChannelManifestRegistry } from "../channels";
import type {
  ChannelManifest,
  ChannelManifestRegistry,
  ChannelPolicyPresetReference,
  ChannelPolicyPresetSpec,
  MessagingAgentId,
} from "../manifest";

const BUILT_IN_CHANNEL_MANIFEST_REGISTRY = createBuiltInChannelManifestRegistry();

function normalizePolicyPreset(preset: ChannelPolicyPresetReference): ChannelPolicyPresetSpec {
  return typeof preset === "string" ? { name: preset } : preset;
}

function manifestPolicyPresetNames(manifest: ChannelManifest): string[] {
  return (manifest.policyPresets ?? []).map((preset) => normalizePolicyPreset(preset).name);
}

function manifestPolicyKeys(manifest: ChannelManifest, agent: MessagingAgentId): string[] {
  return (manifest.policyPresets ?? []).flatMap((preset) => {
    const policy = normalizePolicyPreset(preset);
    return [...(policy.agentPolicyKeys?.[agent] ?? policy.policyKeys ?? [policy.name])];
  });
}

function getRegistry(registry?: ChannelManifestRegistry | null): ChannelManifestRegistry {
  return registry ?? BUILT_IN_CHANNEL_MANIFEST_REGISTRY;
}

/** All preset names that any messaging channel can require. */
export const ALL_MESSAGING_POLICY_PRESET_NAMES: ReadonlySet<string> = new Set(
  getRegistry()
    .list()
    .flatMap((manifest) => manifestPolicyPresetNames(manifest)),
);

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

export function requiredMessagingChannelPolicyPresets(
  channels: string[] | null | undefined,
  registry?: ChannelManifestRegistry | null,
): string[] {
  const manifestRegistry = getRegistry(registry);
  const required: string[] = [];
  for (const channel of normalizedNames(channels)) {
    const manifest = manifestRegistry.get(channel);
    if (!manifest) continue;
    for (const preset of manifestPolicyPresetNames(manifest)) {
      if (!required.includes(preset)) required.push(preset);
    }
  }
  return required;
}

export function messagingPolicyKeysByChannel(
  agent: MessagingAgentId,
  registry?: ChannelManifestRegistry | null,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const manifest of getRegistry(registry).listAvailable({ agent })) {
    const keys = manifestPolicyKeys(manifest, agent);
    if (keys.length > 0) result[manifest.id] = keys;
  }
  return result;
}

/**
 * Removes from selectedPresets any preset exclusively required by a disabled
 * channel. Used when restoring presets from backup manifests where no compiled
 * plan is available. For plan-aware paths, use getPolicyPresetsFromPlan which
 * derives presets from enabled plan entries only.
 */
export function pruneDisabledMessagingPolicyPresets(
  selectedPresets: string[],
  disabledChannels: string[] | null | undefined,
  registry?: ChannelManifestRegistry | null,
): string[] {
  const disabledRequiredPresets = new Set(
    requiredMessagingChannelPolicyPresets(disabledChannels, registry),
  );
  if (disabledRequiredPresets.size === 0) return selectedPresets;
  return selectedPresets.filter(
    (preset) => !disabledRequiredPresets.has(preset.trim().toLowerCase()),
  );
}

/**
 * Returns true if any preset in the list is a messaging policy preset that is
 * absent from the active plan preset set. Used to detect stale messaging
 * presets still applied in the gateway after a channel stop/disable.
 */
export function hasDisabledMessagingPreset(
  presets: readonly string[],
  activePlanPresets: ReadonlySet<string>,
): boolean {
  return presets.some(
    (preset) => ALL_MESSAGING_POLICY_PRESET_NAMES.has(preset) && !activePlanPresets.has(preset),
  );
}

/**
 * Filters a preset list to retain only non-messaging presets and messaging
 * presets that appear in the active plan preset set. Used to exclude stale
 * gateway presets from the resume/preservation set.
 */
export function filterActiveMessagingPresets(
  presets: readonly string[],
  activePlanPresets: ReadonlySet<string>,
): string[] {
  return presets.filter(
    (name) => !ALL_MESSAGING_POLICY_PRESET_NAMES.has(name) || activePlanPresets.has(name),
  );
}
