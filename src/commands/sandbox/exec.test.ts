// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const execSandboxMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../lib/actions/sandbox/exec", () => ({
  execSandbox: execSandboxMock,
}));

import SandboxExecCommand, { shouldInheritSandboxExecStdin } from "./exec";

const rootDir = process.cwd();

describe("SandboxExecCommand oclif parse path", () => {
  beforeEach(() => {
    execSandboxMock.mockReset();
  });

  it("forwards everything after -- as the inner command argv", async () => {
    await SandboxExecCommand.run(
      ["alpha", "--", "openclaw", "agent", "--agent", "main", "-m", "hi"],
      rootDir,
    );
    expect(execSandboxMock).toHaveBeenCalledWith(
      "alpha",
      ["openclaw", "agent", "--agent", "main", "-m", "hi"],
      { workdir: undefined, tty: null, timeoutSeconds: undefined, stdin: true },
    );
  });

  it("parses --workdir before -- and keeps the inner command intact", async () => {
    await SandboxExecCommand.run(
      ["alpha", "--workdir", "/sandbox/workspace", "--", "ls", "-la"],
      rootDir,
    );
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["ls", "-la"], {
      workdir: "/sandbox/workspace",
      tty: null,
      timeoutSeconds: undefined,
      stdin: true,
    });
  });

  it("parses --tty / --no-tty and --timeout into typed options", async () => {
    await SandboxExecCommand.run(["alpha", "--tty", "--timeout", "30", "--", "hostname"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["hostname"], {
      workdir: undefined,
      tty: true,
      timeoutSeconds: 30,
      stdin: true,
    });
    execSandboxMock.mockReset();

    await SandboxExecCommand.run(["alpha", "--no-tty", "--", "hostname"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["hostname"], {
      workdir: undefined,
      tty: false,
      timeoutSeconds: undefined,
      stdin: true,
    });
  });

  it("parses --stdin as explicit stdin forwarding", async () => {
    await SandboxExecCommand.run(["alpha", "--stdin", "--", "cat"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["cat"], {
      workdir: undefined,
      tty: null,
      timeoutSeconds: undefined,
      stdin: true,
    });
  });

  it("parses --no-stdin as explicit stdin closure", async () => {
    await SandboxExecCommand.run(["alpha", "--no-stdin", "--", "pwd"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["pwd"], {
      workdir: undefined,
      tty: null,
      timeoutSeconds: undefined,
      stdin: false,
    });
  });

  it("keeps stdin inherited by default when caller stdin is a TTY", async () => {
    await SandboxExecCommand.run(["alpha", "--", "bash"], rootDir);
    expect(execSandboxMock).toHaveBeenCalledWith("alpha", ["bash"], {
      workdir: undefined,
      tty: null,
      timeoutSeconds: undefined,
      stdin: true,
    });
  });
});

describe("shouldInheritSandboxExecStdin", () => {
  it("uses explicit stdin flags when provided", () => {
    expect(shouldInheritSandboxExecStdin(true)).toBe(true);
    expect(shouldInheritSandboxExecStdin(false)).toBe(false);
  });

  it("inherits stdin by default to preserve existing command behavior", () => {
    expect(shouldInheritSandboxExecStdin(undefined)).toBe(true);
  });
});
