// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_BROKER_TOOL_TIMEOUT_MS } from "./drivers/claude.ts";
import { HOOK_ASK_BOUND_MS } from "./drivers/codex-hook.ts";
import { FUIGO_TURN_PINS } from "./drivers/acp/fuigo.ts";
import { GROK_ASK_CLOCK, isolateGrokFromPersonalSetup } from "./drivers/acp/grok.ts";
import { askNoteTurnInput, decorateAskNoteInstance, setAskNoteResolver } from "./harness/ask-note-adapter.ts";
import type { ProviderInstance, SendTurnInput } from "./contracts.ts";

afterEach(() => setAskNoteResolver(() => false));

describe("question cards wait for the owner", () => {
  it("a turn takes the note only when the resolver says nobody is at it, whatever the caller passed", () => {
    const turn = { threadId: "desk", text: "go", unattendedAskNote: true } as SendTurnInput;
    expect(askNoteTurnInput(turn)).not.toHaveProperty("unattendedAskNote");
    setAskNoteResolver((threadId) => threadId === "routine");
    expect(askNoteTurnInput({ ...turn, threadId: "routine" }).unattendedAskNote).toBe(true);
  });

  it("every engine call passes through the mark, and everything else on the instance is untouched", async () => {
    setAskNoteResolver(() => true);
    const sendTurn = vi.fn(async () => ({ turnId: "t" }));
    const live = { instanceId: "i", adapter: { sendTurn, other: () => "kept" } } as unknown as ProviderInstance;
    const decorated = decorateAskNoteInstance(live);
    await decorated.adapter.sendTurn({ threadId: "routine", text: "go" } as SendTurnInput);
    expect(sendTurn).toHaveBeenCalledWith({ threadId: "routine", text: "go", unattendedAskNote: true });
    expect((decorated.adapter as unknown as { other(): string }).other()).toBe("kept");
    expect(decorated.instanceId).toBe("i");
  });

  it("Claude's broker limit is the 20 day transport limit, above Claude's own 30 minute idle limit", () => {
    expect(CLAUDE_BROKER_TOOL_TIMEOUT_MS).toBe(HOOK_ASK_BOUND_MS);
    expect(CLAUDE_BROKER_TOOL_TIMEOUT_MS).toBeGreaterThan(30 * 60_000);
    expect(CLAUDE_BROKER_TOOL_TIMEOUT_MS).toBeLessThan(2 ** 31);
  });

  it("Fuigo's own question clock is off on every turn", () => {
    expect(FUIGO_TURN_PINS).toMatchObject({ FUIGO_ASK_USER_QUESTION_TIMEOUT_ENABLED: "false" });
  });

  it("Grok's own question clock is off, over any value and any casing the owner set", () => {
    const env: Record<string, string | undefined> = { [GROK_ASK_CLOCK]: "true", grok_ask_user_question_timeout_enabled: "1" };
    isolateGrokFromPersonalSetup(env);
    expect(env[GROK_ASK_CLOCK]).toBe("false");
    expect(env.grok_ask_user_question_timeout_enabled).toBeUndefined();
  });
});
