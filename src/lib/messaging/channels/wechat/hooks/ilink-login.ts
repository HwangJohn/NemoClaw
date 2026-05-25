// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeCredentialValue,
  saveCredential as saveProcessCredential,
} from "../../../../credentials/store";
import {
  runWechatHostQrLogin,
  type WechatLoginResult,
} from "../../../../../ext/wechat/login";
import type {
  MessagingHookHandler,
  MessagingHookOutputMap,
  MessagingHookRegistration,
} from "../../../hooks/types";
import type { MessagingSerializableValue } from "../../../manifest";

export const WECHAT_ILINK_LOGIN_HOOK_ID = "wechat.ilinkLogin";

export interface WechatIlinkLoginHookOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runLogin?: () => Promise<WechatLoginResult>;
  readonly saveCredential?: (key: string, value: string) => void;
}

export function createWechatIlinkLoginHook(
  options: WechatIlinkLoginHookOptions = {},
): MessagingHookHandler {
  return async (context) => {
    const runLogin = options.runLogin ?? (() => runWechatHostQrLogin());
    const result = await runLogin();
    if (result.kind !== "ok") {
      throw new Error(`WeChat host QR login failed: ${wechatFailureReason(result)}.`);
    }

    const env = options.env ?? process.env;
    const saveCredential = options.saveCredential ?? saveProcessCredential;
    const { token, accountId, baseUrl, userId } = result.credentials;

    saveCredential("WECHAT_BOT_TOKEN", token);
    env.WECHAT_BOT_TOKEN = token;
    env.WECHAT_ACCOUNT_ID = accountId;
    if (baseUrl) env.WECHAT_BASE_URL = baseUrl;
    if (userId) env.WECHAT_USER_ID = userId;

    const outputs: Record<string, MessagingHookOutputMap[string]> = {
      botToken: {
        kind: "secret",
        value: token,
      },
      accountId: {
        kind: "config",
        value: accountId,
      },
    };

    if (baseUrl) {
      outputs.baseUrl = {
        kind: "config",
        value: baseUrl,
      };
    }
    if (userId) {
      outputs.userId = {
        kind: "config",
        value: userId,
      };
    }
    if (declaresOutput(context.outputDeclarations, "allowedIds")) {
      const allowedIds = mergeCsvValues(readString(context.inputs?.allowedIds), userId);
      if (allowedIds) {
        env.WECHAT_ALLOWED_IDS = allowedIds;
        outputs.allowedIds = {
          kind: "config",
          value: allowedIds,
        };
      }
    }

    return { outputs };
  };
}

export function createWechatIlinkLoginHookRegistration(
  options: WechatIlinkLoginHookOptions = {},
): MessagingHookRegistration {
  return {
    id: WECHAT_ILINK_LOGIN_HOOK_ID,
    handler: createWechatIlinkLoginHook(options),
  };
}

function wechatFailureReason(result: Exclude<WechatLoginResult, { kind: "ok" }>): string {
  if (result.kind === "timeout") return "QR login timed out";
  if (result.kind === "expired") return "QR expired too many times";
  if (result.kind === "aborted") return "login aborted";
  return result.message || "unknown error";
}

function declaresOutput(
  declarations: readonly { readonly id: string }[] | undefined,
  outputId: string,
): boolean {
  return (declarations ?? []).some((declaration) => declaration.id === outputId);
}

function readString(value: MessagingSerializableValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function mergeCsvValues(existing: string, next: string): string {
  const values = new Set(
    normalizeCredentialValue(existing)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const normalized = normalizeCredentialValue(next);
  if (normalized) values.add(normalized);
  return Array.from(values).join(",");
}
