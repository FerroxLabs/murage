// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";

// Shared resolver extracted from the restore control-plane AST witness.
export function pythonCommand(): { command: string; args: string[] } {
  const candidates = [{ command: "py", args: ["-3"] }, { command: "python3", args: [] }, { command: "python", args: [] }];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.args, "-I", "-c", "import sys; sys.exit(0 if sys.version_info.major >= 3 else 1)"], { encoding: "utf8", timeout: 5000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("Python 3 is required for this test; tried py -3, python3, python");
}
