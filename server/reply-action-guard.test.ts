// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phantom-action guard on two stub engine profiles: profile T mounts
// tools and emits tool rows, profile N has no tools (a text-only runtime).
// The same replies must get the same verdict on both.
import { rmSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { recordUnverifiable, routeHasTools, type RouteCapabilityFlags } from "./engine-capabilities.ts";
import { heldQueueText, planExternalDelivery, withExternalDelivery } from "./external-context-delivery.ts";
import { checkReplyActions } from "./reply-action-guard.ts";
import { Store, type Message } from "./store.ts";
import { FLAGGED_REPLY_LINE } from "../shared/reply-action-claims.ts";

const PROFILE_T: RouteCapabilityFlags = { agentsMcp: true, composioMcp: true };
const PROFILE_N: RouteCapabilityFlags = {};
const OWN_TOOLS: RouteCapabilityFlags = { runsOnOwnTools: true };
// profile O: an agent CLI running its own tools; its tool_call events become activity rows

let n = 0;
const row = (over: Partial<Message>): Message => ({ id: `r${++n}`, at: n, role: "bot", kind: "text", ...over }) as Message;
const user = (turnId?: string) => row({ role: "user", text: "please", ...(turnId ? { turnId } : {}) });
const reply = (text: string, turnId = "t2") => row({ text, turnId, turnTerminal: true });
const tool = (name: string, turnId = "t2", over: Partial<Message> = {}) => row({ kind: "activity", tool: { name, ok: true }, turnId, ...over });

function check(_caps: RouteCapabilityFlags, text: string, record: Message[] = [], before: Message[] = []) {
  const closing = reply(text);
  return checkReplyActions({ reply: closing, path: [...before, user(), ...record, closing], unverifiable: false });
}

describe.each([["profile T", PROFILE_T], ["profile N", PROFILE_N]])("the guard on %s", (_name, caps) => {
  it("flags a claim with no record", () => {
    const result = check(caps, "Sent.");
    expect(result.state).toBe("flagged");
    expect(result.claims[0]).toMatchObject({ class: "send", state: "flagged" });
  });
  it("records a claim a tool row backs", () => {
    expect(check(caps, "I sent it", [tool("mcp__team__send_message")]).state).toBe("recorded");
    expect(check(caps, "I scheduled the review for Monday", [tool("create_routine", "t2")]).state).toBe("recorded");
  });
  it("a delivery receipt chip backs a send", () => {
    const chip = row({ kind: "activity", tool: { name: "Messaged @Wren", ok: true }, turnId: "t2", comm: { groupId: "g", withBotId: "b", withName: "Wren", withColor: "x" } });
    expect(check(caps, "I messaged Wren.", [chip]).state).toBe("recorded");
  });
  it("a failed tool row is not a record", () => {
    const failed = row({ kind: "activity", tool: { name: "send_message", ok: false }, turnId: "t2" });
    expect(check(caps, "I sent it", [failed]).state).toBe("flagged");
  });
  it("an earlier row on the branch makes it earlier, with the row linked", () => {
    const old = tool("send_message", "t0");
    const result = check(caps, "I sent that earlier", [], [old, user("t1"), row({ text: "ok", turnId: "t1", turnTerminal: true })]);
    expect(result.state).toBe("earlier");
    expect(result.claims[0]?.rowId).toBe(old.id);
  });
  it.each([
    "I will send it",
    "I can schedule that",
    "She said she sent it",
    "I couldn't send it",
    "If I had sent it",
    "> I sent it",
    "Here is the format:\n```\nI sent it\n```",
    "Should I send it?",
    "I'll send it once I've saved the file",
  ])("finds no claim in %j", (text) => {
    expect(check(caps, text).state).toBe("none");
  });
  it("marks a reply in another language unchecked", () => {
    expect(check(caps, "Ich habe die Nachricht gestern gesendet und gespeichert.").state).toBe("unchecked");
    expect(check(caps, "Ya envié el correo y guardé el archivo en la carpeta.").state).toBe("unchecked");
  });
});

describe("the guard on an engine that runs its own tools (profile O)", () => {
  it("(a) a matching tool event grounds the claim", () => {
    expect(check(OWN_TOOLS, "I sent it", [tool("Send message to Sam")]).state).toBe("recorded");
    expect(check(OWN_TOOLS, "I saved the file", [tool("Edit", "t2", { tool: { name: "Edit", summary: "notes.md", ok: true } })]).state).toBe("recorded");
  });
  it("(b) a claim with no event is flagged, like any other engine", () => {
    expect(check(OWN_TOOLS, "Sent.").state).toBe("flagged");
  });
  it("unverifiable only when a driver with tools reports no tool events (none today)", () => {
    expect(recordUnverifiable("claude", { agentsMcp: true })).toBe(false);
    expect(recordUnverifiable("openclaw", OWN_TOOLS)).toBe(false);
    expect(recordUnverifiable("openai-compat", PROFILE_N)).toBe(false);
    const closing = reply("Sent.");
    expect(checkReplyActions({ reply: closing, path: [user(), closing], unverifiable: true }).state).toBe("unverifiable");
  });
});

describe("the guard row", () => {
  it("only the terminal reply is checked; a piece of the same turn is not", () => {
    const piece = row({ text: "Looking now.", turnId: "t2" });
    const closing = reply("Done, sent.");
    const result = checkReplyActions({ reply: closing, path: [user(), piece, closing], unverifiable: false });
    expect(result.state).toBe("flagged");
    expect(piece.actionCheck).toBeUndefined();
  });
  it("an opaque shell outcome covers file actions, never a send", () => {
    expect(check(PROFILE_T, "I saved it", [tool("Bash")]).state).toBe("unverifiable");
    expect(check(PROFILE_T, "I sent it", [tool("Bash")]).state).toBe("flagged");
    expect(check(PROFILE_T, "I sent it", [], [tool("Bash", "t0")]).state).toBe("flagged");
  });
  it("a card is not completion evidence", () => {
    const card = row({ kind: "options", turnId: "t2" });
    expect(check(PROFILE_T, "I scheduled it", [card]).state).toBe("flagged");
  });
  it("the flag line is the exact copy and the vocabulary files have no em dash", () => {
    expect(FLAGGED_REPLY_LINE).toBe("This reply describes an action that has no record. Nothing was done.");
    for (const file of ["shared/reply-action-claims.ts", "server/reply-action-guard.ts", "shared/chat-engine-notes.ts"]) {
      expect(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).not.toContain("\u2014");
    }
  });
});

describe("route capabilities", () => {
  it("reads the flags drivers already declare", () => {
    expect(routeHasTools(PROFILE_T)).toBe(true);
    expect(routeHasTools(PROFILE_N)).toBe(false);
    expect(routeHasTools({ sessionModelSwitch: "in-session" } as RouteCapabilityFlags)).toBe(false);
    expect(routeHasTools(OWN_TOOLS)).toBe(true);
    expect(routeHasTools(undefined)).toBe(true);
  });
});

describe("the hold queue on a route with no tools (I-23)", () => {
  const pending = [
    { id: "m1", text: "@Helper replied to the delegated task:\n\nthe report is ready" },
    { id: "chip", text: "delegation failed" },
  ];
  it("never delivers the header, consumes nothing, and says what waits", () => {
    const plan = planExternalDelivery({ pending, branchReplay: null, routeHasTools: false });
    expect(plan.consumedIds).toEqual([]);
    expect(plan.preamble).toContain("2 item(s) that need tools are waiting");
    const prompt = withExternalDelivery("hello", plan);
    expect(prompt).not.toContain("The following was added to this conversation");
    expect(prompt).not.toContain("the report is ready");
  });
  it("counts held card continuations and keeps them held", () => {
    const plan = planExternalDelivery({ pending, branchReplay: null, routeHasTools: false, heldContinuations: [{ id: "h1", text: "[answered: allowed]", at: 1 }] });
    expect(plan.preamble).toContain("3 item(s)");
    expect(plan.consumedHeldIds).toBeUndefined();
  });
  it("delivers external results but never borrows held continuation authority", () => {
    const plan = planExternalDelivery({ pending, branchReplay: null, routeHasTools: true, heldContinuations: [{ id: "h1", text: "[answered: allowed]", at: 1 }] });
    expect(plan.consumedIds).toEqual(["m1", "chip"]);
    expect(plan.consumedHeldIds).toBeUndefined();
    expect(plan.preamble).toContain("the report is ready");
    expect(plan.preamble).not.toContain("[answered: allowed]");
  });
  it("a plain replay of the text row on a no-tools route is untouched (history, not an action)", () => {
    const plan = planExternalDelivery({ pending: [pending[0]!], branchReplay: { carriedIds: ["m1"] }, routeHasTools: false });
    expect(plan.replay).toBe(true);
    expect(plan.consumedIds).toEqual([]);
  });
  it("the owner line is the exact copy", () => {
    expect(heldQueueText(2)).toBe("Waiting for a tool-capable engine: 2 item(s). Open now");
  });
});

describe("store: held continuations and the stored check", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
  let store: Store;
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    store = new Store(selection);
  });
  it("holds an answered card, counts it with owed messages, and survives a restart", () => {
    const bot = store.createBot();
    store.recordTaskExternalUpdate(bot.id, bot.threadId, "m1");
    store.holdTaskContinuation(bot.id, bot.threadId, "[answered: allowed]");
    expect(store.heldItemCount(bot.id, bot.threadId)).toBe(2);
    const restarted = new Store(selection);
    const held = restarted.taskByThread(bot.id, bot.threadId)?.heldContinuations ?? [];
    expect(held).toHaveLength(1);
    restarted.consumeTaskHeldContinuations(bot.id, bot.threadId, held.map((item) => item.id));
    expect(restarted.heldItemCount(bot.id, bot.threadId)).toBe(1);
  });
  it("the check lives on the terminal row and reloads from the JSON column", () => {
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "go" });
    const piece = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Working.", turnId: "t1" });
    const closing = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Sent.", turnId: "t1" });
    const terminal = store.markTerminalAssistantMessage(bot.threadId, "t1");
    expect(terminal?.id).toBe(closing.id);
    const result = checkReplyActions({ reply: terminal!, path: store.activePath(bot.threadId), unverifiable: false });
    store.patchMessage(bot.threadId, closing.id, { actionCheck: result });
    const reloaded = new Store(selection).messagesFor(bot.threadId);
    expect(reloaded.find((m) => m.id === closing.id)?.actionCheck?.state).toBe("flagged");
    expect(reloaded.find((m) => m.id === piece.id)?.actionCheck).toBeUndefined();
  });
});

describe("a retried engine attempt", () => {
  // The retry reset drops only the failed attempt's streamed text. The tool row
  // it ran is stored with the turn, so the final reply is still grounded on it.
  it("keeps the failed attempt's tool row as evidence for the final reply", () => {
    const closing = reply("Sent.", "t-retry");
    const path = [user(), tool("send_message", "t-retry"), closing];
    expect(checkReplyActions({ reply: closing, path }).state).toBe("recorded");
    const flagged = checkReplyActions({ reply: closing, path: [user(), closing] });
    expect(flagged.state).toBe("flagged");
  });
});
