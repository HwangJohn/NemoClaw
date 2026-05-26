// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ChannelManifest,
  ChannelManifestAvailabilityContext,
  ChannelSecretInputSpec,
  MessagingAgentId,
  MessagingChannelId,
} from "./manifest";

export interface MessagingAgentDescriptor {
  readonly name?: string;
  readonly messagingPlatforms?: readonly MessagingChannelId[] | null;
}

export type MessagingCredentialResolver = (envKey: string) => string | null;

export function toMessagingAgentId(
  agent: MessagingAgentDescriptor | null | undefined,
): MessagingAgentId {
  return agent?.name === "hermes" ? "hermes" : "openclaw";
}

export function getMessagingManifestAvailabilityContext(
  agent: MessagingAgentDescriptor | null | undefined,
): ChannelManifestAvailabilityContext {
  return {
    agent: toMessagingAgentId(agent),
    supportedChannelIds:
      agent?.messagingPlatforms && agent.messagingPlatforms.length > 0
        ? agent.messagingPlatforms
        : null,
  };
}

export function resolveMessagingManifestSeed(
  manifests: readonly ChannelManifest[],
  existingChannels: readonly string[] | null | undefined,
  hasChannelCredentials: (manifest: ChannelManifest) => boolean,
  { includeAllExisting = false }: { readonly includeAllExisting?: boolean } = {},
): string[] {
  const seeded = new Set(
    manifests.filter(hasChannelCredentials).map((manifest) => manifest.id),
  );
  if (!Array.isArray(existingChannels)) return Array.from(seeded);

  const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  for (const channelId of existingChannels) {
    const manifest = manifestById.get(channelId);
    if (!manifest) continue;
    if (includeAllExisting || manifest.auth.mode === "in-sandbox-qr") {
      seeded.add(channelId);
    }
  }
  return Array.from(seeded);
}

export function hasMessagingManifestCredentials(
  manifest: ChannelManifest,
  resolveCredential: MessagingCredentialResolver,
): boolean {
  const requiredSecrets = manifest.inputs.filter(
    (input): input is ChannelSecretInputSpec =>
      input.kind === "secret" && input.required && Boolean(input.envKey),
  );
  if (requiredSecrets.length === 0) return false;
  return requiredSecrets.every((input) => Boolean(input.envKey && resolveCredential(input.envKey)));
}

export function hasMessagingManifestPrimaryCredential(
  manifest: ChannelManifest,
  resolveCredential: MessagingCredentialResolver,
): boolean {
  const primarySecret = manifest.inputs.find(
    (input): input is ChannelSecretInputSpec =>
      input.kind === "secret" && input.required && Boolean(input.envKey),
  );
  return Boolean(primarySecret?.envKey && resolveCredential(primarySecret.envKey));
}
