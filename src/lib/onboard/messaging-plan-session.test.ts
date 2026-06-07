// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import {
  getEnabledChannelIdsFromPlan,
  getPolicyPresetsFromPlan,
  parseSandboxMessagingPlan,
} from "./messaging-plan-session";

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
      authMode: "token-paste" as const,
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
        source: "manifest" as const,
      })),
    },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
    ...overrides,
  };
}

describe("getPolicyPresetsFromPlan", () => {
  it("returns empty array for null/undefined", () => {
    expect(getPolicyPresetsFromPlan(null)).toEqual([]);
    expect(getPolicyPresetsFromPlan(undefined)).toEqual([]);
  });

  it("returns presets for all active channels", () => {
    const plan = makePlan(["slack", "telegram"]);
    expect(getPolicyPresetsFromPlan(plan).sort()).toEqual(["slack", "telegram"]);
  });

  it("excludes presets for disabled channels", () => {
    const plan = makePlan(["slack", "telegram"], {
      channels: [
        {
          channelId: "slack",
          displayName: "Slack",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
        {
          channelId: "telegram",
          displayName: "Telegram",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: true,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: ["telegram"],
    });
    expect(getPolicyPresetsFromPlan(plan)).toEqual(["slack"]);
  });

  it("ignores networkPolicy.presets — derives from enabled entries only", () => {
    // Compiler may leave disabled-channel entries in networkPolicy.presets;
    // getPolicyPresetsFromPlan must ignore that field.
    const plan = makePlan(["slack"], {
      disabledChannels: ["telegram"],
      networkPolicy: {
        presets: ["slack", "telegram"],
        entries: [
          { channelId: "slack", presetName: "slack", policyKeys: ["slack"], source: "manifest" },
          {
            channelId: "telegram",
            presetName: "telegram",
            policyKeys: ["telegram_bot"],
            source: "manifest",
          },
        ],
      },
    });
    expect(getPolicyPresetsFromPlan(plan)).toEqual(["slack"]);
  });

  it("deduplicates preset names", () => {
    const plan = makePlan(["slack"], {
      networkPolicy: {
        presets: ["slack", "slack"],
        entries: [
          { channelId: "slack", presetName: "slack", policyKeys: ["slack"], source: "manifest" },
          { channelId: "slack", presetName: "slack", policyKeys: ["slack2"], source: "manifest" },
        ],
      },
    });
    expect(getPolicyPresetsFromPlan(plan)).toEqual(["slack"]);
  });
});

describe("getEnabledChannelIdsFromPlan", () => {
  it("returns null for null/undefined", () => {
    expect(getEnabledChannelIdsFromPlan(null)).toBeNull();
    expect(getEnabledChannelIdsFromPlan(undefined)).toBeNull();
  });

  it("returns only enabled channel IDs", () => {
    const plan = makePlan(["slack", "telegram"], {
      channels: [
        {
          channelId: "slack",
          displayName: "Slack",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
        {
          channelId: "telegram",
          displayName: "Telegram",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: true,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: ["telegram"],
    });
    expect(getEnabledChannelIdsFromPlan(plan)).toEqual(["slack"]);
  });

  it("returns null when all channels are disabled", () => {
    const plan = makePlan(["telegram"], {
      channels: [
        {
          channelId: "telegram",
          displayName: "Telegram",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: true,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: ["telegram"],
    });
    expect(getEnabledChannelIdsFromPlan(plan)).toBeNull();
  });
});

describe("parseSandboxMessagingPlan", () => {
  it("accepts a well-formed plan", () => {
    const plan = makePlan(["slack"]);
    expect(parseSandboxMessagingPlan(plan)).not.toBeNull();
  });

  it("rejects a plan with non-string channel IDs", () => {
    const plan = makePlan(["slack"]) as unknown as Record<string, unknown>;
    (plan.channels as Array<Record<string, unknown>>)[0].channelId = 42;
    expect(parseSandboxMessagingPlan(plan)).toBeNull();
  });

  it("rejects a plan with non-string disabledChannels entries", () => {
    const plan = { ...makePlan(["slack"]), disabledChannels: [42] };
    expect(parseSandboxMessagingPlan(plan)).toBeNull();
  });

  it("rejects a plan with non-string networkPolicy.presets entries", () => {
    const plan = {
      ...makePlan(["slack"]),
      networkPolicy: { presets: [42], entries: [] },
    };
    expect(parseSandboxMessagingPlan(plan)).toBeNull();
  });

  it("rejects a plan with networkPolicy.entries missing presetName", () => {
    const plan = {
      ...makePlan(["slack"]),
      networkPolicy: {
        presets: ["slack"],
        entries: [{ channelId: "slack", policyKeys: ["slack"] }],
      },
    };
    expect(parseSandboxMessagingPlan(plan)).toBeNull();
  });

  it("rejects null", () => {
    expect(parseSandboxMessagingPlan(null)).toBeNull();
  });
});
