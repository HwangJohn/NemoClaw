// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { stageCreateSandboxBuildContext } from "../../../dist/lib/onboard/build-context-stage";

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function throwingExit(code?: number): never {
  throw new Error(`exit ${code ?? 0}`);
}

describe("stageCreateSandboxBuildContext", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stages a custom Dockerfile context, filters ignored entries, and returns cleanup", () => {
    const buildContextDir = makeTmpDir("nemoclaw-custom-context-");
    const customDockerfile = path.join(buildContextDir, "Containerfile");
    fs.writeFileSync(customDockerfile, "FROM scratch\n");
    fs.writeFileSync(path.join(buildContextDir, "extra.txt"), "included\n");
    fs.mkdirSync(path.join(buildContextDir, ".ssh"));
    fs.writeFileSync(path.join(buildContextDir, ".ssh", "id_rsa"), "secret\n");
    const logs: string[] = [];

    const result = stageCreateSandboxBuildContext({
      root: "/unused",
      fromDockerfile: customDockerfile,
      agent: null,
      createAgentSandbox: vi.fn(),
      log: (message) => logs.push(message),
      exit: throwingExit,
    });
    tmpDirs.push(result.buildCtx);

    expect(logs).toEqual([
      `  Using custom Dockerfile: ${customDockerfile}`,
      `  Docker build context: ${buildContextDir}`,
    ]);
    expect(fs.readFileSync(result.stagedDockerfile, "utf-8")).toBe("FROM scratch\n");
    expect(fs.existsSync(path.join(result.buildCtx, "extra.txt"))).toBe(true);
    expect(fs.existsSync(path.join(result.buildCtx, ".ssh"))).toBe(false);
    expect(result.cleanupBuildCtx()).toBe(true);
    expect(fs.existsSync(result.buildCtx)).toBe(false);
  });

  it("exits when the custom Dockerfile path is missing", () => {
    const errors: string[] = [];
    const missingDockerfile = path.join(makeTmpDir("nemoclaw-missing-context-"), "Dockerfile");

    expect(() =>
      stageCreateSandboxBuildContext({
        root: "/unused",
        fromDockerfile: missingDockerfile,
        agent: null,
        createAgentSandbox: vi.fn(),
        error: (message) => errors.push(message),
        exit: throwingExit,
      }),
    ).toThrow("exit 1");

    expect(errors).toEqual([`  Custom Dockerfile not found: ${missingDockerfile}`]);
  });

  it("delegates to agent or default build-context staging when no custom Dockerfile is supplied", () => {
    const agentBuild = {
      buildCtx: makeTmpDir("nemoclaw-agent-build-"),
      stagedDockerfile: path.join(os.tmpdir(), "agent.Dockerfile"),
    };
    const defaultBuild = {
      buildCtx: makeTmpDir("nemoclaw-default-build-"),
      stagedDockerfile: path.join(os.tmpdir(), "default.Dockerfile"),
    };
    const createAgentSandbox = vi.fn(() => agentBuild);
    const stageDefaultSandboxBuildContext = vi.fn(() => defaultBuild);

    const agentResult = stageCreateSandboxBuildContext({
      root: "/repo",
      fromDockerfile: null,
      agent: { name: "hermes" } as any,
      createAgentSandbox,
      stageDefaultSandboxBuildContext,
    });

    expect(agentResult.buildCtx).toBe(agentBuild.buildCtx);
    expect(createAgentSandbox).toHaveBeenCalledWith({ name: "hermes" });
    expect(stageDefaultSandboxBuildContext).not.toHaveBeenCalled();

    const defaultResult = stageCreateSandboxBuildContext({
      root: "/repo",
      fromDockerfile: null,
      agent: null,
      createAgentSandbox,
      stageDefaultSandboxBuildContext,
    });

    expect(defaultResult.buildCtx).toBe(defaultBuild.buildCtx);
    expect(stageDefaultSandboxBuildContext).toHaveBeenCalledWith("/repo");
  });
});
