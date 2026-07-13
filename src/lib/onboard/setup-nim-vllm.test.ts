// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireValue } from "../core/require-value";
import type { SetupNimSelectionState } from "./setup-nim-flow";
import {
  buildDgxSparkExistingVllmHeadroomWarning,
  createSetupNimVllmHandler,
  type SetupNimVllmDeps,
} from "./setup-nim-vllm";

function state(model: string | null): SetupNimSelectionState {
  return {
    model,
    provider: "nvidia-prod",
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    allowToolsIncompatible: false,
  };
}

function deps(overrides: Partial<SetupNimVllmDeps> = {}): SetupNimVllmDeps {
  return {
    VLLM_PORT: 8000,
    runCapture: () => JSON.stringify({ data: [{ id: "served/model" }] }),
    getLocalProviderBaseUrl: () => "http://host.openshell.internal:8000/v1",
    getLocalProviderValidationBaseUrl: () => "http://127.0.0.1:8000/v1",
    isSafeModelId: () => true,
    requireValue,
    validateOpenAiLikeSelection: async () => ({ ok: true, api: "openai-completions" }),
    applyVllmRuntimeContextWindow: vi.fn(),
    isDgxSparkHost: () => false,
    exitProcess: (code) => {
      throw new Error(`exit ${code}`);
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("setupNim vLLM route containment", () => {
  it("preflights before discovery and exact-checks the detected model before validation (#6315)", async () => {
    const events: string[] = [];
    const selection = state(null);
    selection.assertRouteCompatible = () => {
      events.push(selection.model ? "exact" : "preflight");
      return { requiredModel: null, requiredEndpointUrl: null, requiredInferenceApi: null };
    };
    const handler = createSetupNimVllmHandler(
      deps({
        runCapture: () => {
          events.push("probe");
          return JSON.stringify({ data: [{ id: "served/model" }] });
        },
        validateOpenAiLikeSelection: async () => {
          events.push("validate");
          return { ok: true, api: "openai-completions" };
        },
      }),
    );

    await expect(handler(selection)).resolves.toBe("selected");
    expect(events).toEqual(["preflight", "probe", "exact", "validate"]);
  });

  it("rejects a detected model that differs from the durable shared route before validation", async () => {
    const validate = vi.fn(async () => ({ ok: true }));
    const selection = state("required/model");
    selection.assertRouteCompatible = () => ({
      requiredModel: "required/model",
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    });
    const handler = createSetupNimVllmHandler(deps({ validateOpenAiLikeSelection: validate }));

    await expect(handler(selection)).rejects.toThrow("exit 1");
    expect(validate).not.toHaveBeenCalled();
  });

  it("warns on DGX Spark when an existing vLLM serves a large unquantized model", async () => {
    const selection = state(null);
    const handler = createSetupNimVllmHandler(
      deps({
        isDgxSparkHost: () => true,
        runCapture: () =>
          JSON.stringify({
            data: [{ id: "Qwen/Qwen3.6-35B-A3B", max_model_len: 131072 }],
          }),
      }),
    );

    await expect(handler(selection)).resolves.toBe("selected");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Existing vLLM on DGX Spark"),
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("NV_ERR_NO_MEMORY"));
  });

  it("does not warn on DGX Spark for the managed vLLM handoff", async () => {
    const selection = state("Qwen/Qwen3.6-35B-A3B");
    const handler = createSetupNimVllmHandler(
      deps({
        isDgxSparkHost: () => true,
        runCapture: () =>
          JSON.stringify({
            data: [{ id: "Qwen/Qwen3.6-35B-A3B", max_model_len: 131072 }],
          }),
      }),
    );

    await expect(handler(selection, { managedInstall: true })).resolves.toBe("selected");
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("DGX Spark existing vLLM headroom warning", () => {
  it("does not warn for quantized Spark model IDs", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        { data: [{ id: "nvidia/Qwen3.6-35B-A3B-NVFP4", max_model_len: 262144 }] },
        "nvidia/Qwen3.6-35B-A3B-NVFP4",
      ),
    ).toBeNull();
  });

  it("includes the reported max_model_len when available", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        { data: [{ id: "nvidia/nemotron-3-super", max_model_len: 262144 }] },
        "nvidia/nemotron-3-super",
      ),
    ).toContain("max_model_len=262144");
  });

  it("warns for numeric model sizes at or above the large-model threshold", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        { data: [{ id: "Qwen/Qwen2.5-72B-Instruct", max_model_len: 32768 }] },
        "Qwen/Qwen2.5-72B-Instruct",
      ),
    ).toContain("Qwen/Qwen2.5-72B-Instruct");
  });

  it("warns for numeric model sizes at the large-model threshold", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        { data: [{ id: "Qwen/Qwen3-30B-A3B", max_model_len: 32768 }] },
        "Qwen/Qwen3-30B-A3B",
      ),
    ).toContain("Qwen/Qwen3-30B-A3B");
  });

  it("does not warn for smaller unquantized model IDs", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        { data: [{ id: "Qwen/Qwen2.5-14B-Instruct", max_model_len: 32768 }] },
        "Qwen/Qwen2.5-14B-Instruct",
      ),
    ).toBeNull();
  });
});
