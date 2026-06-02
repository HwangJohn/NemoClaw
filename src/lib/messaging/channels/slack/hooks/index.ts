// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistration } from "../../../hooks/types";
import { createDefaultSlackTokenPasteOptions } from "./token-paste-runtime";
import {
  createSlackTokenPasteHookRegistration,
  type SlackTokenPasteHookOptions,
} from "./token-paste";

export * from "./token-paste";

export interface SlackHookOptions {
  readonly tokenPaste?: SlackTokenPasteHookOptions;
}

export function createSlackHookRegistrations(
  options: SlackHookOptions = {},
): readonly MessagingHookRegistration[] {
  return [
    createSlackTokenPasteHookRegistration({
      ...createDefaultSlackTokenPasteOptions(),
      ...withoutUndefinedValues(options.tokenPaste),
    }),
  ] as const;
}

function withoutUndefinedValues(
  options: SlackTokenPasteHookOptions | undefined,
): SlackTokenPasteHookOptions {
  return Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  ) as SlackTokenPasteHookOptions;
}
