// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { compileRunPlans, renderPlanText, writePlanArtifacts } from "./compiler.ts";
import { ScenarioRunner } from "./orchestrators/runner.ts";
import { listScenarios } from "./registry.ts";
import type { PhaseResult } from "./types.ts";

interface Args {
  list: boolean;
  emitMatrix: boolean;
  planOnly: boolean;
  scenarios: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, emitMatrix: false, planOnly: false, scenarios: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      args.list = true;
      continue;
    }
    if (arg === "--emit-matrix") {
      args.emitMatrix = true;
      continue;
    }
    if (arg === "--plan-only") {
      args.planOnly = true;
      continue;
    }
    if (arg === "--scenarios") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--scenarios requires a comma-separated value");
      }
      args.scenarios = value.split(",").map((id) => id.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printList() {
  console.log("hybrid scenario registry");
  for (const scenario of listScenarios()) {
    console.log(`- ${scenario.id}${scenario.description ? `: ${scenario.description}` : ""}`);
  }
}

function emitMatrix() {
  // Read-only emission of the typed registry as a GitHub Actions matrix
  // payload. Consumed by the dynamic matrix workflow (PR #4359).
  const payload = {
    include: listScenarios().map((scenario) => ({
      id: scenario.id,
      description: scenario.description ?? "",
    })),
  };
  console.log(JSON.stringify(payload));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    printList();
    return;
  }
  if (args.emitMatrix) {
    emitMatrix();
    return;
  }

  if (args.scenarios.length === 0) {
    throw new Error("scenario execution requires --scenarios <id[,id...]>");
  }

  if (process.env.E2E_SUITE_FILTER) {
    throw new Error("E2E_SUITE_FILTER is not supported; define assertion selection in scenario builders.");
  }

  const plans = compileRunPlans(args.scenarios);
  const contextDir = process.env.E2E_CONTEXT_DIR ?? process.cwd();
  writePlanArtifacts(plans, contextDir);
  console.log(renderPlanText(plans));

  if (args.planOnly) {
    // Local debug only. Workflows must not pass --plan-only.
    return;
  }

  const runner = new ScenarioRunner();
  const allResults: PhaseResult[] = [];
  let anyFailed = false;
  for (const plan of plans) {
    const results = await runner.run({ contextDir }, plan);
    allResults.push(...results);
    if (results.some((result) => result.status === "failed")) {
      anyFailed = true;
    }
  }

  // Surface a compact run summary so phase results don't have to be opened
  // to see what passed.
  console.log("");
  console.log("Phase results:");
  for (const result of allResults) {
    const counts = result.assertions.reduce(
      (acc, assertion) => {
        acc[assertion.status] = (acc[assertion.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    const detail = Object.entries(counts)
      .map(([status, count]) => `${status}=${count}`)
      .join(" ");
    console.log(`  ${result.phase}: ${result.status} (${detail || "no steps"})`);
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
