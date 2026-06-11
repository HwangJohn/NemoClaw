// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import { CLI_NAME } from "../../../cli/branding";
import { captureOpenshell, runOpenshell } from "../../../adapters/openshell/runtime";
import { downloadFromSandbox } from "../download";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import {
  DEFAULT_AGENT_ID,
  parseAgentIdFromSessionKey,
  validateAgentId,
  validateSessionKey,
} from "./paths";

export interface SessionsExportOptions {
  sandboxName: string;
  agent?: string;
  keys?: readonly string[];
  out?: string;
  includeTrajectory?: boolean;
  json?: boolean;
}

export interface SessionsExportResult {
  sandboxName: string;
  agent: string;
  selectedKeys: string[] | "all";
  resolvedFiles: string[] | "all";
  tarballRemote: string;
  hostDest: string;
}

interface SessionIndexEntry {
  key: string;
  sessionId: string;
}

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]+$/;

export async function exportSandboxSessions(
  opts: SessionsExportOptions,
): Promise<SessionsExportResult> {
  const agent = resolveAgentId(opts);
  const trimmedKeys = (opts.keys ?? []).map((value) => validateSessionKey(value));
  enforceAgentScope(agent, trimmedKeys);

  await ensureLiveSandboxOrExit(opts.sandboxName, { allowNonReadyPhase: true });

  const sourceDir = `/sandbox/.openclaw/agents/${agent}/sessions`;
  const tarballRemote = stagingTarballPath(agent);

  const resolvedFiles =
    trimmedKeys.length > 0
      ? resolveSelectedFiles(opts.sandboxName, agent, trimmedKeys, opts.includeTrajectory ?? false)
      : null;

  const tarArgv = buildSandboxTarArgv({
    sourceDir,
    tarballRemote,
    resolvedFiles,
    includeTrajectory: opts.includeTrajectory ?? false,
  });

  runOpenshell(["sandbox", "exec", "--name", opts.sandboxName, "--", ...tarArgv]);

  const hostDest = resolveHostDestination(opts.out, opts.sandboxName, agent);
  await downloadFromSandbox({
    sandboxName: opts.sandboxName,
    sandboxPath: tarballRemote,
    hostDest,
    allowNonReadyPhase: true,
  });

  runOpenshell(["sandbox", "exec", "--name", opts.sandboxName, "--", "rm", "-f", tarballRemote], {
    ignoreError: true,
    stdio: "ignore",
  });

  const result: SessionsExportResult = {
    sandboxName: opts.sandboxName,
    agent,
    selectedKeys: trimmedKeys.length > 0 ? trimmedKeys : "all",
    resolvedFiles: resolvedFiles ?? "all",
    tarballRemote,
    hostDest,
  };

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    const scope =
      trimmedKeys.length > 0
        ? `${trimmedKeys.length} key(s) on agent '${agent}'`
        : `all sessions for agent '${agent}'`;
    console.error(`  Exported ${scope} to ${hostDest}`);
  }

  return result;
}

export function buildSandboxTarArgv(input: {
  sourceDir: string;
  tarballRemote: string;
  resolvedFiles: string[] | null;
  includeTrajectory: boolean;
}): string[] {
  const argv: string[] = ["tar", "-czf", input.tarballRemote, "-C", input.sourceDir];
  if (input.resolvedFiles && input.resolvedFiles.length > 0) {
    for (const file of input.resolvedFiles) argv.push(file);
    return argv;
  }
  if (!input.includeTrajectory) argv.push("--exclude=*.trajectory.jsonl");
  argv.push(".");
  return argv;
}

function resolveAgentId(opts: SessionsExportOptions): string {
  if (opts.agent) return validateAgentId(opts.agent);
  for (const key of opts.keys ?? []) {
    const trimmed = key.trim();
    const parsed = parseAgentIdFromSessionKey(trimmed);
    if (parsed) return validateAgentId(parsed);
  }
  return DEFAULT_AGENT_ID;
}

function enforceAgentScope(agent: string, keys: readonly string[]): void {
  for (const key of keys) {
    const parsed = parseAgentIdFromSessionKey(key);
    if (parsed && parsed !== agent) {
      throw new Error(
        `Refusing to export: session key '${key}' is scoped to agent '${parsed}', not '${agent}'.`,
      );
    }
  }
}

function resolveSelectedFiles(
  sandboxName: string,
  agent: string,
  keys: readonly string[],
  includeTrajectory: boolean,
): string[] {
  const index = readSessionIndex(sandboxName, agent);
  const byKey = new Map<string, string>();
  for (const entry of index) byKey.set(entry.key, entry.sessionId);

  const missing: string[] = [];
  const files: string[] = [];
  for (const key of keys) {
    const sessionId = byKey.get(key) ?? byKey.get(normaliseToCanonical(agent, key)) ?? null;
    if (!sessionId) {
      missing.push(key);
      continue;
    }
    if (!SAFE_TOKEN_RE.test(sessionId)) {
      throw new Error(
        `Refusing to tar: session id '${sessionId}' resolved for key '${key}' contains unsafe characters.`,
      );
    }
    files.push(`${sessionId}.jsonl`);
    if (includeTrajectory) files.push(`${sessionId}.trajectory.jsonl`);
  }
  if (missing.length > 0) {
    throw new Error(
      `Refusing to export: no entries found in agent '${agent}' for key(s): ${missing.join(", ")}.`,
    );
  }
  return files;
}

function normaliseToCanonical(agent: string, key: string): string {
  if (key.startsWith("agent:")) return key;
  return `agent:${agent}:${key}`;
}

function readSessionIndex(sandboxName: string, agent: string): SessionIndexEntry[] {
  const result = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      sandboxName,
      "--",
      "openclaw",
      "sessions",
      "list",
      "--agent",
      agent,
      "--json",
    ],
    { ignoreError: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to list sessions in sandbox '${sandboxName}' for agent '${agent}' (exit ${result.status}). Verify the sandbox is live with \`${CLI_NAME} ${sandboxName} status\`.`,
    );
  }
  return parseSessionIndex(result.output);
}

export function parseSessionIndex(output: string): SessionIndexEntry[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const lines = trimmed.split(/\r?\n/);
  const candidates: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index]?.trim();
    if (candidate && (candidate.startsWith("[") || candidate.startsWith("{"))) {
      candidates.push(candidate);
    }
  }
  candidates.push(trimmed);
  for (const candidate of candidates) {
    const entries = tryExtractIndex(candidate);
    if (entries) return entries;
  }
  return [];
}

function tryExtractIndex(text: string): SessionIndexEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const array = pickIndexArray(parsed);
  if (!array) return null;
  const entries: SessionIndexEntry[] = [];
  for (const entry of array) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key : null;
    const sessionId =
      typeof obj.sessionId === "string"
        ? obj.sessionId
        : typeof obj.id === "string"
          ? obj.id
          : null;
    if (key && sessionId) entries.push({ key, sessionId });
  }
  return entries;
}

function pickIndexArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.sessions)) return obj.sessions;
    if (Array.isArray(obj.entries)) return obj.entries;
    if (Array.isArray(obj.items)) return obj.items;
  }
  return null;
}

function stagingTarballPath(agent: string): string {
  const suffix = randomBytes(6).toString("hex");
  return `/tmp/sessions-export-${agent}-${suffix}.tgz`;
}

function resolveHostDestination(
  out: string | undefined,
  sandboxName: string,
  agent: string,
): string {
  if (out && out.trim()) return out.trim();
  return `./sessions-${sandboxName}-${agent}.tgz`;
}
