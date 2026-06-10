// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Integration test for the docker-unreachable abort path in
// startGatewayWithOptions() (src/lib/onboard.ts:2233).
//
// Replaces test/e2e/test-docker-unreachable-gateway-start.sh, which was
// structurally a Node-process unit test of startGateway() with a PATH-
// shimmed openshell binary, not a sandbox-lifecycle e2e.
//
// Original regression: NemoClaw #2347.
// Owning migration issue: NemoClaw #4355.
//
// STAGE 1 (this commit): test plan committed as it.todo() placeholders so
// the contract is reviewable before the mocks land. The legacy script and
// the regression-e2e job that runs it remain in place until Stage 2.
//
// STAGE 2 (follow-up): implement the test bodies, then in the same PR
// transition the inventory entry to status=retired with deletionReady=true,
// delete test/e2e/test-docker-unreachable-gateway-start.sh, and remove the
// docker-unreachable-gateway-start-e2e job from
// .github/workflows/regression-e2e.yaml (job + Valid: allowlist + the
// includes_job() guard).
//
// Mocking surface (Stage 2):
//   - vi.mock("./gateway")               → streamGatewayStart returns
//                                          { status: 1, output: "...Failed
//                                          to create Docker client...
//                                          Socket not found:
//                                          /var/run/docker.sock" }
//   - vi.mock("../runner")               → run, runCapture become spies;
//                                          assert NEVER called with
//                                          ["status"] or
//                                          ["gateway","info",...] after
//                                          streamGatewayStart returns.
//   - vi.mock("../adapters/openshell/resolve") → resolveOpenshell returns a
//                                                deterministic stub path so
//                                                getOpenshellBinary() does
//                                                not hit the filesystem.
//
// Process / env shape (Stage 2, mirrors legacy script):
//   - vi.spyOn(process, "exit") → throw, so assertions can run after
//     handleFinalGatewayStartFailure({dockerUnreachable:true}) calls
//     exitProcess(1). Pattern from docker-driver-gateway-failure.test.ts.
//   - Object.defineProperty(process, "platform", {value: "darwin"}) per
//     test, restored in afterEach. Drive printDockerDaemonRecovery's
//     branch selection.
//   - process.env.NEMOCLAW_NON_INTERACTIVE = "1"
//   - process.env.NEMOCLAW_HEALTH_POLL_COUNT = "5"  (a low ceiling so a
//     bug that *does* enter the health-poll loop fails the test in
//     bounded time instead of hanging.)
//
// Access path: startGateway is exposed via module.exports at the bottom
// of src/lib/onboard.ts (line 6832). Stage 2 will import it via
// `await import("../onboard")` after vi.mock declarations.

import { describe, it } from "vitest";

describe("startGatewayWithOptions docker-unreachable abort (#2347)", () => {
  // Assertion 1 (legacy script: NODE_EXIT == 1)
  it.todo("aborts with exit 1 when streamGatewayStart returns docker-unreachable signature");

  // Assertion 2 (legacy script: grep "Docker daemon is not running")
  it.todo("prints the Docker recovery guidance with macOS colima hint when platform=darwin");

  // Coverage extension over legacy: legacy only tested darwin; covering
  // the linux branch closes a printDockerDaemonRecovery gap.
  it.todo("prints the Linux systemctl hint when platform=linux");

  // Assertion 4 (legacy script: !grep "Waiting for gateway health")
  it.todo("never logs 'Waiting for gateway health...' after docker-unreachable detection");

  // Assertions 5+6 (legacy script: !grep "HEALTH POLL REACHED" in node
  // log AND no post-__GATEWAY_START__ status/gateway-info probes in
  // openshell trace log)
  it.todo(
    "never invokes openshell status or gateway info probes after docker-unreachable detection",
  );

  // Assertion 7 (legacy script: !grep "openshell doctor logs")
  it.todo(
    "does not collect doctor logs (handleFinalGatewayStartFailure short-circuits on dockerUnreachable=true)",
  );

  // Structural: the pRetry.AbortError must propagate; if a future refactor
  // accidentally swallows it and continues retrying, this catches that.
  it.todo("does not retry on docker-unreachable (pRetry.AbortError bypasses the outer retries)");
});
