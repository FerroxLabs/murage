// The composer keeps the words until the server acknowledges the send.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const load = async () => { vi.resetModules(); return import("./drafts"); };

it("a draft is cleared only by an acknowledgement, and only if the person has not changed it since", async () => {
  vi.stubGlobal("localStorage", storage());
  const drafts = await load();
  const id = "bot:b1:t1";
  const revision = drafts.draftRevision(id);
  drafts.pinDraftSendId(id, "send-pinned-0000000001");
  // nothing acknowledged yet: the pinned id survives a second press, so it cannot run twice
  expect(drafts.restoredSendId(id)).toBe("send-pinned-0000000001");
  expect(drafts.clearAcknowledgedDraft(id, revision)).toBe(true);
  expect(drafts.restoredSendId(id)).toBeUndefined();
  // a newer edit is never cleared by an old acknowledgement
  drafts.markDraftEdited(id);
  expect(drafts.clearAcknowledgedDraft(id, revision)).toBe(false);
});

it("with no localStorage the pinned id still protects this page", async () => {
  vi.stubGlobal("localStorage", { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } });
  const drafts = await load();
  drafts.pinDraftSendId("d", "send-pinned-0000000002");
  expect(drafts.restoredSendId("d")).toBe("send-pinned-0000000002");
});

it("the composer no longer empties the box after dispatching: it waits for the acknowledgement", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "Composer.tsx"), "utf8");
  const send = source.slice(source.indexOf("const send = () => {"), source.indexOf("// native dictation"));
  // the old unconditional clear right after dispatch is gone
  expect(send).not.toMatch(/\n    setText\(""\);\n    setAttachments\(\[\]\);/);
  // it clears through the acknowledgement for both send paths
  expect(send).toContain("onSent: acknowledged");
  expect(send).toContain("onReceipt: acknowledged");
  expect(send).toContain("clearAcknowledgedDraft(draftId, sentDraft.revision)");
  // and a second press while one is out is refused
  expect(send).toContain("sendingRef.current");
});

it("r5: a draft is frozen while its send is out, and what arrives meanwhile joins the next draft", async () => {
  vi.stubGlobal("localStorage", storage());
  const drafts = await load();
  const id = "bot:b1:t-freeze";
  const file = (name: string) => ({ id: name, kind: "file" as const, name, path: `/tmp/${name}`, size: 1 });
  expect(drafts.isDraftFrozen(id)).toBe(false);
  const seen: boolean[] = [];
  const stop = drafts.subscribeDraftFrozen(() => seen.push(drafts.isDraftFrozen(id)));
  drafts.freezeDraft(id);
  expect(drafts.isDraftFrozen(id)).toBe(true);
  // an attachment arriving mid-send (an image added from elsewhere) does not touch the draft that was sent
  drafts.appendComposerDraftAttachments(id, [file("late.png")]);
  expect(drafts.draftRevision(id)).toBe(0);
  drafts.thawDraft(id);
  stop();
  expect(seen).toEqual([true, false]);
  expect(drafts.isDraftFrozen(id)).toBe(false);
  // released: the held attachment is now an ordinary edit of the next draft
  expect(drafts.draftRevision(id)).toBe(1);
  drafts.thawDraft(id); // idempotent
  expect(drafts.draftRevision(id)).toBe(1);
});

it("r5: the composer refuses every edit of the draft, text and attachments, between the press and the acknowledgement", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const composer = readFileSync(join(dir, "..", "components", "Composer.tsx"), "utf8");
  const edit = (name: string) => composer.slice(composer.indexOf(`const ${name} = useCallback(`), composer.indexOf(`const ${name} = useCallback(`) + 260);
  expect(edit("editText")).toContain("if (isDraftFrozen(draftId)) return;");
  expect(edit("editAttachments")).toContain("if (isDraftFrozen(draftId)) return;");
  const send = composer.slice(composer.indexOf("const send = () => {"), composer.indexOf("// native dictation"));
  // frozen from the press, thawed only after the draft is cleared (ack) or restored (failure)
  expect(send.indexOf("freezeDraft(draftId)")).toBeGreaterThan(send.indexOf("pinDraftSendId(draftId"));
  expect(send.indexOf("thawDraft(draftId)")).toBeGreaterThan(send.indexOf("clearAcknowledgedDraft("));
  expect(send.lastIndexOf("thawDraft(draftId)")).toBeGreaterThan(send.indexOf("restoreDraft(sentDraft)"));
  // the attach button, the goal chip and the attachment chips are read-only too
  expect(composer).toMatch(/onClick=\{\(\) => fileInput\.current\?\.click\(\)\}\s+disabled=\{sendPending\}/);
  expect(composer).toMatch(/aria-pressed=\{effectiveChannelMode === "goal"\}\s+disabled=\{sendPending\}/);
  expect(composer).toContain("frozen={sendPending}");
  const chips = readFileSync(join(dir, "..", "components", "ComposerAttachments.tsx"), "utf8");
  expect(chips).toContain("if (frozenRef.current) return;");
  expect(chips).toContain("disabled={locked}");
});
