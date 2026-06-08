// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { getCredential, normalizeCredentialValue } from "../credentials/store";
import * as registry from "../state/registry";
import {
  type ChannelInputSpec,
  type ChannelManifest,
  createBuiltInMessagingHookRegistry,
  createBuiltInChannelManifestRegistry,
  getMessagingManifestAvailabilityContext,
  hasMessagingManifestRequiredInputs,
  MessagingHostStateApplier,
  MessagingSetupApplier,
  MessagingWorkflowPlanner,
  resolveMessagingManifestSeed,
  type SandboxMessagingPlan,
  toMessagingAgentId,
} from "../messaging";
export { MessagingHostStateApplier };
import { resolveMessagingChannelConfigEnvValue } from "../messaging-channel-config";
import { hashCredential } from "../security/credential-hash";
import {
  promptMessagingChannelLineSelection,
  readMessagingChannelSelection,
  renderMessagingChannelList,
  type MessagingSelectorInput,
  type MessagingSelectorOutput,
} from "./messaging-selector";

export interface SetupSelectedMessagingChannelsOptions {
  readonly agent?: { readonly name?: string } | null;
  readonly sandboxName?: string | null;
  readonly interactive?: boolean;
}

export interface SetupMessagingChannelsDeps {
  readonly step?: (current: number, total: number, label: string) => void;
  readonly note?: (message: string) => void;
  readonly isNonInteractive?: () => boolean;
  readonly sandboxName?: string | null;
}

export interface BuildMessagingPlanForSandboxOptions {
  readonly agent?: AgentDefinition | null;
  readonly sandboxName: string;
  readonly configuredChannels?: readonly string[] | null;
  readonly disabledChannels?: readonly string[] | null;
  readonly providerExists?: (providerName: string) => boolean;
}

const getMessagingToken = (envKey: string): string | null =>
  normalizeCredentialValue(process.env[envKey]) || getCredential(envKey) || null;

const getMessagingInputValue = (input: ChannelInputSpec): string | null => {
  if (!input.envKey) return null;
  if (input.kind === "secret") return getMessagingToken(input.envKey);
  const resolved = resolveMessagingChannelConfigEnvValue(input.envKey, process.env);
  if (resolved.value) return resolved.value;
  return normalizeCredentialValue(process.env[input.envKey]) || null;
};

export async function setupMessagingChannels(
  agent: AgentDefinition | null = null,
  existingChannels: string[] | null = null,
  deps: SetupMessagingChannelsDeps = {},
): Promise<string[]> {
  deps.step?.(5, 8, "Messaging channels");

  const note = deps.note ?? console.log;
  const isNonInteractive =
    deps.isNonInteractive ?? (() => process.env.NEMOCLAW_NON_INTERACTIVE === "1");
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const availabilityContext = getMessagingManifestAvailabilityContext(agent);
  const availableChannels = manifestRegistry.listAvailable(availabilityContext);
  const hasManifestRequiredInputs = (manifest: ChannelManifest) =>
    hasMessagingManifestRequiredInputs(manifest, getMessagingInputValue);
  const seedFromState = (includeAllExisting = false): string[] =>
    resolveMessagingManifestSeed(availableChannels, existingChannels, hasManifestRequiredInputs, {
      includeAllExisting,
    });

  if (isNonInteractive() || process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
    const enabled = new Set(seedFromState(false));
    const found = Array.from(enabled);
    if (found.length > 0) {
      note(`  [non-interactive] Messaging channel inputs detected: ${found.join(", ")}`);
      await setupSelectedMessagingChannels(found, enabled, availableChannels, {
        agent,
        interactive: false,
        sandboxName: deps.sandboxName,
      });
    } else {
      MessagingSetupApplier.clearPlanEnv();
      note("  [non-interactive] No complete messaging channel inputs configured. Skipping.");
    }
    return Array.from(enabled);
  }

  const enabled = new Set(seedFromState(true));
  const input = process.stdin as MessagingSelectorInput;
  const output = process.stderr as MessagingSelectorOutput;
  const statusForChannel = (manifest: ChannelManifest): string =>
    hasManifestRequiredInputs(manifest) ? " (configured)" : "";

  if (availableChannels.length > 0) {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
      await promptMessagingChannelLineSelection(availableChannels, enabled, statusForChannel);
    } else {
      const linesAbovePrompt = availableChannels.length + 3;
      let firstDraw = true;
      const showList = () => {
        if (!firstDraw) {
          output.write(`\r\x1b[${linesAbovePrompt}A\x1b[J`);
        }
        firstDraw = false;
        renderMessagingChannelList(output, availableChannels, enabled, statusForChannel);
        output.write(
          `  Press 1-${availableChannels.length} to toggle, Enter when done (none selected skips): `,
        );
      };

      showList();
      await readMessagingChannelSelection(availableChannels, enabled, showList);
    }
  }

  const selected = Array.from(enabled);
  if (selected.length === 0) {
    MessagingSetupApplier.clearPlanEnv();
    console.log("  Skipping messaging channels.");
    return [];
  }

  await setupSelectedMessagingChannels(selected, enabled, availableChannels, {
    agent,
    sandboxName: deps.sandboxName,
  });
  console.log("");

  return Array.from(enabled);
}

/**
 * Prompt for token + per-channel config for each selected messaging channel.
 *
 * Enrollment now flows through the manifest-first architecture: selected
 * built-in manifests are planned with `MessagingWorkflowPlanner`, token paste
 * and host-QR acquisition run via registered hooks, and follow-up config prompts
 * are driven from manifest input metadata.
 */
export async function setupSelectedMessagingChannels(
  selected: readonly string[],
  enabled: Set<string>,
  messagingChannels: readonly ChannelManifest[],
  options: SetupSelectedMessagingChannelsOptions = {},
): Promise<SandboxMessagingPlan | null> {
  const registry = createBuiltInChannelManifestRegistry();
  const supportedChannelIds = messagingChannels.map((channel) => channel.id);
  const selectedChannels = uniqueSelectedChannels(selected, supportedChannelIds, registry);
  if (selectedChannels.length === 0) {
    MessagingSetupApplier.clearPlanEnv();
    return null;
  }

  const agent = toMessagingAgentId(options.agent);
  const sandboxName = resolveMessagingSetupSandboxName(options);
  const planner = new MessagingWorkflowPlanner(registry, createBuiltInMessagingHookRegistry());

  if (options.interactive === false) {
    const credentials = buildCredentialCompilerContext(registry, selectedChannels);
    const plan = await planner.buildPlan({
      sandboxName,
      agent,
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: selectedChannels,
      supportedChannelIds,
      credentialAvailability: credentials.availability,
      credentialHashes: credentials.hashes,
    });
    MessagingSetupApplier.writePlanToEnv(plan);
    for (const channel of plan.channels) {
      if (!channel.active) enabled.delete(channel.channelId);
    }
    return plan;
  }

  const credentials = buildCredentialCompilerContext(registry, selectedChannels);
  const plan = await planner.buildPlan({
    sandboxName,
    agent,
    workflow: "onboard",
    isInteractive: true,
    configuredChannels: selectedChannels,
    supportedChannelIds,
    credentialAvailability: credentials.availability,
    credentialHashes: credentials.hashes,
  });
  MessagingSetupApplier.writePlanToEnv(plan);

  for (const channel of plan.channels) {
    if (!channel.active) {
      enabled.delete(channel.channelId);
      continue;
    }
    const manifest = registry.get(channel.channelId);
    if (manifest?.auth.mode === "in-sandbox-qr") printInSandboxQrStatus(manifest);
  }

  return plan;
}

export async function buildMessagingPlanForSandbox(
  options: BuildMessagingPlanForSandboxOptions,
): Promise<SandboxMessagingPlan | null> {
  const registry = createBuiltInChannelManifestRegistry();
  const agent = toMessagingAgentId(options.agent);
  const availableChannels = registry.listAvailable(
    getMessagingManifestAvailabilityContext(options.agent ?? null),
  );
  const supportedChannelIds = availableChannels.map((channel) => channel.id);
  const selectedChannels =
    options.configuredChannels !== undefined && options.configuredChannels !== null
      ? uniqueSelectedChannels(options.configuredChannels, supportedChannelIds, registry)
      : resolveMessagingManifestSeed(
          availableChannels,
          null,
          (manifest) => hasMessagingManifestRequiredInputs(manifest, getMessagingInputValue),
          { includeAllExisting: false },
        );
  if (selectedChannels.length === 0) return null;

  const credentials = buildCredentialCompilerContext(registry, selectedChannels);
  applyGatewayProviderAvailability(credentials.availability, registry, selectedChannels, options);
  const planner = new MessagingWorkflowPlanner(registry);
  return planner.buildPlan({
    sandboxName: options.sandboxName,
    agent,
    workflow: "rebuild",
    isInteractive: false,
    configuredChannels: selectedChannels,
    disabledChannels: options.disabledChannels ?? [],
    supportedChannelIds,
    credentialAvailability: credentials.availability,
    credentialHashes: credentials.hashes,
  });
}

function applyGatewayProviderAvailability(
  availability: Record<string, boolean>,
  registry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
  channelIds: readonly string[],
  options: BuildMessagingPlanForSandboxOptions,
): void {
  if (!options.providerExists) return;
  for (const channelId of channelIds) {
    const manifest = registry.get(channelId);
    if (!manifest) continue;
    for (const credential of manifest.credentials) {
      const providerName = credential.providerName.replaceAll(
        "{sandboxName}",
        options.sandboxName,
      );
      if (!options.providerExists(providerName)) continue;
      availability[credential.sourceInput] = true;
      availability[`${manifest.id}.${credential.sourceInput}`] = true;
      availability[credential.id] = true;
      availability[`${manifest.id}.${credential.id}`] = true;
      availability[credential.providerEnvKey] = true;
    }
  }
}

function uniqueSelectedChannels(
  selected: readonly string[],
  supportedChannelIds: readonly string[],
  registry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
): string[] {
  const supported = new Set(supportedChannelIds);
  const result: string[] = [];
  for (const rawName of selected) {
    const name = rawName.trim().toLowerCase();
    if (!supported.has(name) || !registry.get(name)) {
      console.log(`  Unknown channel: ${rawName}`);
      continue;
    }
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

function logEnrollmentHelp(manifest: ChannelManifest): void {
  const help = manifest.enrollmentHelp ?? manifest.inputs[0]?.prompt?.help;
  if (!help) return;
  console.log("");
  console.log(`  ${help}`);
}

function buildCredentialCompilerContext(
  registry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
  channelIds: readonly string[],
): { readonly availability: Record<string, boolean>; readonly hashes: Record<string, string> } {
  const availability: Record<string, boolean> = {};
  const hashes: Record<string, string> = {};
  for (const channelId of channelIds) {
    const manifest = registry.get(channelId);
    if (!manifest) continue;
    for (const input of manifest.inputs) {
      if (input.kind !== "secret" || !input.envKey) {
        continue;
      }
      const token = getMessagingToken(input.envKey);
      if (!token) continue;
      availability[input.id] = true;
      availability[`${manifest.id}.${input.id}`] = true;
      availability[input.envKey] = true;
      const hash = hashCredential(token);
      if (!hash) continue;
      hashes[input.id] = hash;
      hashes[`${manifest.id}.${input.id}`] = hash;
      hashes[input.envKey] = hash;
    }
  }
  return { availability, hashes };
}

function printInSandboxQrStatus(manifest: ChannelManifest): void {
  logEnrollmentHelp(manifest);
  console.log(
    `  ✓ ${manifest.id} enabled — complete QR pairing from inside the sandbox after rebuild.`,
  );
  for (const line of manifest.enrollmentNotes ?? []) {
    console.log(`  ${line}`);
  }
}

export function readMessagingPlanFromEnv(): SandboxMessagingPlan | null {
  return MessagingSetupApplier.readPlanFromEnv();
}

export function writePlanToEnv(plan: SandboxMessagingPlan): void {
  MessagingSetupApplier.writePlanToEnv(plan);
}

export function getRegistrySandboxMessagingPlan(sandboxName: string): SandboxMessagingPlan | null {
  return registry.getSandbox(sandboxName)?.messaging?.plan ?? null;
}

function resolveMessagingSetupSandboxName(options: SetupSelectedMessagingChannelsOptions): string {
  const explicitName = normalizeSandboxName(options.sandboxName);
  if (explicitName) return explicitName;
  const envName = normalizeSandboxName(process.env.NEMOCLAW_SANDBOX_NAME);
  if (envName) return envName;
  return options.agent?.name === "hermes" ? "hermes" : "my-assistant";
}

function normalizeSandboxName(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
