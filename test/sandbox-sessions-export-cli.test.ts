// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithEnv, writeSandboxRegistry } from "./cli/helpers";

function buildStubOpenshell(home: string, logFile: string, sessionListJson: string): string {
  const localBin = path.join(home, "bin");
  fs.mkdirSync(localBin, { recursive: true });
  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
      'case "$*" in',
      '  "sandbox list"*) printf "alpha Ready\\n"; exit 0 ;;',
      '  "sandbox get alpha"*) printf "Name: alpha\\nPhase: Ready\\nPolicy:\\n"; exit 0 ;;',
      '  "gateway info -g nemoclaw"*) printf "Gateway: nemoclaw\\n"; exit 0 ;;',
      '  *"openclaw sessions list"*)',
      `    printf '%s\\n' ${JSON.stringify(sessionListJson)}`,
      "    exit 0 ;;",
      '  *"sandbox exec --name alpha -- sh -c"*) exit 0 ;;',
      '  "sandbox download"*) exit 0 ;;',
      '  *"sandbox exec --name alpha -- rm"*) exit 0 ;;',
      "  *) exit 0 ;;",
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  return localBin;
}

describe("sandbox sessions export CLI", () => {
  it("tars the whole agent sessions dir, downloads, and cleans up when no keys are supplied", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sessions-export-all-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog, "[]");

      const out = path.join(home, "bundle.tgz");
      const result = runWithEnv(`alpha sessions export --out ${out} --json 2>&1`, {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8").split("\n");
      const tarLine = calls.find((line) => line.includes("-- sh -c") && line.includes("umask 077"));
      const downloadLine = calls.find((line) => line.startsWith("sandbox download"));
      const cleanupLine = calls.find((line) => line.includes("-- rm -f"));
      expect(tarLine).toBeDefined();
      expect(tarLine).toContain("/sandbox/.openclaw/agents/main/sessions");
      expect(tarLine).toContain("--exclude=*.trajectory.jsonl");
      expect(tarLine).toContain("chmod 600");
      expect(downloadLine).toContain("alpha");
      expect(downloadLine).toContain(out);
      expect(cleanupLine).toBeDefined();
      expect(cleanupLine).toContain("/tmp/sessions-export-main-");

      const manifest = JSON.parse(result.out.trim().split("\n").at(-1) as string);
      expect(manifest).toMatchObject({
        sandboxName: "alpha",
        agent: "main",
        selectedKeys: "all",
        resolvedFiles: "all",
        hostDest: out,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves canonical keys to session-id files via openclaw sessions list and tars only those files", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sessions-export-keys-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(
        home,
        openshellLog,
        JSON.stringify([
          { key: "agent:main:main", sessionId: "sid-a" },
          { key: "agent:main:telegram:t-1", sessionId: "sid-b" },
        ]),
      );

      const out = path.join(home, "bundle.tgz");
      const result = runWithEnv(
        `alpha sessions export agent:main:telegram:t-1 --out ${out} --include-trajectory --json 2>&1`,
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
      );
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8").split("\n");
      const tarLine = calls.find((line) => line.includes("-- sh -c") && line.includes("umask 077"));
      expect(tarLine).toBeDefined();
      expect(tarLine).toContain("./sid-b.jsonl");
      expect(tarLine).toContain("./sid-b.trajectory.jsonl");
      expect(tarLine).not.toContain("sid-a.jsonl");
      expect(tarLine).not.toContain("--exclude=*.trajectory.jsonl");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats an alias key under --agent as canonical when invoking openclaw sessions list", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sessions-export-agent-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(
        home,
        openshellLog,
        JSON.stringify([{ key: "agent:work:telegram:t-1", sessionId: "sid-x" }]),
      );

      const out = path.join(home, "bundle.tgz");
      const result = runWithEnv(
        `alpha sessions export telegram:t-1 --agent work --out ${out} --json 2>&1`,
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
      );
      expect(result.code).toBe(0);

      const calls = fs.readFileSync(openshellLog, "utf8");
      expect(calls).toMatch(/openclaw sessions list --agent work --json/);
      expect(calls).toMatch(/\.\/sid-x\.jsonl/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to export when a canonical key disagrees with the --agent flag (no exec is issued)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sessions-export-mismatch-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog, "[]");

      const result = runWithEnv("alpha sessions export agent:main:main --agent work 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(result.code).toBe(1);
      expect(result.out).toMatch(/scoped to agent 'main', not 'work'/);

      const calls = fs.existsSync(openshellLog) ? fs.readFileSync(openshellLog, "utf8") : "";
      expect(calls).not.toMatch(/-- sh -c/);
      expect(calls).not.toMatch(/sandbox download/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects positional keys that start with '-' instead of silently exporting all sessions", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-sessions-export-stray-"));
    try {
      writeSandboxRegistry(home);
      const openshellLog = path.join(home, "openshell-calls.log");
      const localBin = buildStubOpenshell(home, openshellLog, "[]");

      const result = runWithEnv("alpha sessions export -foo --json 2>&1", {
        HOME: home,
        PATH: `${localBin}:${process.env.PATH || ""}`,
      });
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/Unknown flag or option-shaped key|Nonexistent flag/i);

      const calls = fs.existsSync(openshellLog) ? fs.readFileSync(openshellLog, "utf8") : "";
      expect(calls).not.toMatch(/-- sh -c/);
      expect(calls).not.toMatch(/sandbox download/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
