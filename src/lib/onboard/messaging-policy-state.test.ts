// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import {
  filterMessagingPolicyPresetsForSelection,
  mergeRequiredMessagingPolicyPresets,
  resolveMessagingPolicyState,
} from "./messaging-policy-state";

function makePlan(
  channelIds: readonly string[],
  overrides: Partial<SandboxMessagingPlan> = {},
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "demo",
    agent: "openclaw",
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: true,
      selected: true,
      configured: true,
      disabled: false,
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: {
      presets: [...channelIds],
      entries: channelIds.map((channelId) => ({
        channelId,
        presetName: channelId,
        policyKeys: [channelId],
        source: "manifest",
      })),
    },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
    ...overrides,
  };
}

describe("resolveMessagingPolicyState", () => {
  it("keeps no-plan legacy channels as fallback source", () => {
    expect(
      resolveMessagingPolicyState({
        plan: null,
        selectedChannels: [],
        recordedChannels: ["slack"],
        activeSandbox: null,
      }),
    ).toEqual({
      messagingPolicyPresets: null,
      messagingChannelIds: ["slack"],
      disabledChannels: null,
    });
  });

  it("treats a compiled plan with no active entries as authoritative", () => {
    const plan = makePlan(["slack"], {
      channels: [
        {
          channelId: "slack",
          displayName: "Slack",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: true,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: ["slack"],
    });

    expect(
      resolveMessagingPolicyState({
        plan,
        recordedChannels: ["slack"],
        activeSandbox: { messagingChannels: ["slack"], disabledChannels: [] },
      }),
    ).toEqual({
      messagingPolicyPresets: [],
      messagingChannelIds: [],
      disabledChannels: ["slack"],
    });
  });
});

describe("messaging policy selection helpers", () => {
  it("adds manifest-derived presets from legacy channel IDs", () => {
    expect(
      mergeRequiredMessagingPolicyPresets(["npm"], {
        messagingPolicyPresets: null,
        messagingChannelIds: ["telegram"],
      }),
    ).toEqual(["npm", "telegram"]);
  });

  it("does not treat no-plan fallback as an all-messaging stale marker", () => {
    expect(
      filterMessagingPolicyPresetsForSelection(["npm", "slack", "telegram"], {
        messagingPolicyPresets: null,
        disabledChannels: ["telegram"],
      }),
    ).toEqual(["npm", "slack"]);
  });

  it("does treat an empty compiled plan preset set as authoritative", () => {
    expect(
      filterMessagingPolicyPresetsForSelection(["npm", "slack", "telegram"], {
        messagingPolicyPresets: [],
        disabledChannels: null,
      }),
    ).toEqual(["npm"]);
  });
});
