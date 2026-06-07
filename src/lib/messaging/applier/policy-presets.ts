// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const REQUIRED_POLICY_PRESETS_BY_MESSAGING_CHANNEL: Record<string, readonly string[]> = {
  discord: ["discord"],
  slack: ["slack"],
  telegram: ["telegram"],
  wechat: ["wechat"],
  whatsapp: ["whatsapp"],
};

/** All preset names that any messaging channel can require. */
export const ALL_MESSAGING_POLICY_PRESET_NAMES: ReadonlySet<string> = new Set(
  Object.values(REQUIRED_POLICY_PRESETS_BY_MESSAGING_CHANNEL).flat(),
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

function requiredMessagingChannelPolicyPresets(channels: string[] | null | undefined): string[] {
  const required: string[] = [];
  for (const channel of normalizedNames(channels)) {
    for (const preset of REQUIRED_POLICY_PRESETS_BY_MESSAGING_CHANNEL[channel] || []) {
      if (!required.includes(preset)) required.push(preset);
    }
  }
  return required;
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
): string[] {
  const disabledRequiredPresets = new Set(requiredMessagingChannelPolicyPresets(disabledChannels));
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
