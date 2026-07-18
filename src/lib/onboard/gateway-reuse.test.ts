// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import { createGatewayReuseHelpers } from "./gateway-reuse";

describe("gateway reuse snapshot", () => {
  it("bounds OpenShell gateway inspection probes (#6752)", () => {
    const runCaptureOpenshell = vi.fn(() => "");
    const helpers = createGatewayReuseHelpers({
      gatewayName: "nemoclaw",
      runCaptureOpenshell,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      cliDisplayName: () => "NemoClaw",
    });

    helpers.getGatewayReuseSnapshot();

    expect(runCaptureOpenshell).toHaveBeenCalledWith(["status"], {
      ignoreError: true,
      includeStderr: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    expect(runCaptureOpenshell).toHaveBeenCalledWith(["gateway", "info", "-g", "nemoclaw"], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    expect(runCaptureOpenshell).toHaveBeenCalledWith(["gateway", "info"], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
  });

  it("classifies status stderr connection refusals as stale when gateway info is unavailable (#7087)", () => {
    const statusOutput = [
      "Server Status",
      "",
      "  Gateway: nemoclaw",
      "Error: Connection refused",
    ].join("\n");
    const runCaptureOpenshell = vi.fn((args: string[], opts?: Record<string, unknown>) =>
      args[0] === "status" && opts?.includeStderr === true ? statusOutput : "",
    );
    const helpers = createGatewayReuseHelpers({
      gatewayName: "nemoclaw",
      runCaptureOpenshell,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      cliDisplayName: () => "NemoClaw",
    });

    expect(helpers.getGatewayReuseSnapshot().gatewayReuseState).toBe("stale");
  });
});
