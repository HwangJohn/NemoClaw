// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerExecFileSync } from "../adapters/docker/exec";
import {
  DEFAULT_GATEWAY_BIND_ADDRESS,
  type GatewayBindAddress,
  WILDCARD_GATEWAY_BIND_ADDRESS,
  getGatewayConnectHost,
  getGatewayHttpEndpoint,
  getGatewayHttpsEndpoint,
} from "../core/gateway-address";
import { GATEWAY_PORT } from "../core/ports";
import {
  hasOpenShellGatewayUserService,
  startPackageManagedDockerDriverGateway,
  type PackageManagedDockerDriverGatewayOptions,
} from "./docker-driver-gateway-service";

export { getGatewayHttpsEndpoint };
export { startPackageManagedDockerDriverGateway };

const WSL_DOCKER_DESKTOP_DETECTION_TIMEOUT_MS = 30_000;

export const DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS = [
  "OPENSHELL_DRIVERS",
  "OPENSHELL_BIND_ADDRESS",
  "OPENSHELL_SERVER_PORT",
  "OPENSHELL_DISABLE_TLS",
  "OPENSHELL_DISABLE_GATEWAY_AUTH",
  "OPENSHELL_DB_URL",
  "OPENSHELL_GRPC_ENDPOINT",
  "OPENSHELL_SSH_GATEWAY_HOST",
  "OPENSHELL_SSH_GATEWAY_PORT",
  "OPENSHELL_DOCKER_NETWORK_NAME",
  "OPENSHELL_DOCKER_SUPERVISOR_IMAGE",
  "OPENSHELL_DOCKER_SUPERVISOR_BIN",
  "OPENSHELL_VM_DRIVER_STATE_DIR",
  "OPENSHELL_DRIVER_DIR",
] as const;

export interface BuildDockerDriverGatewayEnvOptions {
  platform?: NodeJS.Platform;
  stateDir: string;
  dockerNetworkName?: string;
  gatewayBindAddress?: GatewayBindAddress;
  gatewayBindAddressOptions?: ResolveGatewayBindAddressOptions;
  getDockerSupervisorImage: () => string;
  resolveSandboxBin: () => string | null;
}

export interface ResolveGatewayBindAddressOptions {
  env?: NodeJS.ProcessEnv;
  detectWslDockerDesktopStatus?: () => WslDockerDesktopStatus;
}

type WslDockerDesktopStatus = "docker-desktop" | "not-docker-desktop" | "unknown";
type GatewayBindAddressSource = "env" | "docker-desktop-wsl" | "default";

let cachedDefaultWslDockerDesktopStatus: WslDockerDesktopStatus | null = null;

function configuredGatewayBindAddress(
  env: NodeJS.ProcessEnv,
): { bindAddress: GatewayBindAddress; source: "env" } | null {
  const raw = env.NEMOCLAW_GATEWAY_BIND_ADDRESS;
  if (raw === undefined || raw === "") return null;
  const trimmed = String(raw).trim();
  if (trimmed === DEFAULT_GATEWAY_BIND_ADDRESS) {
    return { bindAddress: DEFAULT_GATEWAY_BIND_ADDRESS, source: "env" };
  }
  if (trimmed === WILDCARD_GATEWAY_BIND_ADDRESS) {
    return { bindAddress: WILDCARD_GATEWAY_BIND_ADDRESS, source: "env" };
  }
  throw new Error(
    `Invalid gateway bind address: NEMOCLAW_GATEWAY_BIND_ADDRESS="${raw}" — must be either ${DEFAULT_GATEWAY_BIND_ADDRESS} or ${WILDCARD_GATEWAY_BIND_ADDRESS}`,
  );
}

function isWslRuntime(env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== "linux") return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  if (/microsoft/i.test(os.release())) return true;
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf-8"));
  } catch {
    return false;
  }
}

function defaultDetectWslDockerDesktopStatus(
  env: NodeJS.ProcessEnv = process.env,
): WslDockerDesktopStatus {
  const canUseCache = env === process.env;
  if (canUseCache && cachedDefaultWslDockerDesktopStatus !== null) {
    return cachedDefaultWslDockerDesktopStatus;
  }
  if (!isWslRuntime(env)) {
    if (canUseCache) cachedDefaultWslDockerDesktopStatus = "not-docker-desktop";
    return "not-docker-desktop";
  }
  try {
    const output = dockerExecFileSync(["info", "--format", "{{json .OperatingSystem}}"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: WSL_DOCKER_DESKTOP_DETECTION_TIMEOUT_MS,
    }).trim();
    const status =
      !output || output === "<no value>"
        ? "unknown"
        : /^"?docker desktop\b/i.test(output)
          ? "docker-desktop"
          : "not-docker-desktop";
    if (canUseCache) cachedDefaultWslDockerDesktopStatus = status;
    return status;
  } catch {
    if (canUseCache) cachedDefaultWslDockerDesktopStatus = "unknown";
    return "unknown";
  }
}

function resolveGatewayBindAddressWithSource(options: ResolveGatewayBindAddressOptions = {}): {
  bindAddress: GatewayBindAddress;
  source: GatewayBindAddressSource;
} {
  const env = options.env ?? process.env;
  const configured = configuredGatewayBindAddress(env);
  if (configured) return configured;
  const wslDockerDesktopStatus =
    options.detectWslDockerDesktopStatus?.() ?? defaultDetectWslDockerDesktopStatus(env);
  if (wslDockerDesktopStatus === "docker-desktop") {
    return { bindAddress: WILDCARD_GATEWAY_BIND_ADDRESS, source: "docker-desktop-wsl" };
  }
  return { bindAddress: DEFAULT_GATEWAY_BIND_ADDRESS, source: "default" };
}

export function resolveGatewayBindAddress(
  options: ResolveGatewayBindAddressOptions = {},
): GatewayBindAddress {
  return resolveGatewayBindAddressWithSource(options).bindAddress;
}

export type PackageManagedDockerDriverGatewayWithEnvOverrideOptions = Omit<
  PackageManagedDockerDriverGatewayOptions,
  "prepareOpenShellGatewayUserServiceEnv"
> & {
  gatewayEnv: Record<string, string>;
};

export function getGatewayPortCheckOptions(options: ResolveGatewayBindAddressOptions = {}): {
  host: string;
} {
  return { host: resolveGatewayBindAddress(options) };
}

export function getGatewayStartNetworkEnv(
  options: ResolveGatewayBindAddressOptions & { bindAddress?: GatewayBindAddress } = {},
): Record<string, string> {
  const bindAddress = options.bindAddress ?? resolveGatewayBindAddress(options);
  return {
    OPENSHELL_BIND_ADDRESS: bindAddress,
    OPENSHELL_SERVER_PORT: String(GATEWAY_PORT),
    OPENSHELL_SSH_GATEWAY_HOST: getGatewayConnectHost(bindAddress),
    OPENSHELL_SSH_GATEWAY_PORT: String(GATEWAY_PORT),
  };
}

export function getDockerDriverGatewayEndpoint(
  options: ResolveGatewayBindAddressOptions & { bindAddress?: GatewayBindAddress } = {},
): string {
  const bindAddress = options.bindAddress ?? resolveGatewayBindAddress(options);
  return getGatewayHttpEndpoint(GATEWAY_PORT, bindAddress);
}

export function warnIfGatewayWildcardBindAddress(
  options: ResolveGatewayBindAddressOptions = {},
): void {
  const resolved = resolveGatewayBindAddressWithSource(options);
  if (resolved.bindAddress !== WILDCARD_GATEWAY_BIND_ADDRESS) return;
  if (resolved.source === "docker-desktop-wsl") {
    console.log(
      "  ! Docker Desktop WSL detected; binding the OpenShell gateway to 0.0.0.0 so sandbox containers can reach host.openshell.internal.",
    );
    console.log(
      "    Set NEMOCLAW_GATEWAY_BIND_ADDRESS=127.0.0.1 to force loopback only, but Docker Desktop WSL sandbox callbacks may fail.",
    );
    return;
  }
  console.log(
    "  ! OpenShell gateway bind address set to 0.0.0.0; the gateway may be reachable from other hosts on this network.",
  );
}

export function buildDockerDriverGatewayEnv({
  platform = process.platform,
  stateDir,
  dockerNetworkName = "openshell-docker",
  gatewayBindAddress,
  gatewayBindAddressOptions,
  getDockerSupervisorImage,
  resolveSandboxBin,
}: BuildDockerDriverGatewayEnvOptions): Record<string, string> {
  const bindAddress =
    gatewayBindAddress ?? resolveGatewayBindAddress(gatewayBindAddressOptions ?? {});
  const env: Record<string, string> = {
    OPENSHELL_DRIVERS: "docker",
    ...getGatewayStartNetworkEnv({ bindAddress }),
    OPENSHELL_DISABLE_TLS: "true",
    OPENSHELL_DISABLE_GATEWAY_AUTH: "true",
    OPENSHELL_DB_URL: `sqlite:${path.join(stateDir, "openshell.db")}`,
    OPENSHELL_GRPC_ENDPOINT: getDockerDriverGatewayEndpoint({ bindAddress }),
    OPENSHELL_DOCKER_NETWORK_NAME: dockerNetworkName,
    OPENSHELL_DOCKER_SUPERVISOR_IMAGE: getDockerSupervisorImage(),
  };
  if (platform === "linux") {
    const sandboxBin = resolveSandboxBin();
    if (sandboxBin) {
      env.OPENSHELL_DOCKER_SUPERVISOR_BIN = sandboxBin;
    }
  }
  return env;
}

export function buildDockerGatewayDebEnvFile(
  existing: string,
  override: Record<string, string>,
): string {
  const managedKeyPattern = new RegExp(`^(${DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS.join("|")})=`);
  const preserved = existing
    .split("\n")
    .filter((line) => line.trim() && !managedKeyPattern.test(line));
  const managed = DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS.flatMap((key) =>
    typeof override[key] === "string" ? [formatEnvironmentFileAssignment(key, override[key])] : [],
  );
  return `${[...preserved, ...managed].join("\n")}\n`;
}

function formatEnvironmentFileAssignment(key: string, value: string): string {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`Invalid OpenShell gateway env value for ${key}: contains a line break`);
  }
  return `${key}=${value}`;
}

function readTextFileIfPresent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

function writeDockerGatewayDebEnvOverrideFile(getOverride: () => Record<string, string>): void {
  const override = getOverride();
  const envDir = path.join(os.homedir(), ".config", "openshell");
  const envFile = path.join(envDir, "gateway.env");
  fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(envDir, 0o700);
  const existing = readTextFileIfPresent(envFile);
  fs.writeFileSync(envFile, buildDockerGatewayDebEnvFile(existing, override), {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.chmodSync(envFile, 0o600);
}

export function writeDockerGatewayDebEnvOverride(
  getOverride: () => Record<string, string>,
  opts: Parameters<typeof hasOpenShellGatewayUserService>[0] = {},
): boolean {
  if (!hasOpenShellGatewayUserService(opts)) return false;
  writeDockerGatewayDebEnvOverrideFile(getOverride);
  return true;
}

export function writeDockerGatewayDebEnvOverrideOrThrow(
  getOverride: () => Record<string, string>,
  opts: Parameters<typeof hasOpenShellGatewayUserService>[0] = {},
): void {
  if (!writeDockerGatewayDebEnvOverride(getOverride, opts)) {
    throw new Error("OpenShell gateway user service env file is not available");
  }
}

export function startPackageManagedDockerDriverGatewayWithEnvOverride({
  gatewayEnv,
  ...options
}: PackageManagedDockerDriverGatewayWithEnvOverrideOptions): Promise<boolean> {
  return startPackageManagedDockerDriverGateway({
    ...options,
    prepareOpenShellGatewayUserServiceEnv: () =>
      writeDockerGatewayDebEnvOverrideFile(() => gatewayEnv),
  });
}
