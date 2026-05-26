// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import { createWechatHealthCheckHookRegistration } from "./health-check";
import { createDefaultWechatHostQrLoginOptions } from "./host-qr-login-runtime";
import {
  createWechatIlinkLoginHookRegistration,
  type WechatIlinkLoginHookOptions,
} from "./ilink-login";
import {
  createWechatSeedOpenClawAccountHookRegistration,
  type WechatSeedOpenClawAccountHookOptions,
} from "./seed-openclaw-account";

export * from "./health-check";
export * from "./ilink-login";
export * from "./seed-openclaw-account";

export interface WechatHookOptions {
  readonly ilinkLogin?: WechatIlinkLoginHookOptions;
  readonly seedOpenClawAccount?: WechatSeedOpenClawAccountHookOptions;
}

export function createWechatHookRegistrations(
  options: WechatHookOptions = {},
): readonly MessagingHookRegistration[] {
  const ilinkLoginOptions = {
    ...createDefaultWechatHostQrLoginOptions(),
    ...options.ilinkLogin,
  };
  return [
    createWechatIlinkLoginHookRegistration(ilinkLoginOptions),
    createWechatSeedOpenClawAccountHookRegistration(options.seedOpenClawAccount),
    createWechatHealthCheckHookRegistration(),
  ] as const;
}
