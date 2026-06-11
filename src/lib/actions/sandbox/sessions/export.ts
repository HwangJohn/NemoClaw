// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Scope boundary for `nemoclaw <name> sessions export`:
//
//   - Invalid state addressed: extracting OpenClaw's per-agent session JSONL
//     out of a running sandbox to the host today requires a two-hop
//     `docker exec kubectl cp` + `docker cp` workaround that bakes in-sandbox
//     paths and TLS quirks into every consumer (see issue #3979). This module
//     wraps that flow.
//   - Source boundary:
//       * NemoClaw side (this file): validate the requested agent/keys,
//         resolve canonical keys to session ids via the in-sandbox
//         `openclaw sessions list --json`, build the in-sandbox tar command,
//         download the resulting tarball via `openshell sandbox download`,
//         and best-effort clean up the staging artifact afterwards.
//       * OpenClaw side (upstream `openclaw` npm package): owns the on-disk
//         session store under `/sandbox/.openclaw/agents/<id>/sessions/` and
//         the `sessions.list` index contract. NemoClaw never edits that
//         store and only reads it through the upstream CLI; renaming a key,
//         changing the per-session filename layout, or normalising the
//         `sessions list --json` shape are upstream concerns.
//   - Source-fix constraint: NemoClaw cannot bypass the two-hop transport
//     without reaching into the cluster container's file system, which
//     would violate the sandbox isolation. The wrapper therefore stays a
//     pure orchestrator over `openshell sandbox exec/download` and
//     `openclaw sessions list`.
//   - Regression-test coverage:
//       * Host-side: `src/lib/actions/sandbox/sessions/export.test.ts`
//         covers tar argv construction, index parser shape tolerance, key
//         canonicalisation, agent-scope refusal, leading-dash session id
//         rejection, download-failure cleanup, and JSON manifest shape.
//       * E2E (stub openshell): `test/sandbox-sessions-export-cli.test.ts`
//         exercises the full CLI through dispatch with a fake openshell
//         binary, proving the `exec tar`, `download`, and `exec rm` wire
//         calls happen in the expected order.
//   - Removal condition: the source-boundary comment can be removed when
//     OpenClaw exposes a stable `sessions.export` RPC that returns a
//     ready-to-download bundle path, removing NemoClaw's need to compose
//     the tar command and re-resolve key -> session-id host-side.

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

// Session ids must start with an alphanumeric character so they can never be
// interpreted as a tar option (`--checkpoint-action=...`, etc.) when appended
// to the argv. Hyphens and underscores remain permitted as inner characters.
const SAFE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

  const hostDest = resolveHostDestination(opts.out, opts.sandboxName, agent);

  try {
    runOpenshell([
      "sandbox",
      "exec",
      "--name",
      opts.sandboxName,
      "--",
      "sh",
      "-c",
      buildShellInvocation(tarArgv, tarballRemote),
    ]);

    await downloadFromSandbox({
      sandboxName: opts.sandboxName,
      sandboxPath: tarballRemote,
      hostDest,
      allowNonReadyPhase: true,
    });
  } finally {
    // Best-effort cleanup of the in-sandbox staging tarball. Runs even when
    // tar/download fail so a partial export cannot leave a world-readable
    // bundle of session JSONL in the sandbox's /tmp.
    runOpenshell(["sandbox", "exec", "--name", opts.sandboxName, "--", "rm", "-f", tarballRemote], {
      ignoreError: true,
      stdio: "ignore",
    });
  }

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
  // `--` separates tar options from operands so any future file name that
  // happens to start with `-` (even though SAFE_TOKEN_RE forbids that today)
  // cannot be reinterpreted as a tar option.
  const argv: string[] = ["tar", "-czf", input.tarballRemote, "-C", input.sourceDir];
  if (input.resolvedFiles && input.resolvedFiles.length > 0) {
    argv.push("--");
    for (const file of input.resolvedFiles) argv.push(`./${file}`);
    return argv;
  }
  if (!input.includeTrajectory) argv.push("--exclude=*.trajectory.jsonl");
  argv.push("--", "./");
  return argv;
}

function buildShellInvocation(tarArgv: readonly string[], tarballRemote: string): string {
  // umask 077 restricts the staging tarball (mode 600) so a concurrent
  // sandbox user cannot read another agent's session JSONL out of /tmp
  // between the tar step and the download step.
  const quoted = tarArgv.map(shellQuote).join(" ");
  const quotedTarball = shellQuote(tarballRemote);
  return `umask 077 && ${quoted} && chmod 600 ${quotedTarball}`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._\/=:@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
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
        `Refusing to tar: session id '${sessionId}' resolved for key '${key}' contains unsafe characters or starts with '-'.`,
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

// Tolerant parsing of `openclaw sessions list --json`.
//
//   - Invalid state addressed: the upstream OpenClaw CLI has historically
//     emitted the session index either as a plain JSON array, wrapped in
//     `{sessions:[...]}` / `{entries:[...]}` / `{items:[...]}`, with
//     `sessionId` or `id` as the file-name field, and prefixed with Node
//     experimental-feature warnings. Each shape variant is enough to break a
//     strict parser and abort the export.
//   - Source boundary: NemoClaw must accept the upstream-of-the-day shape
//     read-only. The upstream-pinned contract is captured in
//     `agents/openclaw/manifest.yaml -> expected_version`; this code does not
//     hard-code the literal so the manifest stays the single source of
//     truth.
//   - Source-fix constraint: tightening the parser to one shape would
//     regress against any in-the-wild OpenClaw build that still emits a
//     legacy shape, and NemoClaw cannot rev the upstream CLI from this side.
//   - Regression-test coverage: `export.test.ts > parseSessionIndex` covers
//     each accepted shape plus the log-noise prefix; CLI-level coverage in
//     `test/sandbox-sessions-export-cli.test.ts` exercises the array and
//     wrapped-object forms via the stub openshell.
//   - Removal condition: once OpenClaw documents a single stable JSON
//     contract for `sessions list --json` in its release notes, this
//     parser can collapse to the strict shape and the alias map can drop.
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
