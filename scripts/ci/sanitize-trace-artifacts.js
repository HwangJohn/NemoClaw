// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_RE =
  /(?:api[_-]?key|authorization|bearer|credential|password|secret|slack[_-]?webhook|token|webhook)/i;
const SENSITIVE_VALUE_RES = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:xox[baprs]-|xapp-)[A-Za-z0-9-]{10,}/g,
  /\bnvapi-[A-Za-z0-9_-]{12,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi,
];

function redactString(value) {
  let redacted = value;
  for (const pattern of SENSITIVE_VALUE_RES) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
}

function sanitize(value, key = "") {
  if (SENSITIVE_KEY_RE.test(key)) return REDACTED;

  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitize(childValue, childKey),
      ]),
    );
  }
  return value;
}

function listJsonFiles(directory) {
  if (!fs.existsSync(directory)) return [];

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files;
}

function sanitizeTraceArtifacts(sourceDirectory, outputDirectory) {
  const sourceRoot = path.resolve(sourceDirectory);
  const outputRoot = path.resolve(outputDirectory);
  const files = listJsonFiles(sourceRoot);

  fs.mkdirSync(outputRoot, { recursive: true });

  for (const file of files) {
    const relativePath = path.relative(sourceRoot, file);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Refusing to write unsafe trace path: ${file}`);
    }

    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const sanitized = sanitize(parsed);
    const outputPath = path.join(outputRoot, relativePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  }

  return { files: files.length, outputDirectory: outputRoot };
}

if (require.main === module) {
  const [sourceDirectory, outputDirectory] = process.argv.slice(2);
  if (!sourceDirectory || !outputDirectory) {
    console.error("Usage: node scripts/ci/sanitize-trace-artifacts.js <source-dir> <output-dir>");
    process.exit(2);
  }

  try {
    const result = sanitizeTraceArtifacts(sourceDirectory, outputDirectory);
    console.log(`Sanitized ${result.files} trace JSON file(s) into ${result.outputDirectory}`);
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}

module.exports = {
  REDACTED,
  sanitize,
  sanitizeTraceArtifacts,
};
