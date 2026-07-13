// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SetupNimSelectionResult, SetupNimSelectionState } from "./setup-nim-flow";

type VllmModelEntry = { id?: unknown; max_model_len?: unknown };
type VllmModels = { data?: VllmModelEntry[] };

export interface SetupNimVllmSelectionOptions {
  managedInstall?: boolean;
  /** True when the already-detected GPU confirms DGX Spark (covers firmware-unknown GB10 hosts). */
  sparkHost?: boolean;
}

export interface SetupNimVllmDeps {
  VLLM_PORT: number;
  runCapture(args: string[], options: { ignoreError: boolean }): string;
  getLocalProviderBaseUrl(provider: string): string | null;
  getLocalProviderValidationBaseUrl(provider: string): string | null;
  isSafeModelId(model: string): boolean;
  requireValue<T>(value: T | null | undefined, message: string): T;
  validateOpenAiLikeSelection(
    label: string,
    endpointUrl: string,
    model: string,
    credentialEnv: string | null,
  ): Promise<{ ok: boolean; retry?: string; api?: string | null }>;
  applyVllmRuntimeContextWindow(models: VllmModels, model: string): void;
  isDgxSparkHost?: () => boolean;
  exitProcess(code: number): never;
}

const SPARK_LONG_CONTEXT_WARNING_THRESHOLD = 131_072;
const LARGE_MODEL_SIZE_PATTERN = /(?:^|[-_/])(\d+(?:\.\d+)?)b(?:$|[-_/])/gi;
const LARGE_MODEL_SIZE_THRESHOLD_B = 30;
const LARGE_MODEL_KEYWORD_PATTERN = /(?:^|[-_/])super(?:$|[-_/])/i;
// Heuristic: suppress the large-model warning when the served-model alias contains
// a well-known quantization marker. Aliases are not authoritative — vLLM allows
// arbitrary names — but explicit quantization suffixes (nvfp4, fp8, awq, gptq,
// int4, int8) are a strong conventional signal. Long-context (max_model_len) is
// evaluated independently and can still trigger a warning even for quantized names.
const QUANTIZED_MODEL_PATTERN =
  /(?:^|[-_/])(?:nvfp4|fp4|fp8|awq|gptq|int4|int8|modelopt|quant)(?:$|[-_/])/i;

function parsePositiveInteger(value: unknown): number | null {
  const normalized = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isSafeInteger(normalized) && normalized > 0 ? normalized : null;
}

function findVllmModelEntry(models: VllmModels, detectedModel: string): VllmModelEntry | null {
  const entries = Array.isArray(models.data) ? models.data : [];
  return (
    entries.find((entry) => String(entry?.id ?? "").trim() === detectedModel) ??
    (entries.length === 1 ? entries[0] : null)
  );
}

function isLargeModelId(model: string): boolean {
  for (const match of model.matchAll(LARGE_MODEL_SIZE_PATTERN)) {
    const sizeBillions = Number(match[1]);
    if (Number.isFinite(sizeBillions) && sizeBillions >= LARGE_MODEL_SIZE_THRESHOLD_B) {
      return true;
    }
  }
  return LARGE_MODEL_KEYWORD_PATTERN.test(model);
}

export function buildDgxSparkExistingVllmHeadroomWarning(
  models: VllmModels,
  detectedModel: string,
): string | null {
  const model = detectedModel.trim();
  if (!model) return null;

  const largeModel = isLargeModelId(model);
  const quantizedModel = QUANTIZED_MODEL_PATTERN.test(model);
  const maxModelLen = parsePositiveInteger(findVllmModelEntry(models, model)?.max_model_len);
  const longContext = !!maxModelLen && maxModelLen >= SPARK_LONG_CONTEXT_WARNING_THRESHOLD;

  // Warn when the model is heuristically large+unquantized, OR when the reported
  // context window is very large (independent of model size — KV cache alone can
  // exhaust unified memory on DGX Spark regardless of parameter count).
  const riskyLargeModel = largeModel && !quantizedModel;
  if (!riskyLargeModel && !longContext) return null;

  const contextText = maxModelLen ? ` with max_model_len=${String(maxModelLen)}` : "";
  const contextHint = longContext
    ? " The reported context window is very large for a unified-memory host."
    : "";
  const riskDescription = riskyLargeModel
    ? "Large, heuristically-classified unquantized checkpoints"
    : "High-context configurations";

  return (
    `  ! Existing vLLM on DGX Spark is serving '${model}'${contextText}. ` +
    `${riskDescription} can leave too little unified-memory headroom and may surface ` +
    "as NVRM NV_ERR_NO_MEMORY or a hard host freeze under agent/tool load." +
    contextHint +
    " Prefer the managed Spark vLLM path (NEMOCLAW_PROVIDER=install-vllm) or restart vLLM " +
    "with lower --gpu-memory-utilization, --max-model-len, --max-num-seqs, and " +
    "--max-num-batched-tokens before onboarding."
  );
}

export function createSetupNimVllmHandler(
  deps: SetupNimVllmDeps,
): (
  state: SetupNimSelectionState,
  options?: SetupNimVllmSelectionOptions,
) => Promise<SetupNimSelectionResult> {
  return async function handleVllmSelection(
    state: SetupNimSelectionState,
    options: SetupNimVllmSelectionOptions = {},
  ): Promise<SetupNimSelectionResult> {
    console.log(`  ✓ Using existing vLLM on localhost:${deps.VLLM_PORT}`);
    state.provider = "vllm-local";
    state.credentialEnv = null;
    state.endpointUrl = deps.getLocalProviderBaseUrl(state.provider);
    if (!state.endpointUrl) {
      console.error("  Local vLLM base URL could not be determined.");
      deps.exitProcess(1);
    }
    state.preferredInferenceApi = "openai-completions";
    state.assertRouteCompatible?.();
    const requiredModel = typeof state.model === "string" ? state.model : null;

    const raw = deps.runCapture(["curl", "-sf", `http://127.0.0.1:${deps.VLLM_PORT}/v1/models`], {
      ignoreError: true,
    });
    let models: VllmModels;
    try {
      models = JSON.parse(raw);
    } catch {
      console.error(
        `  Could not query vLLM models endpoint. Is vLLM running on localhost:${deps.VLLM_PORT}?`,
      );
      deps.exitProcess(1);
    }
    const detectedModel =
      models.data && models.data.length > 0 && typeof models.data[0]?.id === "string"
        ? models.data[0].id
        : null;
    if (!detectedModel) {
      console.error("  Could not detect model from vLLM. Please specify manually.");
      deps.exitProcess(1);
    }
    if (!deps.isSafeModelId(detectedModel)) {
      console.error("  Detected vLLM model ID contains invalid characters.");
      deps.exitProcess(1);
    }
    if (requiredModel && detectedModel !== requiredModel) {
      console.error(
        `  Detected vLLM model '${detectedModel}' does not match the shared gateway route '${requiredModel}'.`,
      );
      deps.exitProcess(1);
    }
    state.model = detectedModel;
    state.assertRouteCompatible?.();
    console.log(`  Detected model: ${state.model}`);
    // options.sparkHost carries the already-detected GPU result (covers firmware-unknown
    // GB10 hosts that detectNvidiaPlatform() alone would miss); fall back to the dep.
    const isSparkHost =
      options.sparkHost !== undefined ? options.sparkHost : (deps.isDgxSparkHost?.() ?? false);
    if (!options.managedInstall && isSparkHost) {
      const warning = buildDgxSparkExistingVllmHeadroomWarning(models, detectedModel);
      if (warning) console.warn(warning);
    }

    const validationBaseUrl = deps.getLocalProviderValidationBaseUrl(state.provider);
    if (!validationBaseUrl) {
      console.error("  Local vLLM validation URL could not be determined.");
      deps.exitProcess(1);
    }
    const validation = await deps.validateOpenAiLikeSelection(
      "Local vLLM",
      validationBaseUrl,
      deps.requireValue(state.model, "Expected a detected vLLM model"),
      null,
    );
    if (validation.retry === "selection" || validation.retry === "model" || !validation.ok) {
      return "retry-selection";
    }

    deps.applyVllmRuntimeContextWindow(models, state.model);
    if (validation.api !== "openai-completions") {
      console.log(
        "  ℹ Using chat completions API (tool-call-parser requires /v1/chat/completions)",
      );
    }
    state.preferredInferenceApi = "openai-completions";
    return "selected";
  };
}
