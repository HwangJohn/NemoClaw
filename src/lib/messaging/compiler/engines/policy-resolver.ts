// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifest,
  MessagingAgentId,
  SandboxMessagingNetworkPolicyEntryPlan,
  SandboxMessagingNetworkPolicyPlan,
} from "../../manifest";
import type { ManifestCompilerContext } from "../types";

const BUILTIN_POLICY_KEYS: Readonly<Record<string, readonly string[]>> = {
  telegram: ["telegram_bot"],
  discord: ["discord"],
  slack: ["slack"],
  wechat: ["wechat_bridge"],
  whatsapp: ["whatsapp"],
};

const AGENT_POLICY_KEY_ALIASES: Readonly<
  Record<MessagingAgentId, Readonly<Record<string, readonly string[]>>>
> = {
  openclaw: {},
  hermes: {
    wechat: ["wechat_bridge"],
  },
};

export function planNetworkPolicy(
  manifests: readonly ChannelManifest[],
  context: ManifestCompilerContext,
): SandboxMessagingNetworkPolicyPlan {
  const entries = manifests.flatMap((manifest) => planManifestPolicyEntries(manifest, context));
  return {
    presets: unique(entries.map((entry) => entry.presetName)),
    entries,
  };
}

function planManifestPolicyEntries(
  manifest: ChannelManifest,
  context: ManifestCompilerContext,
): SandboxMessagingNetworkPolicyEntryPlan[] {
  return (manifest.policyPresets ?? []).map((presetName) => {
    const agentAlias = AGENT_POLICY_KEY_ALIASES[context.agent][presetName];
    if (agentAlias) {
      return {
        channelId: manifest.id,
        presetName,
        policyKeys: agentAlias,
        source: "agent-alias",
      };
    }

    const builtinKeys = BUILTIN_POLICY_KEYS[presetName];
    return {
      channelId: manifest.id,
      presetName,
      policyKeys: builtinKeys ?? [presetName],
      source: builtinKeys ? "builtin" : "manifest",
    };
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
