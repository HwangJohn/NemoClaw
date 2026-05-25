// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../manifest";
import type { MessagingPolicyApplyOptions, MessagingPolicyApplyResult } from "./types";

export function applyPolicyAtOpenShell(
  plan: SandboxMessagingPlan,
  options: MessagingPolicyApplyOptions,
): MessagingPolicyApplyResult {
  const activePresets = uniqueStrings(plan.networkPolicy.presets);
  if (activePresets.length > 0 && !options.applyPresets(plan.sandboxName, activePresets)) {
    throw new Error(`Failed to apply messaging policy preset(s): ${activePresets.join(", ")}`);
  }

  return {
    appliedPresets: activePresets,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
