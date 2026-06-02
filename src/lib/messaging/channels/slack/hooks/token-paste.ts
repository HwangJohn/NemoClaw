// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  formatSlackValidationFailure,
  type SlackTokenKind,
  validateSlackCredentials,
} from "../../../../onboard/slack-validation";
import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";
import type {
  ChannelHookOutputSpec,
  ChannelSecretInputSpec,
  MessagingSerializableValue,
} from "../../../manifest";
import { slackManifest } from "../manifest";

export const SLACK_TOKEN_PASTE_HOOK_HANDLER_ID = "slack.tokenPaste";

export interface SlackTokenPasteHookOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly getCredential?: (key: string) => string | null;
  readonly saveCredential?: (key: string, value: string) => void;
  readonly prompt?: (question: string, options?: { readonly secret?: boolean }) => Promise<string>;
  readonly log?: (message: string) => void;
  readonly validateCredentials?: typeof validateSlackCredentials;
  readonly formatValidationFailure?: typeof formatSlackValidationFailure;
}

interface SlackSecretField {
  readonly id: string;
  readonly envKey: string;
  readonly label: string;
  readonly help?: string;
  readonly format?: RegExp;
  readonly formatHint?: string;
  readonly kind: SlackTokenKind;
}

interface CollectedSlackToken {
  readonly field: SlackSecretField;
  readonly token: string;
  readonly source: "existing" | "prompted";
}

export function createSlackTokenPasteHook(
  options: SlackTokenPasteHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    const declarations = (context.outputDeclarations ?? []).filter(
      (output) => output.kind === "secret",
    );
    const collected: CollectedSlackToken[] = [];
    for (const output of declarations) {
      const field = resolveSlackSecretField(output);
      if (!field) throw new Error(`No Slack token field registered for ${output.id}`);
      collected.push(
        await collectSlackToken(field, options, context.isInteractive !== false),
      );
    }

    const byId = new Map(collected.map((entry) => [entry.field.id, entry]));
    const bot = byId.get("botToken");
    const app = byId.get("appToken");
    if (!bot || !app) {
      throw new Error("Slack requires both SLACK_BOT_TOKEN and SLACK_APP_TOKEN.");
    }

    validateCollectedSlackTokens(bot, app, options);
    persistCollectedSlackTokens(collected, options);

    return {
      outputs: Object.fromEntries(
        collected.map((entry) => [
          entry.field.id,
          {
            kind: "secret",
            value: entry.token as MessagingSerializableValue,
          },
        ]),
      ),
    };
  };
}

export function createSlackTokenPasteHookRegistration(
  options: SlackTokenPasteHookOptions = {},
): MessagingHookRegistration {
  return {
    id: SLACK_TOKEN_PASTE_HOOK_HANDLER_ID,
    handler: createSlackTokenPasteHook(options),
  };
}

async function collectSlackToken(
  field: SlackSecretField,
  options: SlackTokenPasteHookOptions,
  isInteractive: boolean,
): Promise<CollectedSlackToken> {
  const env = options.env ?? process.env;
  const readCredential = options.getCredential ?? (() => null);
  const prompt = options.prompt ?? missingSlackPrompt;
  const log = options.log ?? console.log;

  let token = normalizeCredentialValue(env[field.envKey]) || readCredential(field.envKey) || "";
  let source: "existing" | "prompted" = "existing";
  if (token && field.format && !field.format.test(token)) {
    log(`  ✗ Invalid format. ${field.formatHint || "Check the token and try again."}`);
    if (!isInteractive) {
      log(formatSkippedInvalidTokenMessage(field));
      throw new Error(
        `Invalid token format for ${field.envKey}. ${
          field.formatHint || "Check the token and try again."
        }`,
      );
    }
    log(`  ✗ Invalid existing slack ${tokenNoun(field)} ignored.`);
    token = "";
  }

  if (!token) {
    if (!isInteractive) {
      log(formatSkippedNoTokenMessage(field));
      throw new Error(`No token entered for ${field.envKey}.`);
    }
    if (field.help) {
      log("");
      log(`  ${field.help}`);
    }
    token = normalizeCredentialValue(await prompt(`  ${field.label}: `, { secret: true }));
    source = "prompted";
  }

  if (!token) {
    log(formatSkippedNoTokenMessage(field));
    throw new Error(`No token entered for ${field.envKey}.`);
  }

  if (field.format && !field.format.test(token)) {
    log(`  ✗ Invalid format. ${field.formatHint || "Check the token and try again."}`);
    log(formatSkippedInvalidTokenMessage(field));
    throw new Error(
      `Invalid token format for ${field.envKey}. ${
        field.formatHint || "Check the token and try again."
      }`,
    );
  }

  return { field, token, source };
}

function validateCollectedSlackTokens(
  bot: CollectedSlackToken,
  app: CollectedSlackToken,
  options: SlackTokenPasteHookOptions,
): void {
  const validate = options.validateCredentials ?? validateSlackCredentials;
  const validation = validate({ botToken: bot.token, appToken: app.token });
  if (validation.ok) {
    if (validation.skipped && validation.message) {
      (options.log ?? console.log)(`  ⚠ ${validation.message}`);
    }
    return;
  }

  const log = options.log ?? console.log;
  const failing = validation.credential === "bot" ? bot : app;
  if (failing.source === "existing") {
    log(`  ✗ Invalid existing slack ${tokenNoun(failing.field)} ignored.`);
  }
  const formatFailure = options.formatValidationFailure ?? formatSlackValidationFailure;
  const prefix = validation.kind === "rejected" ? "✗" : "⚠";
  log(`  ${prefix} ${formatFailure(validation)}`);
  log(
    `  Skipped slack (${
      validation.kind === "rejected"
        ? "invalid Slack credentials"
        : "Slack API validation unavailable"
    })`,
  );
  throw new Error(`Slack credential validation failed: ${formatFailure(validation)}`);
}

function persistCollectedSlackTokens(
  collected: readonly CollectedSlackToken[],
  options: SlackTokenPasteHookOptions,
): void {
  const env = options.env ?? process.env;
  const writeCredential = options.saveCredential ?? (() => {});
  const log = options.log ?? console.log;

  for (const entry of collected) {
    env[entry.field.envKey] = entry.token;
    if (entry.source === "prompted") {
      writeCredential(entry.field.envKey, entry.token);
      log(`  ✓ slack ${tokenNoun(entry.field)} saved`);
    } else {
      log(
        entry.field.id === "botToken"
          ? "  ✓ slack — already configured"
          : `  ✓ slack ${tokenNoun(entry.field)} — already configured`,
      );
    }
  }
}

function resolveSlackSecretField(output: ChannelHookOutputSpec): SlackSecretField | null {
  const input = slackManifest.inputs.find(
    (entry) => entry.kind === "secret" && entry.id === output.id,
  ) as ChannelSecretInputSpec | undefined;
  if (!input?.envKey) return null;
  return {
    id: input.id,
    envKey: input.envKey,
    label: input.prompt?.label ?? input.envKey,
    help: input.prompt?.help,
    format: input.formatPattern ? new RegExp(input.formatPattern) : undefined,
    formatHint: input.formatHint,
    kind: input.id === "appToken" ? "app" : "bot",
  };
}

async function missingSlackPrompt(): Promise<string> {
  throw new Error("Slack token-paste hook requires an injected prompt implementation.");
}

function normalizeCredentialValue(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").trim();
}

function tokenNoun(field: SlackSecretField): string {
  return field.id === "appToken" ? "app token" : "token";
}

function formatSkippedNoTokenMessage(field: SlackSecretField): string {
  if (field.id === "appToken") {
    return "  Skipped slack app token (Socket Mode requires both tokens)";
  }
  return "  Skipped slack (no token entered)";
}

function formatSkippedInvalidTokenMessage(field: SlackSecretField): string {
  if (field.id === "appToken") {
    return "  Skipped slack app token (invalid token format)";
  }
  return "  Skipped slack (invalid token format)";
}
