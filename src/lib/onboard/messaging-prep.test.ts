// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { BRAVE_API_KEY_ENV } from "../../../dist/lib/inference/web-search";
import {
  prepareCreateSandboxMessaging,
  type CreateSandboxMessagingPrepInput,
} from "../../../dist/lib/onboard/messaging-prep";
import { listChannels } from "../../../dist/lib/sandbox/channels";

function normalizeCredentialValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function createInput(
  overrides: Partial<CreateSandboxMessagingPrepInput> = {},
): CreateSandboxMessagingPrepInput {
  return {
    sandboxName: "demo",
    channels: listChannels(),
    enabledChannels: null,
    disabledChannels: [],
    webSearchConfig: null,
    env: {},
    getValidatedMessagingTokenByEnvKey: () => null,
    getCredential: () => null,
    normalizeCredentialValue,
    registerExtraPlaceholderProviders: vi.fn(() => []),
    getMessagingChannelForEnvKey: (envKey) => {
      if (envKey === "DISCORD_BOT_TOKEN") return "discord";
      if (envKey === "SLACK_BOT_TOKEN") return "slack";
      if (envKey === "TELEGRAM_BOT_TOKEN") return "telegram";
      if (envKey === "WECHAT_BOT_TOKEN") return "wechat";
      return null;
    },
    providerExistsInGateway: () => false,
    ...overrides,
  };
}

describe("prepareCreateSandboxMessaging", () => {
  it("filters token definitions by selected and disabled channels and reuses attached missing-token providers", () => {
    const registerExtraPlaceholderProviders = vi.fn(() => ["SLACK_BOT_TOKEN_AGENT_A"]);
    const providerExistsInGateway = vi.fn((name: string) => name === "demo-slack-bridge");

    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: ["slack", "telegram"],
        disabledChannels: ["telegram"],
        getValidatedMessagingTokenByEnvKey: (_channels, envKey) =>
          envKey === "SLACK_APP_TOKEN" ? "xapp-valid" : null,
        registerExtraPlaceholderProviders,
        providerExistsInGateway,
      }),
    );

    expect(result.messagingTokenDefs).toMatchObject([
      { name: "demo-slack-bridge", envKey: "SLACK_BOT_TOKEN", token: null },
      { name: "demo-slack-app", envKey: "SLACK_APP_TOKEN", token: "xapp-valid" },
    ]);
    expect([...result.disabledChannelNames]).toEqual(["telegram"]);
    expect(result.extraPlaceholderKeys).toEqual(["SLACK_BOT_TOKEN_AGENT_A"]);
    expect(result.hasMessagingTokens).toBe(true);
    expect(result.reusableMessagingProviders).toEqual(["demo-slack-bridge"]);
    expect(result.reusableMessagingChannels).toEqual(["slack"]);
    expect(providerExistsInGateway).toHaveBeenCalledWith("demo-slack-bridge");
    expect(registerExtraPlaceholderProviders).toHaveBeenCalledWith(
      "demo",
      result.messagingTokenDefs,
    );
  });

  it("reports missing Brave API keys before registering extra placeholder providers", () => {
    const registerExtraPlaceholderProviders = vi.fn(() => ["BRAVE_API_KEY_AGENT_A"]);

    const result = prepareCreateSandboxMessaging(
      createInput({
        webSearchConfig: { fetchEnabled: true },
        env: { [BRAVE_API_KEY_ENV]: "   " },
        registerExtraPlaceholderProviders,
      }),
    );

    expect(result.missingBraveApiKey).toBe(true);
    expect(result.extraPlaceholderKeys).toEqual([]);
    expect(result.messagingTokenDefs.some(({ envKey }) => envKey === BRAVE_API_KEY_ENV)).toBe(
      false,
    );
    expect(registerExtraPlaceholderProviders).not.toHaveBeenCalled();
  });

  it("adds the Brave provider token from the credential store before host env fallback", () => {
    const registerExtraPlaceholderProviders = vi.fn(() => []);

    const result = prepareCreateSandboxMessaging(
      createInput({
        webSearchConfig: { fetchEnabled: true },
        env: { [BRAVE_API_KEY_ENV]: "brv-host" },
        getCredential: (envKey) => (envKey === BRAVE_API_KEY_ENV ? "brv-store" : null),
        registerExtraPlaceholderProviders,
      }),
    );

    expect(result.missingBraveApiKey).toBe(false);
    expect(result.hasMessagingTokens).toBe(true);
    expect(result.messagingTokenDefs).toContainEqual({
      name: "demo-brave-search",
      envKey: BRAVE_API_KEY_ENV,
      token: "brv-store",
      providerType: "brave",
    });
    expect(registerExtraPlaceholderProviders).toHaveBeenCalledWith(
      "demo",
      result.messagingTokenDefs,
    );
  });
});
