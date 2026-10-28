// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The health contract's engine category for a driver kind (1.0.9 Sentinel, GAP-SENTINEL-109 sections 4.1 and 9).
// Only the driver kind is read, never an instance id, a display name or a model. A driver this table does not
// name reports `other`, so a new default engine never switches health reporting off.
import { toEngineKind, type EngineKind } from "../../shared/health-protocol.mjs";

const NAMED: Readonly<Record<string, EngineKind>> = {
  claudeAgent: "claude",
  codex: "codex",
  piAgent: "pi",
  antigravityAgent: "antigravity",
  opencodeGo: "opencode-go",
  "openai-compat": "openai-chat",
  grok: "openai-chat",
  minimax: "openai-chat",
};

/** `claudeAgent` -> `claude`; any other `...Agent` (Hermes, OpenClaw, Qwen, Fuigo, Box) -> `acp`; unknown -> `other`. */
export function healthEngineKind(driverKind: unknown): EngineKind {
  if (typeof driverKind !== "string" || !driverKind) return "other";
  if (Object.hasOwn(NAMED, driverKind)) return NAMED[driverKind]!;
  if (/^[a-z][A-Za-z0-9]*Agent$/.test(driverKind)) return "acp";
  return toEngineKind(driverKind);
}
