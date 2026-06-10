// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { patchStagedDockerfile } from "../../../dist/lib/onboard/dockerfile-patch";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("dockerfile patch security guards", () => {
  it("refuses to patch a staged Dockerfile symlink", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dockerfile-link-test-"));
    tmpRoots.push(dir);
    const realDockerfile = path.join(dir, "real.Dockerfile");
    const linkDockerfile = path.join(dir, "Dockerfile");
    fs.writeFileSync(realDockerfile, "ARG NEMOCLAW_MODEL=old\n", "utf-8");
    fs.symlinkSync(realDockerfile, linkDockerfile);

    expect(() =>
      patchStagedDockerfile(
        linkDockerfile,
        "custom-model",
        "https://chat.example",
        "build-1",
        "compatible-endpoint",
        null,
        null,
        [],
        {},
        {},
        null,
        {},
        {},
        false,
        null,
        [],
        {},
      ),
    ).toThrow(/Refusing to patch Dockerfile through a symlink/);
  });
});
