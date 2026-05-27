// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { slackManifest, telegramManifest } from "../../channels";
import { runMessagingHook } from "../hook-runner";
import { MessagingHookRegistry } from "../registry";
import {
  COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
  COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
  COMMON_HOOK_REGISTRATIONS,
  createTokenPasteHook,
} from "./index";

describe("common token-paste hook implementation", () => {
  it("uses the shared handler id declared by token-paste channel manifests", () => {
    expect(COMMON_HOOK_REGISTRATIONS.map((registration) => registration.id)).toEqual([
      COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
      COMMON_CONFIG_PROMPT_HOOK_HANDLER_ID,
    ]);
    expect(telegramManifest.hooks[0]?.handler).toBe(COMMON_TOKEN_PASTE_HOOK_HANDLER_ID);
    expect(slackManifest.hooks[0]?.handler).toBe(COMMON_TOKEN_PASTE_HOOK_HANDLER_ID);
  });

  it("requires an injected prompt when no env or credential value is available", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({ env: {}, log: () => {} }),
      },
    ]);
    const hook = telegramManifest.hooks[0];

    if (!hook) throw new Error("missing Telegram token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "telegram",
      }),
    ).rejects.toThrow("requires an injected prompt implementation");
  });

  it("shows the single-token enrollment output shape", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({
          env: {},
          getCredential: () => "123456:test-telegram-token",
          saveCredential: () => {},
          log: () => {},
        }),
      },
    ]);
    const hook = telegramManifest.hooks[0];

    if (!hook) throw new Error("missing Telegram token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "telegram",
      }),
    ).resolves.toMatchObject({
      handlerId: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
      phase: "enroll",
      outputs: {
        botToken: {
          kind: "secret",
          value: "123456:test-telegram-token",
        },
      },
    });
  });

  it("shows the multi-token enrollment output shape", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({
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
      },
    ]);
    const hook = slackManifest.hooks[0];

    if (!hook) throw new Error("missing Slack token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "slack",
      }),
    ).resolves.toMatchObject({
      handlerId: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
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

  it("prompts only for missing token outputs and stages them for provider upsert", async () => {
    const env: NodeJS.ProcessEnv = {
      SLACK_BOT_TOKEN: "xoxb-existing",
    };
    const prompts: Array<{ readonly question: string; readonly secret: boolean }> = [];
    const saved: Array<{ readonly key: string; readonly value: string }> = [];
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({
          env,
          getCredential: () => null,
          saveCredential: (key, value) => saved.push({ key, value }),
          log: () => {},
          prompt: async (question, options) => {
            prompts.push({ question, secret: options?.secret === true });
            return "xapp-prompted";
          },
        }),
      },
    ]);
    const hook = slackManifest.hooks[0];

    if (!hook) throw new Error("missing Slack token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "slack",
      }),
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
    expect(saved).toEqual([
      { key: "SLACK_BOT_TOKEN", value: "xoxb-existing" },
      { key: "SLACK_APP_TOKEN", value: "xapp-prompted" },
    ]);
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
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({
          env,
          getCredential: () => null,
          saveCredential: (key, value) => saved.push({ key, value }),
          log: (message) => logs.push(message),
          prompt: async (question, options) => {
            prompts.push({ question, secret: options?.secret === true });
            return "xoxb-recovered-token";
          },
        }),
      },
    ]);
    const hook = slackManifest.hooks[0];

    if (!hook) throw new Error("missing Slack token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "slack",
        isInteractive: true,
      }),
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
    expect(saved).toEqual([
      { key: "SLACK_BOT_TOKEN", value: "xoxb-recovered-token" },
      { key: "SLACK_APP_TOKEN", value: "xapp-existing" },
    ]);
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-recovered-token");
    expect(logs.join("\n")).toContain("Slack bot tokens start with 'xoxb-'");
    expect(logs.join("\n")).toContain("Invalid existing slack token ignored");
    expect(logs.join("\n")).not.toContain("Skipped slack (invalid token format)");
  });

  it("skips in non-interactive mode when an existing token has invalid format", async () => {
    const logs: string[] = [];
    const saved: Array<{ readonly key: string; readonly value: string }> = [];
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({
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
      },
    ]);
    const hook = slackManifest.hooks[0];

    if (!hook) throw new Error("missing Slack token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "slack",
        isInteractive: false,
      }),
    ).rejects.toThrow("Invalid token format for SLACK_BOT_TOKEN");
    expect(saved).toEqual([]);
    expect(logs.join("\n")).toContain("Slack bot tokens start with 'xoxb-'");
    expect(logs.join("\n")).toContain("Skipped slack (invalid token format)");
  });

  it("rejects invalid pasted token formats before staging credentials", async () => {
    const saved: Array<{ readonly key: string; readonly value: string }> = [];
    const registry = new MessagingHookRegistry([
      {
        id: COMMON_TOKEN_PASTE_HOOK_HANDLER_ID,
        handler: createTokenPasteHook({
          env: {},
          getCredential: () => null,
          saveCredential: (key, value) => saved.push({ key, value }),
          log: () => {},
          prompt: async () => "not-a-slack-token",
        }),
      },
    ]);
    const hook = slackManifest.hooks[0];

    if (!hook) throw new Error("missing Slack token-paste hook");

    await expect(
      runMessagingHook(hook, registry, {
        channelId: "slack",
      }),
    ).rejects.toThrow("Invalid token format for SLACK_BOT_TOKEN");
    expect(saved).toEqual([]);
  });
});
