// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest, SandboxMessagingHealthCheckPlan } from "../../manifest";

export function planHealthChecks(manifest: ChannelManifest): SandboxMessagingHealthCheckPlan[] {
  return [
    {
      channelId: manifest.id,
      phase: "validation",
      requiredBefore: "lifecycle-success",
      hookIds: manifest.hooks
        .filter((hook) => hook.phase === "validation")
        .map((hook) => hook.id),
    },
  ];
}
