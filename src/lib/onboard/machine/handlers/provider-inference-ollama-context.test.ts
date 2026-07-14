// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { MIN_HERMES_OLLAMA_CONTEXT_WINDOW } from "../../../inference/ollama-runtime-context";
import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("handleProviderInferenceState Ollama context resume", () => {
  it("verifies the exact recorded Hermes model before using resume shortcuts", async () => {
    const session = createSession({
      agent: "hermes",
      provider: "ollama-local",
      model: "qwen3.5:35b",
    });
    session.steps.provider_selection.status = "complete";
    const routeReady = vi.fn(() => true);
    const { deps, calls } = createDeps({ isInferenceRouteReady: routeReady });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "hermes-local",
      agent: { name: "hermes" },
    });

    expect(calls.repair).toHaveBeenCalledWith({
      provider: "ollama-local",
      model: "qwen3.5:35b",
      contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      isNonInteractive: deps.isNonInteractive,
    });
    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(routeReady).toHaveBeenCalledWith("nemoclaw", "ollama-local", "qwen3.5:35b");
    expect(calls.setupInference).not.toHaveBeenCalled();
  });
});
