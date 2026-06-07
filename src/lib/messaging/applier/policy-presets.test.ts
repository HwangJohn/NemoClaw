// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createChannelManifestRegistry, type ChannelManifest } from "../manifest";
import {
  ALL_MESSAGING_POLICY_PRESET_NAMES,
  filterActiveMessagingPresets,
  hasDisabledMessagingPreset,
  messagingPolicyKeysByChannel,
  pruneDisabledMessagingPolicyPresets,
  requiredMessagingChannelPolicyPresets,
} from "./policy-presets";

function manifest(id: string, policyPresets: ChannelManifest["policyPresets"]): ChannelManifest {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    supportedAgents: ["openclaw", "hermes"],
    auth: { mode: "token-paste" },
    inputs: [],
    credentials: [],
    policyPresets,
    render: [],
    state: {},
    hooks: [],
  };
}

describe("pruneDisabledMessagingPolicyPresets", () => {
  it("removes policy presets for disabled messaging channels", () => {
    expect(pruneDisabledMessagingPolicyPresets(["npm", "slack", "pypi"], [" Slack "])).toEqual([
      "npm",
      "pypi",
    ]);
  });

  it("removes telegram preset when telegram channel is disabled", () => {
    expect(
      pruneDisabledMessagingPolicyPresets(["telegram", "npm", "pypi"], ["telegram"]),
    ).toEqual(["npm", "pypi"]);
  });

  it("removes discord preset when discord channel is disabled", () => {
    expect(pruneDisabledMessagingPolicyPresets(["discord", "npm"], ["discord"])).toEqual(["npm"]);
  });

  it("removes wechat preset when wechat channel is disabled", () => {
    expect(pruneDisabledMessagingPolicyPresets(["wechat", "npm"], ["wechat"])).toEqual(["npm"]);
  });

  it("removes whatsapp preset when whatsapp channel is disabled", () => {
    expect(pruneDisabledMessagingPolicyPresets(["whatsapp", "npm"], ["whatsapp"])).toEqual(["npm"]);
  });

  it("preserves presets for non-messaging same-named items", () => {
    expect(pruneDisabledMessagingPolicyPresets(["npm", "pypi"], ["npm"])).toEqual(["npm", "pypi"]);
  });

  it("returns the original list unchanged when no channels are disabled", () => {
    expect(pruneDisabledMessagingPolicyPresets(["npm", "slack"], null)).toEqual(["npm", "slack"]);
  });
});

describe("requiredMessagingChannelPolicyPresets", () => {
  it("derives fallback channel presets from manifests", () => {
    const registry = createChannelManifestRegistry([
      manifest("matrix", [{ name: "matrix-policy", policyKeys: ["matrix_bridge"] }]),
    ]);

    expect(requiredMessagingChannelPolicyPresets(["matrix"], registry)).toEqual(["matrix-policy"]);
    expect(pruneDisabledMessagingPolicyPresets(["npm", "matrix-policy"], ["matrix"], registry)).toEqual([
      "npm",
    ]);
  });

  it("derives agent policy keys from manifest aliases", () => {
    const registry = createChannelManifestRegistry([
      manifest("matrix", [
        {
          name: "matrix-policy",
          policyKeys: ["matrix_default"],
          agentPolicyKeys: { hermes: ["matrix_hermes"] },
        },
      ]),
    ]);

    expect(messagingPolicyKeysByChannel("hermes", registry)).toEqual({
      matrix: ["matrix_hermes"],
    });
  });
});

describe("ALL_MESSAGING_POLICY_PRESET_NAMES", () => {
  it("includes all messaging channel presets", () => {
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("slack")).toBe(true);
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("telegram")).toBe(true);
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("discord")).toBe(true);
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("wechat")).toBe(true);
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("whatsapp")).toBe(true);
  });

  it("does not include non-messaging presets", () => {
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("npm")).toBe(false);
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("pypi")).toBe(false);
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("brave")).toBe(false);
  });
});

describe("hasDisabledMessagingPreset", () => {
  it("returns true when a messaging preset is not in the active set", () => {
    expect(hasDisabledMessagingPreset(["slack", "npm"], new Set())).toBe(true);
  });

  it("returns false when all messaging presets are in the active set", () => {
    expect(hasDisabledMessagingPreset(["slack", "npm"], new Set(["slack"]))).toBe(false);
  });

  it("returns false for non-messaging presets not in the active set", () => {
    expect(hasDisabledMessagingPreset(["npm", "pypi"], new Set())).toBe(false);
  });

  it("detects stale telegram preset", () => {
    expect(hasDisabledMessagingPreset(["telegram", "npm"], new Set())).toBe(true);
  });
});

describe("filterActiveMessagingPresets", () => {
  it("keeps non-messaging presets regardless of plan", () => {
    expect(filterActiveMessagingPresets(["npm", "pypi"], new Set())).toEqual(["npm", "pypi"]);
  });

  it("removes messaging presets absent from the plan", () => {
    expect(filterActiveMessagingPresets(["npm", "slack", "telegram"], new Set(["slack"]))).toEqual([
      "npm",
      "slack",
    ]);
  });

  it("retains messaging presets present in the plan", () => {
    const active = new Set(["slack", "telegram"]);
    expect(filterActiveMessagingPresets(["slack", "telegram", "npm"], active)).toEqual([
      "slack",
      "telegram",
      "npm",
    ]);
  });
});
