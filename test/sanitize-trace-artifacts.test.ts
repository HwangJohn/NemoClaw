// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

type Sanitizer = {
  REDACTED: string;
  sanitizeTraceArtifacts: (
    sourceDirectory: string,
    outputDirectory: string,
  ) => { files: number; outputDirectory: string };
};

const require = createRequire(import.meta.url);
const { REDACTED, sanitizeTraceArtifacts } =
  require("../scripts/ci/sanitize-trace-artifacts.js") as Sanitizer;

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-sanitize-trace-"));
  tempRoots.push(root);
  return root;
}

describe("sanitizeTraceArtifacts", () => {
  it("redacts sensitive trace values while preserving timing metadata", () => {
    const root = makeTempRoot();
    const source = join(root, "raw");
    const output = join(root, "sanitized");
    const fixturePath = join(source, "nemoclaw-trace-sensitive.json");
    const fixture = new URL("./fixtures/sensitive-trace-artifact.json", import.meta.url);

    mkdirSync(source, { recursive: true });
    copyFileSync(fixture, fixturePath);

    const result = sanitizeTraceArtifacts(source, output);
    const sanitized = JSON.parse(
      readFileSync(join(output, "nemoclaw-trace-sensitive.json"), "utf8"),
    );
    const rendered = JSON.stringify(sanitized);

    expect(result.files).toBe(1);
    expect(rendered).not.toContain("fake-nvidia-api-key-for-redaction-test");
    expect(rendered).not.toContain("fake-slack-webhook-url-for-redaction-test");
    expect(rendered).not.toContain("fake-bearer-token-1234567890");
    expect(rendered).toContain(REDACTED);
    expect(sanitized.summary.total_duration_ms).toBe(95000);
    expect(sanitized.summary.slowest_spans[0].duration_ms).toBe(12000);
    expect(sanitized.resource_spans[0].scope_spans[0].spans[1].name).toBe(
      "nemoclaw.onboard.phase.preflight",
    );
    expect(sanitized.resource_spans[0].scope_spans[0].spans[1].attributes.note).toBe(
      "timing metadata should survive",
    );
  });
});
