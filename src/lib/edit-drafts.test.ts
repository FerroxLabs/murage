// SPDX-License-Identifier: AGPL-3.0-or-later
// astra-boot2-r2 High: two edits submitted while the server is busy each exhausted their retries and both failure callbacks wrote ONE editDraft, so
// one edit's words were lost. Drafts are now one per message, one edit per message in flight, each answer keyed by its own sendId.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { beginEdit, createEditDraftStore, discardEdit, editChangesNothing, editFailed, editSent, stopSaving, typeEdit, type EditDrafts } from "./edit-drafts";
import { deliverEdit } from "../state/send-delivery";

describe("edit drafts", () => {
  it("a second submission on a message whose edit is saving is refused: the first one's words stay until it settles, and come back on failure", () => {
    let drafts: EditDrafts = {};
    drafts = beginEdit(drafts, "m1", "first words", "s1")!;
    expect(beginEdit(drafts, "m1", "second words", "s2")).toBeNull();
    expect(drafts.m1).toEqual({ text: "first words", sendId: "s1", saving: true });
    drafts = editFailed(drafts, "m1", "s1");                                   // retries exhausted
    expect(drafts.m1).toEqual({ text: "first words", sendId: "s1", saving: false });
    drafts = beginEdit(drafts, "m1", "second words", "s2")!;                   // now it may be sent again
    expect(drafts.m1.text).toBe("second words");
  });

  it("two overlapping edits on different messages that both fail keep BOTH texts (89ebcf225 kept only the second)", () => {
    let drafts: EditDrafts = {};
    drafts = beginEdit(drafts, "m1", "edit one", "s1")!;
    drafts = beginEdit(drafts, "m2", "edit two", "s2")!;
    drafts = editFailed(drafts, "m1", "s1");
    drafts = editFailed(drafts, "m2", "s2");
    expect(drafts.m1).toMatchObject({ text: "edit one", saving: false });
    expect(drafts.m2).toMatchObject({ text: "edit two", saving: false });
    drafts = editSent(beginEdit(drafts, "m2", "edit two", "s3")!, "m2", "s2"); // the same words resubmitted keep their sendId
    expect(drafts.m2).toBeUndefined();
    expect(drafts.m1.text).toBe("edit one");                                  // the other message's draft is untouched
  });

  it("an answer for a superseded submission is ignored", () => {
    let drafts: EditDrafts = {};
    drafts = editFailed(beginEdit(drafts, "m1", "old", "s1")!, "m1", "s1");
    drafts = beginEdit(drafts, "m1", "new", "s2")!;
    expect(editFailed(drafts, "m1", "s1")).toBe(drafts);
    expect(editSent(drafts, "m1", "s1")).toBe(drafts);
    expect(drafts.m1).toEqual({ text: "new", sendId: "s2", saving: true });
  });

  it("closing the editor drops a draft that is not saving, never one still in flight", () => {
    let drafts: EditDrafts = beginEdit({}, "m1", "words", "s1")!;
    expect(discardEdit(drafts, "m1")).toBe(drafts);
    drafts = editFailed(drafts, "m1", "s1");
    expect(discardEdit(drafts, "m1").m1).toBeUndefined();
  });

  // astra-boot2-r3 High 1: switching bots cleared every draft, so a failure that landed while the person was on another bot lost the words
  it("a failing edit on bot A while the person switches to bot B: the words survive, with the error, for when they come back", async () => {
    const store = createEditDraftStore();
    let viewing = "botA";
    const shown: string[] = [];
    const unsubscribe = store.subscribe(() => { shown.push(viewing); });
    const next = beginEdit(store.get("botA"), "m1", "fixed words", "s1")!;
    store.update("botA", () => next);
    let fail: ((error: unknown) => void) | undefined;
    const delivery = deliverEdit(() => new Promise((_resolve, reject) => { fail = reject; }), {
      sendId: "s1",
      onFailed: (error) => store.update("botA", (drafts) => editFailed(drafts, "m1", "s1", (error as Error).message)),
    }, { setTimer: () => () => {} });
    viewing = "botB";                                                          // the person switches bots while it saves
    expect(store.get("botB")).toEqual({});
    expect(store.get("botA").m1).toMatchObject({ text: "fixed words", saving: true });
    await Promise.resolve();
    fail!(Object.assign(new Error("The bot could not be reached"), { status: 500 }));
    await delivery;
    viewing = "botA";                                                          // back on bot A
    expect(store.get("botA").m1).toEqual({ text: "fixed words", sendId: "s1", saving: false, error: "The bot could not be reached" });
    expect(Object.keys(store.get("botA"))[0]).toBe("m1");                     // ChatView reopens this editor on return
    expect(shown).toContain("botB");
    unsubscribe();
  });

  // astra-boot2-r3 High 2: an unanswered edit stayed "Saving…" for ever, and reopening refused to resubmit
  it("no answer: at the deadline the draft is editable again with its words and the SAME sendId, and resubmitting the same words reuses it", async () => {
    const store = createEditDraftStore();
    store.update("botA", (drafts) => beginEdit(drafts, "m1", "my edit", "s1")!);
    let fire: (() => void) | undefined;
    const delivery = deliverEdit(() => new Promise(() => {}), {
      sendId: "s1",
      onFailed: (error) => store.update("botA", (drafts) => editFailed(drafts, "m1", "s1", (error as Error).message)),
    }, { setTimer: (fn) => { fire = fn; return () => {}; } });
    expect(store.get("botA").m1!.saving).toBe(true);
    fire!();                                                                   // the deadline passes
    await delivery;
    expect(store.get("botA").m1).toMatchObject({ text: "my edit", sendId: "s1", saving: false });
    expect(store.get("botA").m1!.error).toBeTruthy();
    const again = beginEdit(store.get("botA"), "m1", "my edit", "s2")!;      // reopening allows resubmitting, under the same sendId
    expect(again.m1).toEqual({ text: "my edit", sendId: "s1", saving: true });
    expect(beginEdit(store.get("botA"), "m1", "changed words", "s2")!.m1!.sendId).toBe("s2"); // new words are a new edit
  });

  it("Cancel while saving: editable again with its words and sendId (not dropped); a second Cancel closes it", () => {
    let drafts: EditDrafts = beginEdit({}, "m1", "words", "s1")!;
    drafts = stopSaving(drafts, "m1");
    expect(drafts.m1).toEqual({ text: "words", sendId: "s1", saving: false });
    expect(beginEdit(drafts, "m1", "words", "s9")!.m1).toEqual({ text: "words", sendId: "s1", saving: true });
    expect(discardEdit(drafts, "m1").m1).toBeUndefined();
    expect(stopSaving(drafts, "m1")).toBe(drafts);                            // nothing saving: unchanged
  });

  it("the store keeps each bot's drafts apart and returns a stable snapshot until they change", () => {
    const store = createEditDraftStore();
    const empty = store.get("botA");
    expect(store.get("botA")).toBe(empty);
    store.update("botA", (drafts) => beginEdit(drafts, "m1", "a", "s1")!);
    store.update("botB", (drafts) => beginEdit(drafts, "m1", "b", "s2")!);
    const a = store.get("botA");
    expect(store.get("botA")).toBe(a);
    expect(a.m1!.text).toBe("a");
    expect(store.get("botB").m1!.text).toBe("b");
  });
});

// Release finding 12-B1: words typed in an open editor lived only in the textarea, so a same-bot conversation switch (the view stays
// mounted, the editor does not) dropped them and the editor came back showing the original message; and Enter on those original words
// forked the conversation and reran the bot for nothing.
describe("typed edit words survive the editor", () => {
  it("keeps what was typed, with a fresh sendId for changed words, and leaves a saving draft alone", () => {
    let drafts: EditDrafts = {};
    drafts = typeEdit(drafts, "m1", "hel", "s1");
    expect(drafts.m1).toEqual({ text: "hel", sendId: "s1", saving: false });
    expect(typeEdit(drafts, "m1", "hel", "s2")).toBe(drafts);
    drafts = typeEdit(drafts, "m1", "hello", "s3");
    expect(drafts.m1).toEqual({ text: "hello", sendId: "s3", saving: false });
    const saving = beginEdit(drafts, "m1", "hello", "s4")!;
    expect(typeEdit(saving, "m1", "hello again", "s5")).toBe(saving);
  });
  it("a typed draft comes back when the editor remounts, and Cancel drops it", () => {
    const store = createEditDraftStore();
    store.update("bot", (drafts) => typeEdit(drafts, "m1", "half a thought", "s1"));
    expect(store.get("bot").m1?.text).toBe("half a thought");
    store.update("bot", (drafts) => discardEdit(drafts, "m1"));
    expect(store.get("bot").m1).toBeUndefined();
  });
  it("words equal to the message's own words change nothing", () => {
    expect(editChangesNothing("same", "same")).toBe(true);
    expect(editChangesNothing("same ", " same")).toBe(true);
    expect(editChangesNothing("same", "different")).toBe(false);
    expect(editChangesNothing(undefined, "different")).toBe(false);
  });
  it("the thread view keeps the words and closes an unchanged edit", () => {
    const source = readFileSync(new URL("../components/ChatView.tsx", import.meta.url), "utf8");
    expect(source).toContain("onChange={(e) => { setDraft(e.target.value); onDraft?.(e.target.value); }}");
    expect(source).toContain("typeEdit(drafts, messageId, text, newSendId())");
    expect(source).toContain("editChangesNothing(");
  });
});
