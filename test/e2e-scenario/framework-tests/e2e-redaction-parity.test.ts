// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity test: the framework's local secret-pattern set
 * (test/e2e-scenario/scenarios/orchestrators/redaction.ts) must stay in
 * lockstep with the canonical product source
 * (src/lib/security/secret-patterns.ts).
 *
 * The framework deliberately mirrors rather than imports — see the
 * "Framework-local mirror" comment in redaction.ts for why — but the
 * mirror is only safe if it is actually a mirror. This test parses
 * both source files at the textual level and compares the regex
 * literals.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

// Pull only regex literals (lines starting with `/` and ending with
// a flag set like /g or /gi). Filters out comment lines like `// NVIDIA`
// that begin with `/` but are not regex.
const REGEX_LITERAL_LINE = /^\/.+\/[a-z]*,?$/;

function extractFromBlock(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => REGEX_LITERAL_LINE.test(line))
    .map((line) => line.replace(/,\s*$/, ""));
}

function extractRegexLiterals(source: string, exportName: string): string[] {
  const re = new RegExp(`export const ${exportName}[^=]*=\\s*\\[([\\s\\S]*?)\\];`, "m");
  const m = source.match(re);
  return m ? extractFromBlock(m[1]) : [];
}

function extractFrameworkArray(source: string, constName: string): string[] {
  const re = new RegExp(`const ${constName}: RegExp\\[\\] = \\[([\\s\\S]*?)\\];`, "m");
  const m = source.match(re);
  return m ? extractFromBlock(m[1]) : [];
}

describe("framework redaction parity with product source-of-truth", () => {
  const productSource = fs.readFileSync(
    path.join(REPO_ROOT, "src/lib/security/secret-patterns.ts"),
    "utf8",
  );
  const frameworkSource = fs.readFileSync(
    path.join(REPO_ROOT, "test/e2e-scenario/scenarios/orchestrators/redaction.ts"),
    "utf8",
  );

  it("test_framework_TOKEN_PREFIX_PATTERNS_matches_product_source", () => {
    const product = extractRegexLiterals(productSource, "TOKEN_PREFIX_PATTERNS");
    const framework = extractFrameworkArray(frameworkSource, "TOKEN_PREFIX_PATTERNS");
    expect(framework.length).toBeGreaterThan(0);
    expect(product.length).toBeGreaterThan(0);
    expect(framework).toEqual(product);
  });

  it("test_framework_CONTEXT_PATTERNS_matches_product_source", () => {
    const product = extractRegexLiterals(productSource, "CONTEXT_PATTERNS");
    const framework = extractFrameworkArray(frameworkSource, "CONTEXT_PATTERNS");
    expect(framework.length).toBeGreaterThan(0);
    expect(product.length).toBeGreaterThan(0);
    expect(framework).toEqual(product);
  });
});
