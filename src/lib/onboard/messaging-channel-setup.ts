// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getCredential,
  normalizeCredentialValue,
} from "../credentials/store";
import {
  createBuiltInChannelManifestRegistry,
  getMessagingManifestAvailabilityContext,
  hasMessagingManifestPrimaryCredential,
  MessagingWorkflowPlanner,
  resolveMessagingManifestSeed,
  toMessagingAgentId,
  type ChannelManifest,
  type ChannelSecretInputSpec,
  type SandboxMessagingPlan,
} from "../messaging";
import type { AgentDefinition } from "../agent/defs";

export interface SetupSelectedMessagingChannelsOptions {
  readonly agent?: { readonly name?: string } | null;
  readonly sandboxName?: string | null;
  readonly interactive?: boolean;
}

export interface SetupMessagingChannelsDeps {
  readonly step?: (current: number, total: number, label: string) => void;
  readonly note?: (message: string) => void;
  readonly isNonInteractive?: () => boolean;
  readonly checkTelegramReachability?: (token: string) => Promise<void>;
}

type SecretAvailabilitySnapshot = ReadonlyMap<string, ReadonlySet<string>>;

const getMessagingToken = (envKey: string): string | null =>
  normalizeCredentialValue(process.env[envKey]) || getCredential(envKey) || null;

export async function setupMessagingChannels(
  agent: AgentDefinition | null = null,
  existingChannels: string[] | null = null,
  deps: SetupMessagingChannelsDeps = {},
): Promise<string[]> {
  deps.step?.(5, 8, "Messaging channels");

  const note = deps.note ?? console.log;
  const isNonInteractive =
    deps.isNonInteractive ?? (() => process.env.NEMOCLAW_NON_INTERACTIVE === "1");
  const checkTelegramReachability = deps.checkTelegramReachability ?? (async () => {});
  const manifestRegistry = createBuiltInChannelManifestRegistry();
  const availabilityContext = getMessagingManifestAvailabilityContext(agent);
  const availableChannels = manifestRegistry.listAvailable(availabilityContext);
  const hasManifestCredentials = (manifest: ChannelManifest) =>
    hasMessagingManifestPrimaryCredential(manifest, getMessagingToken);
  const seedFromState = (includeAllExisting = false): string[] =>
    resolveMessagingManifestSeed(
      availableChannels,
      existingChannels,
      hasManifestCredentials,
      { includeAllExisting },
    );

  if (isNonInteractive() || process.env.NEMOCLAW_NON_INTERACTIVE === "1") {
    const enabled = new Set(seedFromState(false));
    const found = Array.from(enabled);
    if (found.length > 0) {
      note(`  [non-interactive] Messaging tokens detected: ${found.join(", ")}`);
      await setupSelectedMessagingChannels(found, enabled, availableChannels, {
        agent,
        interactive: false,
      });
      if (enabled.has("telegram")) {
        const telegramToken = getMessagingToken("TELEGRAM_BOT_TOKEN");
        if (telegramToken) {
          await checkTelegramReachability(telegramToken);
        }
      }
    } else {
      note("  [non-interactive] No messaging tokens configured. Skipping.");
    }
    return Array.from(enabled);
  }

  const enabled = new Set(seedFromState(true));
  const output = process.stderr;
  const linesAbovePrompt = availableChannels.length + 3;
  let firstDraw = true;
  const showList = () => {
    if (!firstDraw) {
      output.write(`\r\x1b[${linesAbovePrompt}A\x1b[J`);
    }
    firstDraw = false;
    output.write("\n");
    output.write("  Available messaging channels:\n");
    availableChannels.forEach((manifest, i) => {
      const marker = enabled.has(manifest.id) ? "●" : "○";
      const status = hasManifestCredentials(manifest) ? " (configured)" : "";
      output.write(
        `    [${i + 1}] ${marker} ${manifest.id} — ${
          manifest.description ?? manifest.displayName
        }${status}\n`,
      );
    });
    output.write("\n");
    output.write(`  Press 1-${availableChannels.length} to toggle, Enter when done: `);
  };

  showList();
  await readMessagingChannelSelection(availableChannels, enabled, showList);

  const selected = Array.from(enabled);
  if (selected.length === 0) {
    console.log("  Skipping messaging channels.");
    return [];
  }

  await setupSelectedMessagingChannels(selected, enabled, availableChannels, { agent });
  console.log("");

  if (!isNonInteractive() && enabled.has("telegram")) {
    const telegramToken = getMessagingToken("TELEGRAM_BOT_TOKEN");
    if (telegramToken) {
      await checkTelegramReachability(telegramToken);
    }
  }

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
  if (selectedChannels.length === 0) return null;

  const agent = toMessagingAgentId(options.agent);
  const sandboxName = options.sandboxName || "pending-sandbox";
  const planner = new MessagingWorkflowPlanner(registry);

  if (options.interactive === false) {
    const plan = await planner.planOnboard({
      sandboxName,
      agent,
      isInteractive: false,
      selectedChannels,
      supportedChannelIds,
      credentialAvailability: buildCredentialAvailability(registry, selectedChannels),
    });
    for (const channel of plan.channels) {
      if (!channel.active) enabled.delete(channel.channelId);
    }
    return plan;
  }

  for (const channelId of selectedChannels) {
    const manifest = registry.get(channelId);
    if (!manifest) continue;
    const initialSecretAvailability = snapshotSecretAvailability(registry, [channelId]);
    if (hasAllSecretInputsAvailable(manifest, initialSecretAvailability)) {
      printExistingSecretStatus(manifest);
      printEnrollmentNotes(manifest);
    }
    const enrolledPlan = await planner.planOnboard({
      sandboxName,
      agent,
      isInteractive: true,
      selectedChannels: [channelId],
      supportedChannelIds,
      credentialAvailability: buildCredentialAvailability(registry, [channelId]),
    });
    const enrolledChannel = enrolledPlan.channels.find((channel) => channel.channelId === channelId);
    if (!enrolledChannel?.active) {
      enabled.delete(channelId);
      continue;
    }
    if (manifest.auth.mode === "in-sandbox-qr") printInSandboxQrStatus(manifest);
  }

  const finalSelectedChannels = selectedChannels.filter((channelId) => enabled.has(channelId));
  const finalPlan = await planner.planOnboard({
    sandboxName,
    agent,
    isInteractive: false,
    selectedChannels: finalSelectedChannels,
    supportedChannelIds,
    credentialAvailability: buildCredentialAvailability(registry, finalSelectedChannels),
  });

  for (const channel of finalPlan.channels) {
    if (!channel.active) enabled.delete(channel.channelId);
  }

  return finalPlan;
}

function readMessagingChannelSelection(
  availableChannels: readonly ChannelManifest[],
  enabled: Set<string>,
  showList: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const input = process.stdin;
    const output = process.stderr;
    let rawModeEnabled = false;
    let finished = false;

    function cleanup() {
      input.removeListener("data", onData);
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
      }
      if (typeof input.pause === "function") {
        input.pause();
      }
      if (typeof input.unref === "function") {
        input.unref();
      }
    }

    function finish(): void {
      if (finished) return;
      finished = true;
      cleanup();
      output.write("\n");
      resolve();
    }

    function onData(chunk: Buffer | string): void {
      const text = chunk.toString("utf8");
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === "\u0003") {
          cleanup();
          reject(Object.assign(new Error("Prompt interrupted"), { code: "SIGINT" }));
          process.kill(process.pid, "SIGINT");
          return;
        }
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        }
        const num = parseInt(ch, 10);
        if (num >= 1 && num <= availableChannels.length) {
          const channel = availableChannels[num - 1];
          if (enabled.has(channel.id)) {
            enabled.delete(channel.id);
          } else {
            enabled.add(channel.id);
          }
          showList();
        }
      }
    }

    if (typeof input.ref === "function") {
      input.ref();
    }
    input.setEncoding("utf8");
    if (typeof input.resume === "function") {
      input.resume();
    }
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      rawModeEnabled = true;
    }
    input.on("data", onData);
  });
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

function snapshotSecretAvailability(
  registry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
  channelIds: readonly string[],
): SecretAvailabilitySnapshot {
  const availability = new Map<string, Set<string>>();
  for (const channelId of channelIds) {
    const manifest = registry.get(channelId);
    if (!manifest) continue;
    const availableInputs = new Set<string>();
    for (const input of manifest.inputs) {
      if (input.kind !== "secret" || !input.envKey) continue;
      if (getMessagingToken(input.envKey)) availableInputs.add(input.id);
    }
    availability.set(manifest.id, availableInputs);
  }
  return availability;
}

function buildCredentialAvailability(
  registry: ReturnType<typeof createBuiltInChannelManifestRegistry>,
  channelIds: readonly string[],
): Record<string, boolean> {
  const availability: Record<string, boolean> = {};
  for (const channelId of channelIds) {
    const manifest = registry.get(channelId);
    if (!manifest) continue;
    for (const input of manifest.inputs) {
      if (input.kind !== "secret" || !input.envKey || !getMessagingToken(input.envKey)) {
        continue;
      }
      availability[input.id] = true;
      availability[`${manifest.id}.${input.id}`] = true;
      availability[input.envKey] = true;
    }
  }
  return availability;
}

function hasAllSecretInputsAvailable(
  manifest: ChannelManifest,
  availability: SecretAvailabilitySnapshot,
): boolean {
  const secretInputs = manifest.inputs.filter(
    (entry): entry is ChannelSecretInputSpec => entry.kind === "secret",
  );
  return (
    secretInputs.length > 0 &&
    secretInputs.every((input) => availability.get(manifest.id)?.has(input.id) === true)
  );
}

function printExistingSecretStatus(manifest: ChannelManifest): void {
  const secretInputs = manifest.inputs.filter(
    (entry): entry is ChannelSecretInputSpec => entry.kind === "secret",
  );
  for (const input of secretInputs) {
    if (input.id === "botToken") {
      console.log(`  ✓ ${manifest.id} — already configured`);
    } else {
      console.log(`  ✓ ${manifest.id} ${tokenNoun(input.id)} — already configured`);
    }
  }
}

function printEnrollmentNotes(manifest: ChannelManifest): void {
  for (const line of manifest.enrollmentNotes ?? []) {
    console.log(`  ${line}`);
  }
}

function printInSandboxQrStatus(manifest: ChannelManifest): void {
  logEnrollmentHelp(manifest);
  console.log(
    `  ✓ ${manifest.id} enabled — complete QR pairing from inside the sandbox after rebuild.`,
  );
}

function tokenNoun(inputId: string): string {
  return inputId === "appToken" ? "app token" : "token";
}
