// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FUIGO-SCOPE-1010 section 5 (House rule 7): how a file read, a search and a shell command of each engine reach
// Murage's key guard BEFORE they run, one row per built-in driver. read-guard-inventory.test.ts fails when a driver
// has no row, so a new engine cannot ship without saying how its reads are guarded.
//
// `p7` is what the release guard probe (P7: a decoy ~/.aws/credentials read at Ask, Auto, Full access and No limits,
// by shell and by the engine's own read tool) expects per route. "pass" means the probe must see the engine's tool
// call AND a `request.opened` from the sensitive guard. A route marked "fail:<lane>" is a known gap with its own lane:
// the probe runs it and records the FAIL visibly against that lane; it is never reported as fixed.
import type { DriverKind } from "../contracts.ts";

export interface ReadGuardRow {
  /** Plain words: the pre-execution route from the engine's call to the key guard. */
  route: string;
  /** The code that enforces it. */
  where: string;
  p7: { shell: "pass" | `fail:${string}` | "n/a"; nativeRead: "pass" | `fail:${string}` | "n/a" };
}

export const READ_GUARD_INVENTORY: Record<DriverKind, ReadGuardRow> = {
  fuigoAgent: {
    route: "a bot-owned FUIGO_HOME whose config asks for every shell command, path read, edit and search (Bash, Read(**), Edit(**), Grep, plus every sensitive-path row); always --permission-mode default",
    where: "server/drivers/acp/fuigo-scope.ts, fuigo-permission.ts",
    p7: { shell: "pass", nativeRead: "pass" },
  },
  grokAgent: {
    route: "a bot-owned GROK_HOME whose config asks for Bash, Edit, Write, Read(**) and Grep",
    where: "server/drivers/acp/grok-scope.ts GROK_ASK_RULES",
    p7: { shell: "pass", nativeRead: "pass" },
  },
  claudeAgent: { route: "CLI ask rules for the bare tools plus the sensitive-path ask rules", where: "server/drivers/claude.ts CLAUDE_BARE_ASK_TOOLS, claudeSensitiveAskRules", p7: { shell: "pass", nativeRead: "pass" } },
  codex: { route: "PreToolUse hook on every tool call", where: "server/drivers/codex-hook.ts", p7: { shell: "pass", nativeRead: "pass" } },
  piAgent: { route: "Murage's permission gate before every tool", where: "server/drivers/pi-permission-gate.ts", p7: { shell: "pass", nativeRead: "pass" } },
  hermesAgent: {
    route: "the ask hook gates the terminal and write tools; reads (read_file, search_files) reach no guard: HERMES-READS-1010",
    where: "server/drivers/acp/hermes.ts HERMES_ASK_FREE_TOOLS",
    p7: { shell: "pass", nativeRead: "fail:HERMES-READS-1010" },
  },
  cursorAgent: { route: "read-only session mode at Ask; Full access and No limits send request_permission (CONFIRM by P7)", where: "server/drivers/acp/cursor.ts", p7: { shell: "pass", nativeRead: "pass" } },
  openclawAgent: { route: "read-only session mode at Ask; Full access and No limits send request_permission (CONFIRM by P7)", where: "server/drivers/acp/openclaw.ts", p7: { shell: "pass", nativeRead: "pass" } },
  geminiAgent: { route: "ACP request_permission (CONFIRM by P7)", where: "server/drivers/acp/gemini.ts", p7: { shell: "pass", nativeRead: "pass" } },
  qwenAgent: { route: "ACP request_permission (CONFIRM by P7)", where: "server/drivers/acp/qwen.ts", p7: { shell: "pass", nativeRead: "pass" } },
  kimiAgent: { route: "ACP request_permission (CONFIRM by P7)", where: "server/drivers/acp/kimi.ts", p7: { shell: "pass", nativeRead: "pass" } },
  droidAgent: { route: "ACP request_permission (CONFIRM by P7)", where: "server/drivers/acp/droid.ts", p7: { shell: "pass", nativeRead: "pass" } },
  opencodeGo: { route: "ACP request_permission (CONFIRM by P7)", where: "server/drivers/acp/opencode-go.ts", p7: { shell: "pass", nativeRead: "pass" } },
  clineAgent: { route: "ACP request_permission (CONFIRM by P7)", where: "server/drivers/acp/cline.ts", p7: { shell: "pass", nativeRead: "pass" } },
  customAcp: { route: "ACP request_permission from whatever agent the owner added (CONFIRM by P7 per agent)", where: "server/drivers/acp/custom.ts", p7: { shell: "pass", nativeRead: "pass" } },
  grok: { route: "xAI API chat only: no engine tools, Murage's own tools carry their own checks", where: "server/drivers/grok.ts", p7: { shell: "n/a", nativeRead: "n/a" } },
  antigravityAgent: { route: "Murage's relay hooks before each tool", where: "server/drivers/antigravity-relay.ts", p7: { shell: "pass", nativeRead: "pass" } },
  boxAgent: { route: "not checked in this lane: CONFIRM by P7 (both routes expected to pass)", where: "server/drivers/boxagent.ts", p7: { shell: "pass", nativeRead: "pass" } },
  "openai-compat": { route: "chat only: no engine tools, Murage's own tools carry their own checks", where: "server/drivers/openai-compat.ts", p7: { shell: "n/a", nativeRead: "n/a" } },
  minimax: { route: "chat only: no engine tools, Murage's own tools carry their own checks", where: "server/drivers/minimax.ts", p7: { shell: "n/a", nativeRead: "n/a" } },
} as Record<DriverKind, ReadGuardRow>;
