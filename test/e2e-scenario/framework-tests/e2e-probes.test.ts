// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listRegisteredProbes,
  lookupProbe,
  registerProbe,
  resetProbeRegistry,
} from "../scenarios/probes/registry.ts";
import type { ProbeContext, ProbeOutcome } from "../scenarios/probes/types.ts";
import { registerBuiltinProbes } from "../scenarios/probes/builtin.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("probe registry", () => {
  // The orchestrator side-effect-imports builtin.ts at module load,
  // so the registry already contains the built-ins. Each test resets
  // and re-registers explicitly so order independence holds.
  beforeEach(() => {
    resetProbeRegistry();
  });

  afterEach(() => {
    // Restore the production wiring so subsequent test files don't
    // see an empty registry (vitest shares module state across files
    // within a worker).
    resetProbeRegistry();
    registerBuiltinProbes();
  });

  it("registerProbe_lookupProbe_round_trip", () => {
    const fn = async (): Promise<ProbeOutcome> => ({ status: "passed" });
    registerProbe("myProbe", fn);
    expect(lookupProbe("myProbe")).toBe(fn);
  });

  it("lookupProbe_returns_undefined_for_unknown_ref", () => {
    expect(lookupProbe("nonexistent")).toBeUndefined();
  });

  it("registerProbe_rejects_duplicate_registration", () => {
    const fn = async (): Promise<ProbeOutcome> => ({ status: "passed" });
    registerProbe("dup", fn);
    expect(() => registerProbe("dup", fn)).toThrow(/already registered/);
  });

  it("registerProbe_rejects_empty_name", () => {
    const fn = async (): Promise<ProbeOutcome> => ({ status: "passed" });
    expect(() => registerProbe("", fn)).toThrow(/name is required/);
  });

  it("listRegisteredProbes_returns_sorted_names", () => {
    registerProbe("zeta", async () => ({ status: "passed" }));
    registerProbe("alpha", async () => ({ status: "passed" }));
    registerProbe("mu", async () => ({ status: "passed" }));
    expect(listRegisteredProbes()).toEqual(["alpha", "mu", "zeta"]);
  });

  it("registerBuiltinProbes_is_idempotent", () => {
    registerBuiltinProbes();
    const first = listRegisteredProbes();
    expect(first).toContain("diagnosticsProbe");
    expect(first).toContain("docsValidationProbe");
    // Calling again must not throw on duplicate names.
    expect(() => registerBuiltinProbes()).not.toThrow();
    expect(listRegisteredProbes()).toEqual(first);
  });

  it("registerBuiltinProbes_does_NOT_register_security_probes_yet", () => {
    // The shieldsConfig / networkPolicy / injectionBlocked probes
    // are intentionally not registered yet \u2014 their `required: true`
    // status in scenarios/assertions/registry.ts means the
    // orchestrator fails closed when they're missing, which is the
    // contract we want until real implementations land.
    registerBuiltinProbes();
    const registered = listRegisteredProbes();
    expect(registered).not.toContain("shieldsConfigProbe");
    expect(registered).not.toContain("networkPolicyProbe");
    expect(registered).not.toContain("injectionBlockedProbe");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diagnosticsProbe — uses a fake `nemoclaw` on PATH so this test runs
// reproducibly without depending on a real nemoclaw install.
// ─────────────────────────────────────────────────────────────────────────────

function makeProbeCtx(tmp: string, evidenceFile = "diag-evidence.json"): ProbeContext {
  // contextDir doubles as the parent of the evidence file when the
  // step does not specify an explicit path. Tests pass an explicit
  // path here to keep the file under tmp.
  return {
    contextDir: tmp,
    evidencePath: path.join(tmp, evidenceFile),
    contextEnv: {},
    sandboxName: null,
    gatewayUrl: null,
    repoRoot: REPO_ROOT,
  };
}

function installFakeOnPath(
  binDir: string,
  name: string,
  script: string,
): { restore: () => void } {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, name), script, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath ?? ""}`;
  return {
    restore: () => {
      process.env.PATH = oldPath;
    },
  };
}

describe("diagnosticsProbe", () => {
  it("passes_when_nemoclaw_debug_quick_writes_a_non_empty_archive", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-probe-pass-"));
    const fake = installFakeOnPath(
      path.join(tmp, "bin"),
      "nemoclaw",
      `#!/usr/bin/env bash
# Stub: locate the --output value and write a small non-empty archive there.
out=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$out" ]] || { echo "no --output" >&2; exit 2; }
printf 'fake-archive-bytes' > "$out"
exit 0
`,
    );
    try {
      const { diagnosticsProbe } = await import("../scenarios/probes/diagnostics.ts");
      const outcome = await diagnosticsProbe(makeProbeCtx(tmp));
      expect(outcome.status).toBe("passed");
      expect(outcome.message).toMatch(/bundle ok/);
      // Evidence JSON must exist and parse.
      const ev = JSON.parse(fs.readFileSync(path.join(tmp, "diag-evidence.json"), "utf8"));
      expect(ev.exitCode).toBe(0);
      expect(ev.archiveSize).toBeGreaterThan(0);
    } finally {
      fake.restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_nemoclaw_exits_nonzero", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-probe-fail-"));
    const fake = installFakeOnPath(
      path.join(tmp, "bin"),
      "nemoclaw",
      `#!/usr/bin/env bash\necho "boom" >&2\nexit 7\n`,
    );
    try {
      const { diagnosticsProbe } = await import("../scenarios/probes/diagnostics.ts");
      const outcome = await diagnosticsProbe(makeProbeCtx(tmp));
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/exited 7/);
      const ev = JSON.parse(fs.readFileSync(path.join(tmp, "diag-evidence.json"), "utf8"));
      expect(ev.exitCode).toBe(7);
      expect(ev.stderrTail).toContain("boom");
    } finally {
      fake.restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_archive_is_empty", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-probe-empty-"));
    const fake = installFakeOnPath(
      path.join(tmp, "bin"),
      "nemoclaw",
      `#!/usr/bin/env bash
out=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in --output) out="$2"; shift 2 ;; *) shift ;; esac
done
: > "$out"  # zero-byte archive
exit 0
`,
    );
    try {
      const { diagnosticsProbe } = await import("../scenarios/probes/diagnostics.ts");
      const outcome = await diagnosticsProbe(makeProbeCtx(tmp));
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/empty/);
    } finally {
      fake.restore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// docsValidationProbe — substitutes a fake check-docs.sh by overriding
// the repoRoot in the ProbeContext so the resolved path points at a
// scratch dir we control.
// ─────────────────────────────────────────────────────────────────────────────

describe("docsValidationProbe", () => {
  function setupFakeCheckDocs(
    tmp: string,
    cliExit: number,
    linksExit: number,
  ): { ctx: ProbeContext } {
    const scriptDir = path.join(tmp, "test/e2e/e2e-cloud-experimental");
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptDir, "check-docs.sh"),
      `#!/usr/bin/env bash
case "$1" in
  --only-cli)            exit ${cliExit} ;;
  --only-links)          exit ${linksExit} ;;
  *)                     echo "unknown: $*" >&2; exit 99 ;;
esac
`,
      { mode: 0o755 },
    );
    return {
      ctx: {
        contextDir: tmp,
        evidencePath: path.join(tmp, "docs-evidence.json"),
        contextEnv: {},
        sandboxName: null,
        gatewayUrl: null,
        repoRoot: tmp, // probe resolves check-docs.sh against this
      },
    };
  }

  it("passes_when_both_cli_and_links_checks_exit_zero", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-probe-pass-"));
    try {
      const { ctx } = setupFakeCheckDocs(tmp, 0, 0);
      const { docsValidationProbe } = await import("../scenarios/probes/docs-validation.ts");
      const outcome = await docsValidationProbe(ctx);
      expect(outcome.status).toBe("passed");
      const ev = JSON.parse(fs.readFileSync(ctx.evidencePath, "utf8"));
      expect(ev.results).toHaveLength(2);
      expect(ev.results[0].phase).toBe("cli-parity");
      expect(ev.results[0].exitCode).toBe(0);
      expect(ev.results[1].phase).toBe("links-local");
      expect(ev.results[1].exitCode).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_cli_parity_check_exits_nonzero", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-probe-cli-fail-"));
    try {
      const { ctx } = setupFakeCheckDocs(tmp, 3, 0);
      const { docsValidationProbe } = await import("../scenarios/probes/docs-validation.ts");
      const outcome = await docsValidationProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/CLI\/docs parity failed.*exit 3/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_when_links_check_exits_nonzero", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-probe-links-fail-"));
    try {
      const { ctx } = setupFakeCheckDocs(tmp, 0, 5);
      const { docsValidationProbe } = await import("../scenarios/probes/docs-validation.ts");
      const outcome = await docsValidationProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/markdown link check failed.*exit 5/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails_with_actionable_message_when_check_docs_script_missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "docs-probe-missing-"));
    try {
      const { docsValidationProbe } = await import("../scenarios/probes/docs-validation.ts");
      const ctx: ProbeContext = {
        contextDir: tmp,
        evidencePath: path.join(tmp, "docs-evidence.json"),
        contextEnv: {},
        sandboxName: null,
        gatewayUrl: null,
        repoRoot: tmp, // no test/e2e/... tree under tmp
      };
      const outcome = await docsValidationProbe(ctx);
      expect(outcome.status).toBe("failed");
      expect(outcome.message).toMatch(/check-docs\.sh not found/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
