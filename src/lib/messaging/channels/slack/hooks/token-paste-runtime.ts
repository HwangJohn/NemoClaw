// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getCredential, prompt, saveCredential } from "../../../../credentials/store";
import type { SlackTokenPasteHookOptions } from "./token-paste";

export function createDefaultSlackTokenPasteOptions(): SlackTokenPasteHookOptions {
  return {
    getCredential,
    saveCredential,
    prompt,
    log: (message) => console.log(message),
  };
}
