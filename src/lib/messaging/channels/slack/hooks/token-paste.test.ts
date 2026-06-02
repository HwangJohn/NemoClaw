// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { runMessagingHook } from "../../../hooks/hook-runner";
import { MessagingHookRegistry } from "../../../hooks/registry";
import { slackManifest } from "../manifest";
import {
  createSlackTokenPasteHook,
  SLACK_TOKEN_PASTE_HOOK_HANDLER_ID,
  type SlackTokenPasteHookOptions,
} from "./token-paste";

function registry(options: SlackTokenPasteHookOptions): MessagingHookRegistry {
  return new MessagingHookRegistry([
    {
      id: SLACK_TOKEN_PASTE_HOOK_HANDLER_ID,
      handler: createSlackTokenPasteHook({
        validateCredentials: () => ({ ok: true }),
        ...options,
      }),
    },
  ]);
}

function slackTokenHook() {
  const hook = slackManifest.hooks[0];
  if (!hook) throw new Error("missing Slack token-paste hook");
  return hook;
}

describe("Slack token-paste hook", () => {
  it("uses the Slack-specific handler declared by the manifest", () => {
    expect(slackManifest.hooks[0]?.handler).toBe(SLACK_TOKEN_PASTE_HOOK_HANDLER_ID);
  });

  it("shows the multi-token enrollment output shape", async () => {
    await expect(
      runMessagingHook(
        slackTokenHook(),
        registry({
          env: {},
          getCredential: (key) =>
            key === "SLACK_BOT_TOKEN"
              ? "xoxb-test-slack-token"
              : key === "SLACK_APP_TOKEN"
                ? "xapp-test-slack-token"
                : null,
          saveCredential: () => {},
          log: () => {},
        }),
        { channelId: "slack" },
      ),
    ).resolves.toMatchObject({
      handlerId: SLACK_TOKEN_PASTE_HOOK_HANDLER_ID,
      phase: "enroll",
      outputs: {
        botToken: {
          kind: "secret",
          value: "xoxb-test-slack-token",
        },
        appToken: {
          kind: "secret",
          value: "xapp-test-slack-token",
        },
      },
    });
  });

  it("prompts only for missing token outputs and saves prompted credentials after validation", async () => {
    const env: NodeJS.ProcessEnv = {
      SLACK_BOT_TOKEN: "xoxb-existing",
    };
    const prompts: Array<{ readonly question: string; readonly secret: boolean }> = [];
    const saved: Array<{ readonly key: string; readonly value: string }> = [];

    await expect(
      runMessagingHook(
        slackTokenHook(),
        registry({
          env,
          getCredential: () => null,
          saveCredential: (key, value) => saved.push({ key, value }),
          log: () => {},
          prompt: async (question, options) => {
            prompts.push({ question, secret: options?.secret === true });
            return "xapp-prompted";
          },
        }),
        { channelId: "slack" },
      ),
    ).resolves.toMatchObject({
      outputs: {
        botToken: {
          kind: "secret",
          value: "xoxb-existing",
        },
        appToken: {
          kind: "secret",
          value: "xapp-prompted",
        },
      },
    });
    expect(prompts).toEqual([
      {
        question: "  Slack App Token (Socket Mode): ",
        secret: true,
      },
    ]);
    expect(saved).toEqual([{ key: "SLACK_APP_TOKEN", value: "xapp-prompted" }]);
    expect(env.SLACK_APP_TOKEN).toBe("xapp-prompted");
  });

  it("reprompts in interactive mode when an existing token has invalid format", async () => {
    const env: NodeJS.ProcessEnv = {
      SLACK_BOT_TOKEN: "not-a-slack-token",
      SLACK_APP_TOKEN: "xapp-existing",
    };
    const logs: string[] = [];
    const prompts: Array<{ readonly question: string; readonly secret: boolean }> = [];
    const saved: Array<{ readonly key: string; readonly value: string }> = [];

    await expect(
      runMessagingHook(
        slackTokenHook(),
        registry({
          env,
          getCredential: () => null,
          saveCredential: (key, value) => saved.push({ key, value }),
          log: (message) => logs.push(message),
          prompt: async (question, options) => {
            prompts.push({ question, secret: options?.secret === true });
            return "xoxb-recovered-token";
          },
        }),
        { channelId: "slack", isInteractive: true },
      ),
    ).resolves.toMatchObject({
      outputs: {
        botToken: {
          kind: "secret",
          value: "xoxb-recovered-token",
        },
        appToken: {
          kind: "secret",
          value: "xapp-existing",
        },
      },
    });
    expect(prompts).toEqual([
      {
        question: "  Slack Bot Token: ",
        secret: true,
      },
    ]);
    expect(saved).toEqual([{ key: "SLACK_BOT_TOKEN", value: "xoxb-recovered-token" }]);
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-recovered-token");
    expect(logs.join("\n")).toContain("Slack bot tokens start with 'xoxb-'");
    expect(logs.join("\n")).toContain("Invalid existing slack token ignored");
    expect(logs.join("\n")).not.toContain("Skipped slack (invalid token format)");
  });

  it("skips in non-interactive mode when an existing token has invalid format", async () => {
    const logs: string[] = [];
    const saved: Array<{ readonly key: string; readonly value: string }> = [];

    await expect(
      runMessagingHook(
        slackTokenHook(),
        registry({
          env: {
            SLACK_BOT_TOKEN: "not-a-slack-token",
            SLACK_APP_TOKEN: "xapp-existing",
          },
          getCredential: () => null,
          saveCredential: (key, value) => saved.push({ key, value }),
          log: (message) => logs.push(message),
          prompt: async () => {
            throw new Error("non-interactive enrollment should not prompt");
          },
        }),
        { channelId: "slack", isInteractive: false },
      ),
    ).rejects.toThrow("Invalid token format for SLACK_BOT_TOKEN");
    expect(saved).toEqual([]);
    expect(logs.join("\n")).toContain("Slack bot tokens start with 'xoxb-'");
    expect(logs.join("\n")).toContain("Skipped slack (invalid token format)");
  });

  it("does not save prompted credentials when Slack API rejects them", async () => {
    const env: NodeJS.ProcessEnv = {};
    const saved: Array<{ readonly key: string; readonly value: string }> = [];
    const logs: string[] = [];
    const prompts = ["xoxb-fake-bot-token", "xapp-fake-app-token"];

    await expect(
      runMessagingHook(
        slackTokenHook(),
        registry({
          env,
          getCredential: () => null,
          saveCredential: (key, value) => saved.push({ key, value }),
          log: (message) => logs.push(message),
          prompt: async () => prompts.shift() ?? "",
          validateCredentials: () => ({
            ok: false,
            kind: "rejected",
            tokenKind: "app",
            credential: "app",
            error: "invalid_auth",
            httpStatus: 200,
            curlStatus: 0,
            message: "Slack app token was rejected by Slack API: invalid_auth.",
          }),
        }),
        { channelId: "slack", isInteractive: true },
      ),
    ).rejects.toThrow("Slack credential validation failed");
    expect(saved).toEqual([]);
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.SLACK_APP_TOKEN).toBeUndefined();
    expect(logs.join("\n")).toContain("Slack app token was rejected by Slack API");
    expect(logs.join("\n")).not.toContain("xoxb-fake-bot-token");
    expect(logs.join("\n")).not.toContain("xapp-fake-app-token");
  });

  it("ignores existing Slack tokens that pass format but fail Slack API validation", async () => {
    const logs: string[] = [];
    const saved: Array<{ readonly key: string; readonly value: string }> = [];

    await expect(
      runMessagingHook(
        slackTokenHook(),
        registry({
          env: {
            SLACK_BOT_TOKEN: "xoxb-existing-invalid",
            SLACK_APP_TOKEN: "xapp-existing-valid",
          },
          getCredential: () => null,
          saveCredential: (key, value) => saved.push({ key, value }),
          log: (message) => logs.push(message),
          validateCredentials: () => ({
            ok: false,
            kind: "rejected",
            tokenKind: "bot",
            credential: "bot",
            error: "token_revoked",
            httpStatus: 200,
            curlStatus: 0,
            message: "Slack bot token was rejected by Slack API: token_revoked.",
          }),
        }),
        { channelId: "slack", isInteractive: true },
      ),
    ).rejects.toThrow("Slack credential validation failed");
    expect(saved).toEqual([]);
    expect(logs.join("\n")).toContain("Invalid existing slack token ignored");
    expect(logs.join("\n")).toContain("token_revoked");
    expect(logs.join("\n")).not.toContain("slack — already configured");
  });
});
