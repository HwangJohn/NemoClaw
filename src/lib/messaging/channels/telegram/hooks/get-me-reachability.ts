// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeCredentialValue } from "../../../../credentials/store";
import type { MessagingHookHandler, MessagingHookRegistration } from "../../../hooks/types";

export const TELEGRAM_GET_ME_REACHABILITY_HOOK_ID = "telegram.getMeReachability";
const DEFAULT_TELEGRAM_REACHABILITY_TIMEOUT_MS = 10_000;

interface TelegramFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface TelegramFetchOptions {
  readonly signal?: AbortSignal;
}

type TelegramFetch = (
  url: string,
  options?: TelegramFetchOptions,
) => Promise<TelegramFetchResponse>;

export interface TelegramGetMeReachabilityHookOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: TelegramFetch;
  readonly apiBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly log?: (message: string) => void;
}

export function createTelegramGetMeReachabilityHook(
  options: TelegramGetMeReachabilityHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    const env = options.env ?? process.env;
    if (env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY === "1") {
      return {};
    }

    const rawToken = context.inputs?.botToken;
    const token = normalizeCredentialValue(typeof rawToken === "string" ? rawToken : "");
    if (!token) {
      throw new Error("Telegram reachability check requires botToken.");
    }

    const log = options.log ?? console.log;
    const isInteractive = context.isInteractive !== false;
    const response = await fetchTelegramGetMe(token, options).catch(() => {
      const message = "Telegram reachability check failed: Bot API request failed.";
      if (!isInteractive) throw new Error(message);
      log(`  ⚠ ${message}`);
      return null;
    });
    if (!response) return {};
    if (!response.ok) {
      logTelegramHttpWarning(response, log);
      return {};
    }

    const payload = await readTelegramJson(response);
    if (!isObject(payload) || payload.ok !== true) {
      log("  ⚠ Bot token was rejected by Telegram — verify the token is correct.");
    }

    return {};
  };
}

export function createTelegramHookRegistrations(
  options: TelegramGetMeReachabilityHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    {
      id: TELEGRAM_GET_ME_REACHABILITY_HOOK_ID,
      handler: createTelegramGetMeReachabilityHook(options),
    },
  ] as const;
}

async function fetchTelegramGetMe(
  token: string,
  options: TelegramGetMeReachabilityHookOptions,
): Promise<TelegramFetchResponse> {
  const fetchImpl = options.fetch ?? defaultFetch;
  const baseUrl = (options.apiBaseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  return fetchWithTimeout(fetchImpl, `${baseUrl}/bot${token}/getMe`, timeoutMs);
}

async function defaultFetch(
  url: string,
  options?: TelegramFetchOptions,
): Promise<TelegramFetchResponse> {
  if (typeof fetch !== "function") {
    throw new Error("Telegram reachability check requires global fetch.");
  }
  return fetch(url, options) as Promise<TelegramFetchResponse>;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TELEGRAM_REACHABILITY_TIMEOUT_MS;
}

async function fetchWithTimeout(
  fetchImpl: TelegramFetch,
  url: string,
  timeoutMs: number,
): Promise<TelegramFetchResponse> {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller?.abort();
      reject(new Error("Telegram reachability check timed out."));
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([
      fetchImpl(url, controller ? { signal: controller.signal } : undefined),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readTelegramJson(response: TelegramFetchResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch (_error) {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logTelegramHttpWarning(
  response: TelegramFetchResponse,
  log: (message: string) => void,
): void {
  if (response.status === 401 || response.status === 404) {
    log("  ⚠ Bot token was rejected by Telegram — verify the token is correct.");
    return;
  }
  log(
    `  ⚠ Telegram API returned HTTP ${response.status}${
      response.statusText ? ` ${response.statusText}` : ""
    } — the bot may not work correctly.`,
  );
}
