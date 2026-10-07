// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Claude Code too old for the model (upstream #1840, 0.1.61 triage row 2).
// ChatView cannot load in node (no DOM), so its wiring is pinned as source,
// the way ChatView.test.ts pins the rest of the transcript.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { claudeUpdateCommand, claudeUpdateTarget } from "@/lib/claude-update";

const claude = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available" }, models: { default: "", options: [] } } as InstanceInfo;
const chatView = readFileSync(fileURLToPath(new URL("./ChatView.tsx", import.meta.url)), "utf8");

describe("Update Claude for me", () => {
  it("is offered only for a Claude Code engine", () => {
    expect(claudeUpdateTarget(claude)).toBe(claude);
    expect(claudeUpdateTarget({ ...claude, driverKind: "codex" })).toBeUndefined();
    expect(claudeUpdateTarget(undefined)).toBeUndefined();
  });

  it("replaces the bare Retry under a too-old error, loaded on first use", () => {
    expect(chatView).toContain('claudeUpdateInstance={m.tool.claudeUpdate ? claudeUpdateTarget(engine) : undefined}');
    expect(chatView).toContain('retryableLazy(() => import("./ClaudeUpdatePrompt"))');
    expect(chatView).toMatch(/if \(claudeUpdateInstance\) \{\s*return <RuntimeErrorCard[^\n]*\n\s*setup=\{<Suspense/);
  });
});

describe("the O12 pin note (audit round 1, Kimi 1)", () => {
  it("is its own row ahead of the Tool calls gate, showing the sentence", () => {
    const row = chatView.indexOf("const pinnedProfile = hermesPinNoteProfile(m.tool?.name);");
    const gate = chatView.indexOf("if (!showToolCalls && !m.comm) return null;");
    expect(row).toBeGreaterThan(0);
    expect(row).toBeLessThan(gate);
    expect(chatView).toContain("{hermesPinNoteText(pinnedProfile)}");
  });
});

describe("the manual update command (audit round 1, Kimi 5)", () => {
  it("names the engine's own executable", () => {
    expect(claudeUpdateCommand(undefined)).toBe("claude update");
    expect(claudeUpdateCommand("/opt/claude/bin/claude")).toBe("/opt/claude/bin/claude update");
    expect(claudeUpdateCommand("/Applications/My Tools/claude")).toBe('"/Applications/My Tools/claude" update');
  });
});
