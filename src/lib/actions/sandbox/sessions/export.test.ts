// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
}));

vi.mock("../download", () => ({
  downloadFromSandbox: vi.fn(async () => ({ sandboxPath: "", hostDest: "" })),
}));

vi.mock("../../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
  runOpenshell: vi.fn(),
}));

import { captureOpenshell, runOpenshell } from "../../../adapters/openshell/runtime";
import { downloadFromSandbox } from "../download";
import { buildSandboxTarArgv, exportSandboxSessions, parseSessionIndex } from "./export";

const captureMock = captureOpenshell as unknown as ReturnType<typeof vi.fn>;
const runMock = runOpenshell as unknown as ReturnType<typeof vi.fn>;
const downloadMock = downloadFromSandbox as unknown as ReturnType<typeof vi.fn>;

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captureMock.mockReset();
  runMock.mockReset();
  downloadMock.mockReset();
  downloadMock.mockResolvedValue({ sandboxPath: "", hostDest: "" });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

describe("buildSandboxTarArgv", () => {
  it("tars the whole agent sessions dir and excludes trajectory by default", () => {
    expect(
      buildSandboxTarArgv({
        sourceDir: "/sandbox/.openclaw/agents/main/sessions",
        tarballRemote: "/tmp/x.tgz",
        resolvedFiles: null,
        includeTrajectory: false,
      }),
    ).toEqual([
      "tar",
      "-czf",
      "/tmp/x.tgz",
      "-C",
      "/sandbox/.openclaw/agents/main/sessions",
      "--exclude=*.trajectory.jsonl",
      ".",
    ]);
  });

  it("keeps trajectory files when includeTrajectory=true and no key filter", () => {
    expect(
      buildSandboxTarArgv({
        sourceDir: "/sandbox/.openclaw/agents/main/sessions",
        tarballRemote: "/tmp/x.tgz",
        resolvedFiles: null,
        includeTrajectory: true,
      }),
    ).toEqual(["tar", "-czf", "/tmp/x.tgz", "-C", "/sandbox/.openclaw/agents/main/sessions", "."]);
  });

  it("passes resolved files verbatim when keys filter the bundle", () => {
    expect(
      buildSandboxTarArgv({
        sourceDir: "/sandbox/.openclaw/agents/main/sessions",
        tarballRemote: "/tmp/x.tgz",
        resolvedFiles: ["sid-1.jsonl", "sid-2.jsonl"],
        includeTrajectory: false,
      }),
    ).toEqual([
      "tar",
      "-czf",
      "/tmp/x.tgz",
      "-C",
      "/sandbox/.openclaw/agents/main/sessions",
      "sid-1.jsonl",
      "sid-2.jsonl",
    ]);
  });
});

describe("parseSessionIndex", () => {
  it("accepts a plain JSON array of entries", () => {
    const output = '[{"key":"agent:main:main","sessionId":"sid-1"}]';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("accepts an object wrapper with a sessions array", () => {
    const output = '{"sessions":[{"key":"agent:main:main","sessionId":"sid-1"}]}';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("treats id as an alias for sessionId", () => {
    const output = '[{"key":"agent:main:main","id":"sid-1"}]';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("tolerates log noise preceding a single-line JSON payload", () => {
    const output = 'warning: deprecation\n[{"key":"agent:main:main","sessionId":"sid-1"}]';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("returns empty when the output cannot be parsed", () => {
    expect(parseSessionIndex("hello world")).toEqual([]);
  });
});

describe("exportSandboxSessions", () => {
  function makeCapture(output: string, status = 0) {
    return { status, output, error: undefined as Error | undefined };
  }

  it("tars all sessions when no keys are supplied and downloads via the wrapper", async () => {
    const result = await exportSandboxSessions({
      sandboxName: "alpha",
      out: "./out.tgz",
    });

    expect(captureMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledTimes(2);
    const tarCall = runMock.mock.calls[0]?.[0] as string[];
    expect(tarCall.slice(0, 5)).toEqual(["sandbox", "exec", "--name", "alpha", "--"]);
    expect(tarCall).toContain("--exclude=*.trajectory.jsonl");
    expect(tarCall.at(-1)).toBe(".");

    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(downloadMock.mock.calls[0]?.[0]).toMatchObject({
      sandboxName: "alpha",
      hostDest: "./out.tgz",
    });
    expect(result.selectedKeys).toBe("all");
    expect(result.resolvedFiles).toBe("all");
    expect(result.agent).toBe("main");
  });

  it("resolves canonical keys to filenames via openclaw sessions list", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(
        JSON.stringify([
          { key: "agent:main:main", sessionId: "sid-1" },
          { key: "agent:main:telegram:t-1", sessionId: "sid-2" },
        ]),
      ),
    );

    const result = await exportSandboxSessions({
      sandboxName: "alpha",
      keys: ["agent:main:telegram:t-1"],
      out: "./out.tgz",
      includeTrajectory: true,
    });

    const tarCall = runMock.mock.calls[0]?.[0] as string[];
    expect(tarCall).toContain("sid-2.jsonl");
    expect(tarCall).toContain("sid-2.trajectory.jsonl");
    expect(tarCall).not.toContain("sid-1.jsonl");
    expect(result.selectedKeys).toEqual(["agent:main:telegram:t-1"]);
    expect(result.resolvedFiles).toEqual(["sid-2.jsonl", "sid-2.trajectory.jsonl"]);
  });

  it("treats alias keys under the --agent flag as canonical", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:work:telegram:t-1", sessionId: "sid-9" }])),
    );

    await exportSandboxSessions({
      sandboxName: "alpha",
      agent: "work",
      keys: ["telegram:t-1"],
      out: "./out.tgz",
    });

    const captureCall = captureMock.mock.calls[0]?.[0] as string[];
    expect(captureCall).toContain("--agent");
    expect(captureCall).toContain("work");
    const tarCall = runMock.mock.calls[0]?.[0] as string[];
    expect(tarCall).toContain("sid-9.jsonl");
  });

  it("refuses canonical keys whose agent disagrees with --agent", async () => {
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        agent: "work",
        keys: ["agent:main:main"],
      }),
    ).rejects.toThrow(/scoped to agent 'main', not 'work'/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("refuses to tar when a requested key cannot be found in the index", async () => {
    captureMock.mockReturnValueOnce(makeCapture(JSON.stringify([])));
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        keys: ["agent:main:main"],
      }),
    ).rejects.toThrow(/no entries found in agent 'main'/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("cleans up the staging tarball after the host download succeeds", async () => {
    await exportSandboxSessions({
      sandboxName: "alpha",
      out: "./out.tgz",
    });
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
    expect(cleanupCall?.[1]).toMatchObject({ ignoreError: true });
  });

  it("emits a JSON manifest when --json is set", async () => {
    await exportSandboxSessions({
      sandboxName: "alpha",
      out: "./out.tgz",
      json: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const printed = consoleLogSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(printed)).toMatchObject({
      sandboxName: "alpha",
      agent: "main",
      selectedKeys: "all",
      hostDest: "./out.tgz",
    });
  });
});
