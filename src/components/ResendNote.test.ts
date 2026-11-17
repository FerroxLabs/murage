// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// D7: a rebuild blocked because an attempt may have been written is never silent: one plain line and a Send again that sends the
// same words under a NEW send id.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { groupActivityRuns } from "@/lib/activity-runs";
import { toolBudgetLabel } from "@/lib/tool-budget-copy";
import { t } from "@/lib/i18n";
import { roomRetryTarget } from "@/lib/room-member-retry";
import { RESEND_OFFER_LINE } from "../../shared/resend-offer";
import { turnRefusedLine } from "../../server/memory/dispatch";
import { isResendNote, resendAction, roomResendSender, resendWords, ResendNoteRow } from "./ResendNote";
const of = (messageId: string, threadId: string, botId?: string) => ({ messageId, threadId, ...(botId ? { botId } : {}) });

// shared/resend-offer.ts RESEND_OFFER_LINE, checked against its source below
const line = "The AI may already be working on this message, so Murage did not send it twice. Use Send again to send it now.";
const user = { id: "u1", at: 1, role: "user", kind: "text", text: "book the table" } as Message;
const note = { id: "n1", at: 2, role: "bot", kind: "activity", memoryNote: "resend", resendOf: { messageId: "u1", threadId: "thread-1", botId: "bot-1" }, tool: { name: line, ok: true } } as Message;
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("the resend note", () => {
  it("shows the line and a Send again action", () => {
    const markup = renderToStaticMarkup(createElement(ResendNoteRow, { text: line, onSendAgain: () => {} }));
    expect(markup).toContain('data-testid="resend-note"');
    expect(markup).toContain(t("engine.submission.resendOffer"));
    expect(markup).toContain('data-testid="resend-note-send-again"');
    expect(markup).toContain("Send again");
    expect(toolBudgetLabel(line)).toBe(t("engine.submission.resendOffer"));
    expect(read("../../shared/resend-offer.ts")).toContain(`"${line}"`);
    expect(RESEND_OFFER_LINE).toBe(line);
    expect(turnRefusedLine("Codex", "resend-offer")).toBe(line);
  });
  it("offers no action when there are no words to send", () => {
    expect(renderToStaticMarkup(createElement(ResendNoteRow, { text: line }))).not.toContain("resend-note-send-again");
  });
  it("is told by its mark and never folded into a run of tool steps", () => {
    expect(isResendNote(note)).toBe(true);
    expect(isResendNote({ ...note, memoryNote: undefined })).toBe(false);
    const step = (id: string, at: number) => ({ id, at, role: "bot", kind: "activity", tool: { name: "Read file", ok: true } }) as Message;
    const items = groupActivityRuns([step("a", 1), step("b", 2), note, step("c", 4), step("d", 5)]);
    const own = items.find((item) => item.kind === "message" && item.message.id === "n1");
    expect(own).toBeTruthy();
  });
  it("Send again sends the preceding user message once, under a NEW send id", () => {
    const scope = { threadId: "thread-1", botId: "bot-1" };
    expect(resendWords([user, note], note, scope)).toBe("book the table");
    const ids = ["s-new"];
    const action = resendAction([user, note], note, "bot-1", "thread-1", () => ids.shift()!);
    expect(action).toEqual({ type: "send", botId: "bot-1", text: "book the table", sendId: "s-new", threadId: "thread-1" });
    expect(ids).toHaveLength(0);
    expect(resendAction([note], note, "bot-1", "thread-1", () => "x")).toBeUndefined();
    // the row names no message (an old row), another conversation, another bot, or a message with pictures: nothing is offered
    expect(resendAction([user, note], { ...note, resendOf: undefined } as Message, "bot-1", "thread-1", () => "x")).toBeUndefined();
    expect(resendAction([user, note], { ...note, resendOf: of("u1", "other", "bot-1") } as Message, "bot-1", "thread-1", () => "x")).toBeUndefined();
    expect(resendAction([user, note], { ...note, resendOf: of("u1", "thread-1", "bot-2") } as Message, "bot-1", "thread-1", () => "x")).toBeUndefined();
    const withPicture = { ...user, attachments: [{ kind: "image", path: "p.png", mime: "image/png" }] } as Message;
    expect(resendAction([withPicture, note], note, "bot-1", "thread-1", () => "x")).toBeUndefined();
  });
  it("Send again resends the message the row was posted for, never the nearest user row (a message B sent while the refused turn A ran)", () => {
    const a = { ...user, id: "uA", text: "message A" } as Message;
    const b = { ...user, id: "uB", at: 2, text: "message B" } as Message;
    const refusalForA = { ...note, at: 3, resendOf: of("uA", "thread-1", "bot-1") } as Message;
    expect(resendAction([a, b, refusalForA], refusalForA, "bot-1", "thread-1", () => "s")).toMatchObject({ text: "message A" });
    const roomNoteForA = { ...refusalForA, from: { botId: "m1", name: "Ada", color: "ember" }, resendOf: of("uA", "th1", "m1") } as unknown as Message;
    const send = roomResendSender([a, b, roomNoteForA], roomNoteForA, { memberIds: ["m1"], roomBusy: false, groupId: "g1", threadId: "th1" }, () => "s");
    expect(send!()).toMatchObject({ text: "message A", responderId: "m1" });
  });
  it("the room: the line from the member, and Send again sends the same words to that member", () => {
    const roomNote = { ...note, from: { botId: "m1", name: "Ada", color: "ember" }, resendOf: of("u1", "th1", "m1") } as unknown as Message;
    expect(isResendNote(roomNote)).toBe(true);
    const target = roomRetryTarget([user, roomNote], roomNote, { memberIds: ["m1", "m2"], roomBusy: false });
    expect(target).toEqual({ responderId: "m1", text: "book the table" });
    expect(roomRetryTarget([user, roomNote], roomNote, { memberIds: ["m1"], roomBusy: true })).toBeNull();
    const room = read("./GroupView.tsx");
    expect(room).toMatch(/isResendNote\(m\) \? \(\s*\/\/[^\n]*\n\s*<RoomResendNote /);
    const server = read("../../server/index.ts");
    expect(server).toMatch(/if \(roomResendOffer\) roomResendRow\(\);/);
    expect(server).toMatch(/const roomResendRow = \(\) => \{[\s\S]*?memoryNote: "resend" as const/);
  });
  it("the room's Send again by behaviour: the same words, the same member, a NEW send id each time, and nothing while the room is busy", () => {
    const roomNote = { ...note, from: { botId: "m1", name: "Ada", color: "ember" }, resendOf: of("u1", "th1", "m1") } as unknown as Message;
    const base = { memberIds: ["m1", "m2"], roomBusy: false, groupId: "g1", threadId: "th1" };
    const ids = ["s-1", "s-2"];
    const send = roomResendSender([user, roomNote], roomNote, base, () => ids.shift()!);
    expect(send).toBeTypeOf("function");
    expect(ids).toHaveLength(2); // nothing is minted until the person clicks
    expect(send!()).toEqual({ type: "sendGroup", groupId: "g1", text: "book the table", sendId: "s-1", threadId: "th1", mode: "chat", responderId: "m1" });
    expect(send!()).toMatchObject({ sendId: "s-2", text: "book the table", responderId: "m1" });
    expect(roomResendSender([user, roomNote], roomNote, { ...base, roomBusy: true }, () => "x")).toBeUndefined();
    expect(roomResendSender([user, roomNote], roomNote, { ...base, memberIds: ["m2"] }, () => "x")).toBeUndefined();
    expect(roomResendSender([roomNote], roomNote, base, () => "x")).toBeUndefined();
  });
  it("one row, not two: the blocked-rebuild sites write the card only when the line is not offered", () => {
    const server = read("../../server/index.ts");
    expect(server).toContain('if (kind !== "after-submission-uncertain") store.appendMessage(');
    expect(server).toContain("if (!resendOffer) store.appendMessage(");
    expect(server).toContain("else if (!pinFailure) store.appendMessage(");
  });
  it("the chat draws the row and dispatches resendAction with a fresh id", () => {
    const chat = read("./ChatView.tsx");
    expect(chat).toMatch(/if \(isResendNote\(m\)\)/);
    expect(chat).toMatch(/<ChatResendNote messages=\{messages\} note=\{m\} botId=\{bot\.id\} threadId=\{bot\.threadId\}/);
  });
});
