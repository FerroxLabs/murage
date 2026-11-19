// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture receipt owner: sc-safety. Retained-session consumer owner: c4-misc-a2.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeS2Qualification } from "../drivers/claude-s2-qualification.ts";

type QualificationApi = typeof import("../drivers/claude-s2-qualification.ts");
/** The scripted protocol executable is the I/O edge of these driver suites.
 * Give only that exact fixture an explicit receipt. All other executables use
 * real native admission; no environment value can grant qualification. The
 * real driver still checks MCP status and keeps unsupported fixtures on S1. */
export function withClaudeWireReceipt(actual: QualificationApi): QualificationApi {
  const fixture = fileURLToPath(new URL("fake-claude-cli.ts", import.meta.url));
  const build = createHash("sha256").update(readFileSync(fixture)).digest("hex");
  const receipt: ClaudeS2Qualification = Object.freeze({ platform: process.platform, arch: process.arch,
    version: "0.0.0", build, evidence: "isolated-scripted-protocol-receipt" });
  const qualified = () => {
    try { return createHash("sha256").update(readFileSync(fixture)).digest("hex") === receipt.build
      && actual.claudeS2Qualified({}, receipt.platform, receipt.version, receipt.build, receipt.arch, [receipt]); }
    catch { return false; }
  };
  // The final synchronous identity check uses the same exact scripted bytes.
  // Other paths still exercise the production native qualification functions.
  return { ...actual, claudeS2QualifiedCliNow: (...args) => {
    if (resolve(args[0]) !== fixture) return actual.claudeS2QualifiedCliNow(...args);
    return qualified();
  }, claudeS2QualifiedCli: async (...args) => {
    if (resolve(args[0]) !== fixture) return actual.claudeS2QualifiedCli(...args);
    return qualified();
  } };
}
