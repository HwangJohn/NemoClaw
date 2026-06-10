// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingChannelConfig } from "../messaging-channel-config";
import { readMessagingChannelConfigFromEnv } from "../messaging-channel-config";
import * as onboardSession from "../state/onboard-session";
import type { Session } from "../state/onboard-session";
import {
  collectMessagingBuildConfig,
  computeTelegramRequireMention,
  type MessagingBuildConfig,
} from "./messaging-config";
import {
  gatherWechatConfig,
  toSessionWechatConfig,
  type WechatConfigSnapshot,
} from "./wechat-config";

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type SandboxBuildPatchChannel = {
  name: string;
  userIdEnvKey?: string;
};

export type SandboxBuildPatchTokenDef = {
  envKey: string;
};

type TelegramConfig = { requireMention?: boolean };

export type SandboxBuildPatchConfig = MessagingBuildConfig & {
  messagingChannelConfig: MessagingChannelConfig | null;
  enabledTokenEnvKeys: Set<string>;
  activeChannelNames: Set<string>;
  telegramConfig: TelegramConfig;
  wechatConfig: WechatConfigSnapshot;
};

export type SandboxBuildPatchConfigDeps = {
  readMessagingChannelConfigFromEnv?(env?: NodeJS.ProcessEnv): MessagingChannelConfig | null;
  collectMessagingBuildConfig?(input: {
    channels: SandboxBuildPatchChannel[];
    activeChannelNames: ReadonlySet<string>;
    enabledTokenEnvKeys: ReadonlySet<string>;
    env?: EnvLike;
    discordSnowflakeRe: RegExp;
    warn?: (message: string) => void;
  }): MessagingBuildConfig;
  computeTelegramRequireMention?(): boolean | null;
  loadSession?(): Session | null;
  gatherWechatConfig?(session: Session | null): WechatConfigSnapshot;
  toSessionWechatConfig?(
    cfg: WechatConfigSnapshot,
  ): { accountId?: string; baseUrl?: string; userId?: string } | null;
  updateSession?(mutator: (session: Session) => Session | void): Session;
};

export type PrepareSandboxBuildPatchConfigInput = {
  channels: SandboxBuildPatchChannel[];
  activeMessagingChannels: readonly string[];
  messagingTokenDefs: readonly SandboxBuildPatchTokenDef[];
  discordSnowflakeRe: RegExp;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  deps?: SandboxBuildPatchConfigDeps;
};

export function prepareSandboxBuildPatchConfig({
  channels,
  activeMessagingChannels,
  messagingTokenDefs,
  discordSnowflakeRe,
  env = process.env,
  warn,
  deps = {},
}: PrepareSandboxBuildPatchConfigInput): SandboxBuildPatchConfig {
  const messagingChannelConfig = (
    deps.readMessagingChannelConfigFromEnv ?? readMessagingChannelConfigFromEnv
  )(env);
  const enabledTokenEnvKeys = new Set(messagingTokenDefs.map(({ envKey }) => envKey));
  const activeChannelNames = new Set(activeMessagingChannels);
  const { messagingAllowedIds, discordGuilds, slackConfig } = (
    deps.collectMessagingBuildConfig ?? collectMessagingBuildConfig
  )({
    channels,
    activeChannelNames,
    enabledTokenEnvKeys,
    env,
    discordSnowflakeRe,
    warn,
  });

  const telegramConfig: TelegramConfig = {};
  if (enabledTokenEnvKeys.has("TELEGRAM_BOT_TOKEN")) {
    const telegramRequireMention = (
      deps.computeTelegramRequireMention ?? computeTelegramRequireMention
    )();
    if (telegramRequireMention !== null) {
      telegramConfig.requireMention = telegramRequireMention;
    }
  }

  const loadSession = deps.loadSession ?? onboardSession.loadSession;
  const wechatConfig = (deps.gatherWechatConfig ?? gatherWechatConfig)(loadSession());
  (deps.updateSession ?? onboardSession.updateSession)((current) => {
    current.telegramConfig =
      typeof telegramConfig.requireMention === "boolean"
        ? { requireMention: telegramConfig.requireMention }
        : null;
    current.wechatConfig = (deps.toSessionWechatConfig ?? toSessionWechatConfig)(wechatConfig);
    current.messagingChannelConfig = messagingChannelConfig;
    return current;
  });

  return {
    messagingChannelConfig,
    enabledTokenEnvKeys,
    activeChannelNames,
    messagingAllowedIds,
    discordGuilds,
    slackConfig,
    telegramConfig,
    wechatConfig,
  };
}
