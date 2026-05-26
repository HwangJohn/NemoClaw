// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChannelHookSpec } from "../../../manifest";
import { MessagingHookRegistry, runMessagingHook } from "../../../hooks";
import {
  createTelegramGetMeReachabilityHook,
  TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
} from "./get-me-reachability";

const TELEGRAM_REACHABILITY_HOOK = {
  id: "telegram-reachability",
  phase: "reachability-check",
  handler: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
  inputs: ["botToken"],
  onFailure: "abort",
} as const satisfies ChannelHookSpec;

describe("Telegram getMe reachability hook implementation", () => {
  it("calls Telegram getMe without exposing the token in outputs", async () => {
    const urls: string[] = [];
    const registry = new MessagingHookRegistry([
      {
        id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
        handler: createTelegramGetMeReachabilityHook({
          apiBaseUrl: "https://telegram.test",
          fetch: async (url) => {
            urls.push(url);
            return {
              ok: true,
              status: 200,
              async json() {
                return { ok: true, result: { id: 42, is_bot: true } };
              },
              async text() {
                return "";
              },
            };
          },
        }),
      },
    ]);
    await expect(
      runMessagingHook(TELEGRAM_REACHABILITY_HOOK, registry, {
        channelId: "telegram",
        inputs: {
          botToken: "123456:telegram-token",
        },
      }),
    ).resolves.toEqual({
      hookId: "telegram-reachability",
      handlerId: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
      phase: "reachability-check",
      outputs: {},
    });
    expect(urls).toEqual(["https://telegram.test/bot123456:telegram-token/getMe"]);
  });

  it("fails closed when Telegram rejects the token", async () => {
    const registry = new MessagingHookRegistry([
      {
        id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
        handler: createTelegramGetMeReachabilityHook({
          fetch: async () => ({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            async json() {
              return { ok: false };
            },
            async text() {
              return "unauthorized";
            },
          }),
        }),
      },
    ]);
    await expect(
      runMessagingHook(TELEGRAM_REACHABILITY_HOOK, registry, {
        channelId: "telegram",
        inputs: {
          botToken: "bad-token",
        },
      }),
    ).rejects.toThrow("Telegram reachability check failed with HTTP 401 Unauthorized.");
  });
});
