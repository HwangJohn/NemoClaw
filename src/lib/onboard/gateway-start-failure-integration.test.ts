// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Integration tests for the docker-unreachable abort path that
// startGatewayWithOptions() takes when `openshell gateway start` reports
// the Docker daemon is not reachable. See src/lib/onboard.ts:2233.
//
// This file replaces test/e2e/test-docker-unreachable-gateway-start.sh,
// which was structurally a Node-process unit test of startGateway() with a
// PATH-shimmed openshell binary, not a sandbox-lifecycle e2e.
//
// Original regression: NemoClaw #2347.
// Owning migration issue: NemoClaw #4355.
//
// Coverage strategy: instead of mocking the ten-or-so module-internal
// closures inside startGatewayWithOptions (which would produce a brittle
// orchestrator integration test), prove the contract through three layers:
//
//   1. Unit tests of the already-exported helpers (printDockerDaemonRecovery,
//      handleFinalGatewayStartFailure with dockerUnreachable=true).
//   2. A composition test that runs the same helper sequence the call site
//      uses (classify → handleFinal → exitProcess(1)).
//   3. A structural assertion against onboard.ts source proving the call-site
//      wiring is in place. This catches refactors that accidentally drop the
//      pRetry.AbortError throw or skip the dockerUnreachable flag.

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// `handleFinalGatewayStartFailure` is exposed via `module.exports = {...}` at
// the bottom of onboard.ts (it is not a TypeScript `export`). Import the
// compiled output (same approach as preflight.test.ts and other onboard-
// adjacent tests) so the CommonJS `require()` calls in onboard.ts and its
// transitive dependencies resolve cleanly under Vitest. Coverage also lands
// on dist/lib/onboard.js, matching what the coverage ratchet measures.
import onboardExports from "../../../dist/lib/onboard";
import { classifyGatewayStartFailure } from "../validation";
import {
  printDockerDaemonRecovery,
  reportLegacyGatewayStartResultFailure,
} from "./gateway-start-failure";

const handleFinalGatewayStartFailure: (opts: {
  retries: number;
  dockerUnreachable?: boolean;
  collectDiagnostics?: () => string;
  cleanupGateway?: () => void;
  exitProcess?: (code: number) => never;
  printError?: (message?: string) => void;
}) => never = (onboardExports as unknown as Record<string, unknown>)
  .handleFinalGatewayStartFailure as never;

// Real signatures the legacy script's fake openshell binary emitted from
// `gateway start` to simulate Colima-stopped (macOS) and dockerd-stopped
// (Linux). These are the wire format the call site sees from
// streamGatewayStart()'s `output` field.
const DARWIN_DOCKER_UNREACHABLE_OUTPUT = [
  "Error: Failed to create Docker client.",
  "Socket not found: /var/run/docker.sock",
].join("\n");

const LINUX_DOCKER_UNREACHABLE_OUTPUT =
  "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

describe("startGatewayWithOptions docker-unreachable abort (#2347)", () => {
  // ── Layer 1: unit tests of the platform-branching recovery message ────────

  describe("printDockerDaemonRecovery platform branches", () => {
    it("prints the macOS/colima recovery hint when platform=darwin", () => {
      const printed: string[] = [];
      printDockerDaemonRecovery((message = "") => printed.push(message), "darwin");
      const joined = printed.join("\n");
      expect(joined).toContain("Docker daemon is not running");
      expect(joined).toContain("colima start");
      expect(joined).not.toContain("systemctl");
    });

    it("prints the Linux/systemctl recovery hint when platform=linux", () => {
      const printed: string[] = [];
      printDockerDaemonRecovery((message = "") => printed.push(message), "linux");
      const joined = printed.join("\n");
      expect(joined).toContain("Docker daemon is not running");
      expect(joined).toContain("sudo systemctl start docker");
      expect(joined).not.toContain("colima start");
    });

    it("prints a platform-neutral fallback hint on other platforms", () => {
      const printed: string[] = [];
      printDockerDaemonRecovery((message = "") => printed.push(message), "win32");
      const joined = printed.join("\n");
      expect(joined).toContain("Docker daemon is not running");
      expect(joined).toContain("Start the Docker daemon");
      expect(joined).not.toContain("colima start");
      expect(joined).not.toContain("systemctl");
    });
  });

  // ── Layer 1: handleFinalGatewayStartFailure dockerUnreachable branch ─────
  //
  // Proves three things at once:
  //   - exitProcess(1) is called → covers the legacy script's NODE_EXIT==1
  //     assertion.
  //   - collectDiagnostics is NEVER called → covers the legacy script's
  //     `!grep "openshell doctor logs"` assertion (the script's assertion 7).
  //   - cleanupGateway is NEVER called → covers the legacy script's implicit
  //     contract that destroyGateway is not invoked on Docker-unreachable
  //     (preserving any prior good gateway state for the user).
  //   - printError is invoked with the recovery guidance → composition with
  //     printDockerDaemonRecovery.

  describe("handleFinalGatewayStartFailure({dockerUnreachable: true})", () => {
    it("calls exitProcess(1) and skips diagnostics + cleanup", () => {
      const printError = vi.fn();
      const collectDiagnostics = vi.fn(() => "should-never-be-collected");
      const cleanupGateway = vi.fn();
      const exitProcess = vi.fn((code: number) => {
        // Throw so the function's `: never` signature is honored from the
        // test's perspective without actually terminating the process.
        throw new Error(`__exitProcess(${code})`);
      }) as (code: number) => never;

      expect(() =>
        handleFinalGatewayStartFailure({
          retries: 2,
          dockerUnreachable: true,
          printError,
          collectDiagnostics,
          cleanupGateway,
          exitProcess,
        }),
      ).toThrow(/__exitProcess\(1\)/);

      expect(exitProcess).toHaveBeenCalledTimes(1);
      expect(exitProcess).toHaveBeenCalledWith(1);
      // The crucial behavioural difference from the non-Docker-unreachable
      // path: no doctor logs are collected and no cleanup is attempted.
      expect(collectDiagnostics).not.toHaveBeenCalled();
      expect(cleanupGateway).not.toHaveBeenCalled();

      const printed = printError.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(printed).toContain("Docker daemon is not running");
    });

    it("DOES collect diagnostics and clean up when dockerUnreachable=false (negative control)", () => {
      // Guards against a future refactor that accidentally short-circuits the
      // non-Docker-unreachable branch as well.
      const printError = vi.fn();
      const collectDiagnostics = vi.fn(() => "");
      const cleanupGateway = vi.fn();
      const exitProcess = vi.fn(() => {
        throw new Error("__exitProcess");
      }) as (code: number) => never;

      try {
        handleFinalGatewayStartFailure({
          retries: 2,
          dockerUnreachable: false,
          printError,
          collectDiagnostics,
          cleanupGateway,
          exitProcess,
        });
      } catch {
        // expected — handleFinal still calls exitProcess on the unhealthy
        // (non-Docker-unreachable) branch by way of the surrounding caller;
        // here the function returns normally if exitProcess does not throw.
      }

      expect(collectDiagnostics).toHaveBeenCalled();
      expect(cleanupGateway).toHaveBeenCalled();
    });
  });

  // ── Layer 2: composition test — the exact sequence the call site uses ────
  //
  // startGatewayWithOptions does, on `streamGatewayStart()` failure:
  //
  //     const failure = reportLegacyGatewayStartResultFailure(output, log);
  //     if (failure.kind === "docker_unreachable") {
  //       dockerUnreachable = true;
  //       throw new pRetry.AbortError(...);
  //     }
  //   } catch {
  //     if (exitOnFailure) {
  //       handleFinalGatewayStartFailure({ retries, dockerUnreachable });
  //     }
  //     throw new Error("Gateway failed to start");
  //   }
  //
  // The composition test exercises the same helpers in the same order and
  // confirms the chain bottoms out at exitProcess(1) with the recovery
  // message printed.

  describe("composition: classify → handleFinal → exit 1", () => {
    let capturedClassifyLog: string[];
    let capturedPrintError: string[];

    function runComposition(streamGatewayStartOutput: string): {
      thrown: unknown;
      exitCode: number | null;
    } {
      capturedClassifyLog = [];
      capturedPrintError = [];

      const failure = reportLegacyGatewayStartResultFailure(streamGatewayStartOutput, (m) =>
        capturedClassifyLog.push(m),
      );

      let dockerUnreachable = false;
      if (failure.kind === "docker_unreachable") {
        dockerUnreachable = true;
      }

      let exitCode: number | null = null;
      let thrown: unknown = null;
      try {
        handleFinalGatewayStartFailure({
          retries: 2,
          dockerUnreachable,
          printError: (m = "") => capturedPrintError.push(m),
          collectDiagnostics: () => {
            throw new Error("collectDiagnostics must not be called on docker_unreachable");
          },
          cleanupGateway: () => {
            throw new Error("cleanupGateway must not be called on docker_unreachable");
          },
          exitProcess: ((code: number) => {
            exitCode = code;
            throw new Error(`__exit(${code})`);
          }) as (code: number) => never,
        });
      } catch (err) {
        thrown = err;
      }
      return { thrown, exitCode };
    }

    it("composes through the docker-unreachable path on the macOS Colima signature", () => {
      const { thrown, exitCode } = runComposition(DARWIN_DOCKER_UNREACHABLE_OUTPUT);
      expect(thrown).toBeInstanceOf(Error);
      expect(exitCode).toBe(1);
      expect(capturedPrintError.join("\n")).toContain("Docker daemon is not running");
      // The classification helper logs the original output as a breadcrumb;
      // the legacy script asserts on this output too via its `[INFO] node
      // exit code` log lines.
      expect(capturedClassifyLog.join("\n")).toContain("Gateway start returned before healthy");
    });

    it("composes through the docker-unreachable path on the Linux dockerd signature", () => {
      const { thrown, exitCode } = runComposition(LINUX_DOCKER_UNREACHABLE_OUTPUT);
      expect(thrown).toBeInstanceOf(Error);
      expect(exitCode).toBe(1);
      expect(capturedPrintError.join("\n")).toContain("Docker daemon is not running");
    });

    it("does NOT trigger the docker-unreachable path on unrelated start output (negative control)", () => {
      // A genuinely-broken-but-not-Docker-unreachable failure must still reach
      // the regular failure path (which DOES collect diagnostics and clean
      // up). If this test ever flips, the call-site classifier has been made
      // too aggressive and would silence real gateway failures behind the
      // Docker-recovery message.
      capturedClassifyLog = [];
      capturedPrintError = [];

      const failure = reportLegacyGatewayStartResultFailure(
        "  k3s: failed to bootstrap helm chart after 90s\n",
        (m) => capturedClassifyLog.push(m),
      );

      expect(failure.kind).toBe("unknown");

      let collectCalls = 0;
      let cleanupCalls = 0;
      let exitCode: number | null = null;
      try {
        handleFinalGatewayStartFailure({
          retries: 2,
          dockerUnreachable: false,
          printError: (m = "") => capturedPrintError.push(m),
          collectDiagnostics: () => {
            collectCalls += 1;
            return "";
          },
          cleanupGateway: () => {
            cleanupCalls += 1;
          },
          exitProcess: ((code: number) => {
            exitCode = code;
            throw new Error(`__exit(${code})`);
          }) as (code: number) => never,
        });
      } catch {
        // expected
      }
      expect(collectCalls).toBeGreaterThan(0);
      expect(cleanupCalls).toBeGreaterThan(0);
      // The non-Docker-unreachable branch does NOT print the Docker daemon
      // recovery message.
      expect(capturedPrintError.join("\n")).not.toContain("Docker daemon is not running");
      // exitCode is left null here because the test's exitProcess throws
      // and the surrounding handleFinal swallows other branches' exits via
      // its caller — the assertion that matters is that diagnostics + cleanup
      // happened.
      void exitCode;
    });
  });

  // ── Layer 3: structural assertion on the call site ──────────────────────
  //
  // These tests defend against future refactors that accidentally:
  //   - skip the `failure.kind === "docker_unreachable"` check,
  //   - drop the `pRetry.AbortError` throw (causing retries),
  //   - or fail to forward `dockerUnreachable: true` to handleFinal.
  //
  // They are deliberately scoped narrowly — they assert only the wiring
  // pattern, not exact whitespace — and live next to the unit tests so the
  // intent is obvious to reviewers of future onboard.ts changes.

  describe("call-site wiring in startGatewayWithOptions (structural)", () => {
    let onboardSource: string;

    beforeEach(() => {
      onboardSource = fs.readFileSync(path.resolve(__dirname, "..", "onboard.ts"), "utf8");
    });

    afterEach(() => {
      // free string in long suites
      onboardSource = "";
    });

    it("classifies docker-unreachable inside startGatewayWithOptions", () => {
      // The call site reads the failure.kind enum; the literal "docker_unreachable"
      // must appear inside the function body.
      const startGatewayWithOptionsBody = extractFunctionBody(
        onboardSource,
        "async function startGatewayWithOptions",
      );
      expect(startGatewayWithOptionsBody).toMatch(/failure\.kind\s*===\s*"docker_unreachable"/);
    });

    it("throws pRetry.AbortError on the docker-unreachable branch (no retries)", () => {
      const startGatewayWithOptionsBody = extractFunctionBody(
        onboardSource,
        "async function startGatewayWithOptions",
      );
      // The docker_unreachable check and the AbortError throw must be
      // co-located. We assert both appear within a small window of each
      // other rather than anywhere in the function — guards against a
      // refactor that splits them across unrelated branches.
      const idx = startGatewayWithOptionsBody.indexOf('"docker_unreachable"');
      expect(idx).toBeGreaterThan(-1);
      const window = startGatewayWithOptionsBody.slice(idx, idx + 400);
      expect(window).toMatch(/throw new pRetry\.AbortError/);
    });

    it("forwards dockerUnreachable to handleFinalGatewayStartFailure", () => {
      const startGatewayWithOptionsBody = extractFunctionBody(
        onboardSource,
        "async function startGatewayWithOptions",
      );
      // Either as a shorthand property or as a key-value — accept both.
      expect(startGatewayWithOptionsBody).toMatch(
        /handleFinalGatewayStartFailure\(\{[^}]*\bdockerUnreachable\b/s,
      );
    });
  });

  // ── Sanity: classifyGatewayStartFailure recognises both signatures ─────
  // (Already covered in gateway-start-failure.test.ts; this is a pinning
  // assertion for the two strings the legacy script generated, kept here so
  // the retirement leaves no implicit reference to those byte sequences.)

  describe("classifyGatewayStartFailure pinning for legacy-script signatures", () => {
    it("classifies the macOS Colima signature as docker_unreachable", () => {
      expect(classifyGatewayStartFailure(DARWIN_DOCKER_UNREACHABLE_OUTPUT)).toEqual({
        kind: "docker_unreachable",
      });
    });

    it("classifies the Linux dockerd signature as docker_unreachable", () => {
      expect(classifyGatewayStartFailure(LINUX_DOCKER_UNREACHABLE_OUTPUT)).toEqual({
        kind: "docker_unreachable",
      });
    });
  });
});

/**
 * Extract a top-level function body by declaration prefix (e.g.
 * "async function startGatewayWithOptions") from the onboard.ts source.
 *
 * Walks past the signature by balancing parentheses (handles nested types
 * like `ReturnType<typeof nim.detectGpu>` and inline-destructured parameters
 * with their own braces) until reaching the closing `)` of the parameter
 * list at depth 0, then finds the function body's opening `{` and balances
 * braces to its matching close. Throws if the function is not found or the
 * body cannot be parsed; structural tests are useless if they silently match
 * an empty string.
 */
function extractFunctionBody(source: string, declarationPrefix: string): string {
  const start = source.indexOf(declarationPrefix);
  if (start === -1) {
    throw new Error(`Could not find '${declarationPrefix}' in onboard.ts`);
  }
  const sigOpen = source.indexOf("(", start);
  if (sigOpen === -1) {
    throw new Error(`No '(' after '${declarationPrefix}' in onboard.ts`);
  }
  // Balance parens through the signature, ignoring any braces that appear
  // inside parameter destructuring or generic types.
  let parenDepth = 0;
  let sigClose = -1;
  for (let i = sigOpen; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        sigClose = i;
        break;
      }
    }
  }
  if (sigClose === -1) {
    throw new Error(`Unbalanced '(' in signature of '${declarationPrefix}'`);
  }
  const bodyOpen = source.indexOf("{", sigClose);
  if (bodyOpen === -1) {
    throw new Error(`No body '{' after signature of '${declarationPrefix}'`);
  }
  let depth = 0;
  for (let i = bodyOpen; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyOpen + 1, i);
    }
  }
  throw new Error(`Unbalanced braces while extracting body of '${declarationPrefix}'`);
}
