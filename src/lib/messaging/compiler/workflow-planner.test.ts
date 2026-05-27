// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBuiltInChannelManifestRegistry } from "../channels";
import { MessagingWorkflowPlanner } from "./workflow-planner";

function planner(): MessagingWorkflowPlanner {
  return new MessagingWorkflowPlanner(createBuiltInChannelManifestRegistry());
}

function findFunctionPaths(value: unknown, prefix = "$"): string[] {
  if (typeof value === "function") return [prefix];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findFunctionPaths(entry, `${prefix}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      findFunctionPaths(entry, `${prefix}.${key}`),
    );
  }
  return [];
}

async function withEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("MessagingWorkflowPlanner", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("plans onboard as selected, configured, active channels with enrollment inputs", async () => {
    const plan = await withEnv(
      {
        TELEGRAM_BOT_TOKEN: "123456:test-telegram-token",
        TELEGRAM_REQUIRE_MENTION: "1",
        TELEGRAM_ALLOWED_IDS: "123456789",
        WECHAT_ACCOUNT_ID: "test-wechat-account",
        WECHAT_BASE_URL: "https://ilinkai.wechat.example",
        WECHAT_USER_ID: "test-wechat-user",
        WECHAT_ALLOWED_IDS: "test-wechat-user",
      },
      () =>
        planner().planOnboard({
          sandboxName: "demo",
          agent: "openclaw",
          isInteractive: true,
          selectedChannels: ["wechat", "telegram"],
          credentialAvailability: {
            TELEGRAM_BOT_TOKEN: true,
            WECHAT_BOT_TOKEN: true,
          },
        }),
    );

    expect(plan.workflow).toBe("onboard");
    expect(plan.channels.map((channel) => channel.channelId)).toEqual([
      "telegram",
      "wechat",
    ]);
    expect(plan.channels).toEqual([
      expect.objectContaining({
        channelId: "telegram",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
      }),
      expect.objectContaining({
        channelId: "wechat",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
      }),
    ]);
    expect(
      plan.channels
        .find((channel) => channel.channelId === "wechat")
        ?.inputs.find((input) => input.inputId === "accountId"),
    ).toMatchObject({
      kind: "config",
      value: "test-wechat-account",
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "wechat",
    ]);
  });

  it("plans add-channel as a configured active target and clears stale disabled state", async () => {
    const plan = await withEnv(
      {
        SLACK_BOT_TOKEN: "xoxb-test-slack-token",
        SLACK_APP_TOKEN: "xapp-test-slack-token",
        SLACK_ALLOWED_USERS: "U0123456789",
        SLACK_ALLOWED_CHANNELS: "C012AB3CD",
      },
      () =>
        planner().planAddChannel({
          sandboxName: "demo",
          agent: "openclaw",
          isInteractive: true,
          channelId: "slack",
          configuredChannels: ["telegram"],
          disabledChannels: ["telegram", "slack"],
        }),
    );

    expect(plan.workflow).toBe("add-channel");
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
      selected: false,
    });
    expect(plan.channels.find((channel) => channel.channelId === "slack")).toMatchObject({
      configured: true,
      disabled: false,
      active: true,
      selected: true,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["slack"]);
  });

  it("runs add-channel enrollment only for the selected channel", async () => {
    const plan = await withEnv(
      {
        TELEGRAM_BOT_TOKEN: undefined,
        SLACK_BOT_TOKEN: "xoxb-test-slack-token",
        SLACK_APP_TOKEN: "xapp-test-slack-token",
        SLACK_ALLOWED_USERS: "U0123456789",
        SLACK_ALLOWED_CHANNELS: "C012AB3CD",
      },
      () =>
        planner().planAddChannel({
          sandboxName: "demo",
          agent: "openclaw",
          isInteractive: true,
          channelId: "slack",
          configuredChannels: ["telegram"],
          credentialAvailability: {
            TELEGRAM_BOT_TOKEN: true,
          },
        }),
    );

    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      active: true,
      selected: false,
    });
    expect(
      plan.channels
        .find((channel) => channel.channelId === "slack")
        ?.inputs.filter((input) => input.kind === "secret")
        .every((input) => input.credentialAvailable === true),
    ).toBe(true);
  });

  it("does not re-run host-QR enrollment when required manifest inputs are already available", async () => {
    await withEnv(
      {
        WECHAT_ACCOUNT_ID: "cached-wechat-account",
        WECHAT_ALLOWED_IDS: "cached-wechat-user",
      },
      async () => {
        const plan = await planner().planOnboard({
        sandboxName: "demo",
        agent: "openclaw",
        isInteractive: true,
        selectedChannels: ["wechat"],
        credentialAvailability: {
          WECHAT_BOT_TOKEN: true,
        },
      });

      expect(plan.channels[0]).toMatchObject({
        channelId: "wechat",
        active: true,
        selected: true,
        configured: true,
      });
      expect(plan.channels[0]?.inputs).toContainEqual(
        expect.objectContaining({
          inputId: "accountId",
          value: "cached-wechat-account",
        }),
      );
      },
    );
  });

  it("plans stop-channel by keeping configured state and disabling only that channel", async () => {
    const plan = await planner().planStopChannel({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: false,
      channelId: "telegram",
      configuredChannels: ["telegram", "slack"],
      credentialAvailability: {
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    expect(plan.workflow).toBe("stop-channel");
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
      selected: true,
    });
    expect(plan.channels.find((channel) => channel.channelId === "slack")).toMatchObject({
      configured: true,
      disabled: false,
      active: true,
      selected: false,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["slack"]);
    expect(
      plan.credentialBindings.some((binding) => binding.channelId === "telegram"),
    ).toBe(false);
  });

  it("plans start-channel by preserving configured state and making the channel active", async () => {
    const plan = await planner().planStartChannel({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: false,
      channelId: "telegram",
      configuredChannels: ["telegram", "slack"],
      disabledChannels: ["telegram"],
      credentialAvailability: {
        TELEGRAM_BOT_TOKEN: true,
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    expect(plan.workflow).toBe("start-channel");
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      configured: true,
      disabled: false,
      active: true,
      selected: true,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "slack",
    ]);
  });

  it("plans remove-channel by deleting configured and disabled state", async () => {
    const plan = await planner().planRemoveChannel({
      sandboxName: "demo",
      agent: "openclaw",
      isInteractive: false,
      channelId: "telegram",
      configuredChannels: ["telegram", "wechat", "slack"],
      disabledChannels: ["telegram", "wechat"],
      credentialAvailability: {
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    expect(plan.workflow).toBe("remove-channel");
    expect(plan.channels.map((channel) => channel.channelId)).toEqual(["wechat", "slack"]);
    expect(plan.channels.find((channel) => channel.channelId === "telegram")).toBeUndefined();
    expect(plan.channels.find((channel) => channel.channelId === "wechat")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual(["slack"]);
  });

  it("plans rebuild from configured and disabled registry snapshots", async () => {
    const plan = await withEnv(
      {
        WECHAT_ACCOUNT_ID: "test-wechat-account",
      },
      () =>
        planner().planRebuild({
          sandboxName: "demo",
          agent: "openclaw",
          isInteractive: false,
          configuredChannels: ["telegram", "discord", "wechat"],
          disabledChannels: ["discord"],
          credentialAvailability: {
            TELEGRAM_BOT_TOKEN: true,
            WECHAT_BOT_TOKEN: true,
          },
        }),
    );

    expect(plan.workflow).toBe("rebuild");
    expect(plan.channels.map((channel) => channel.channelId)).toEqual([
      "telegram",
      "discord",
      "wechat",
    ]);
    expect(plan.channels.find((channel) => channel.channelId === "discord")).toMatchObject({
      configured: true,
      disabled: true,
      active: false,
      selected: false,
    });
    expect(plan.networkPolicy.entries.map((entry) => entry.channelId)).toEqual([
      "telegram",
      "wechat",
    ]);
  });

  it("reports unsupported channels deterministically before compiling", async () => {
    await expect(
      planner().planOnboard({
        sandboxName: "demo",
        agent: "openclaw",
        isInteractive: false,
        selectedChannels: ["slack", "discord"],
        supportedChannelIds: ["telegram"],
      }),
    ).rejects.toThrow("Unsupported messaging channel(s) for openclaw: discord, slack");
  });

  it("returns serializable, secret-free plans suitable for dry-run and shadow output", async () => {
    await withEnv(
      {
        TELEGRAM_BOT_TOKEN: "123456:raw-telegram-token",
      },
      async () => {
        const plan = await planner().planAddChannel({
          sandboxName: "demo",
          agent: "openclaw",
          isInteractive: false,
          channelId: "telegram",
        });
        const serialized = JSON.stringify(plan);

        expect(JSON.parse(serialized)).toEqual(plan);
        expect(findFunctionPaths(plan)).toEqual([]);
        expect(serialized).toContain("openshell:resolve:env:TELEGRAM_BOT_TOKEN");
        expect(serialized).not.toContain("123456:raw-telegram-token");
      },
    );
  });
});
