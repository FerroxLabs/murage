// The composer keeps the words until the server acknowledges the send (U36: the draft record owns them).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
const load = async () => { vi.resetModules(); return import("./drafts"); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const build = (sendId: string, content: { text: string }) => ({ sendId, kind: "bot" as const, botId: "b1", threadId: "t1", text: content.text, at: 1, attempts: 0 });
const dir = dirname(fileURLToPath(import.meta.url));
const composer = readFileSync(join(dir, "..", "components", "Composer.tsx"), "utf8");
const send = composer.slice(composer.indexOf("const send = () => {"), composer.indexOf("// native dictation"));

it("a draft is cleared only by the acknowledgement of the send that owns it, and only if it still holds those words", async () => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); }, key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; } });
  const drafts = await load();
  const id = "bot:b1:t1";
  drafts.setComposerDraftText(id, "hello");
  await flush();
  const begun = await drafts.beginDraftSend(id, { text: "hello", att: [], mode: "chat" }, build);
  if (!begun.ok) throw new Error(begun.reason);
  // a failure keeps the words and the id, so a second press cannot run them twice
  await drafts.settleDraftSend(id, begun.sendId, begun.attemptId, "failed");
  expect(drafts.readComposerDraft(id).text).toBe("hello");
  const again = await drafts.beginDraftSend(id, { text: "hello", att: [], mode: "chat" }, build);
  expect(again.ok && again.sendId).toBe(begun.sendId);
  if (!again.ok) return;
  expect(await drafts.settleDraftSend(id, again.sendId, undefined, "acked")).toBe(true);
  expect(drafts.readComposerDraft(id).text).toBe("");
});

it("with no localStorage at all, a send still works for this page (records in memory)", async () => {
  vi.stubGlobal("localStorage", undefined);
  const drafts = await load();
  drafts.setComposerDraftText("d", "words");
  await flush();
  const begun = await drafts.beginDraftSend("d", { text: "words", att: [], mode: "chat" }, build);
  expect(begun.ok).toBe(true);
  expect(drafts.isDraftHeld("d")).toBe(true);
});

it("the composer never empties the box itself: it writes the journal first and waits for the acknowledgement", () => {
  expect(send).not.toMatch(/\n    setText\(""\);\n    setAttachments\(\[\]\);/);
  expect(send).not.toContain("restoreDraft(");
  // W1 before any dispatch, and a dispatch only for a press whose journal was written
  expect(send.indexOf("beginDraftSend(draftId")).toBeGreaterThan(-1);
  expect(send).toContain("if (!begun.ok) {");
  expect(send).toContain('setSendNotice({ kind: "not-saved" })');
  expect(send).toContain('setSendNotice({ kind: "earlier-arrived" })');
  expect(send).toContain('setSendNotice({ kind: "check-failed" })');
  expect(send).toContain("dispatchSend(begun.sendId, begun.attemptId, begun.content.reply)");
  // the UI settles through the record, keyed by (sendId, attemptId)
  expect(send).toContain("watchDraftSend(draftId, sendId, attemptId,");
  expect(send).toContain("sendingRef.current");
});

it("the composer refuses every edit of the draft, text and attachments, from the click until the send settles (A6: the press hold is the drafts module's, its held flag)", () => {
  const edit = (name: string) => composer.slice(composer.indexOf(`const ${name} = useCallback(`), composer.indexOf(`const ${name} = useCallback(`) + 260);
  expect(edit("editText")).toContain("if (isDraftHeld(draftId)) return;");
  expect(edit("editAttachments")).toContain("if (isDraftHeld(draftId)) return;");
  expect(composer).not.toContain("pressingRef");
  expect(composer).toContain("const sendPending = sendingId !== null || draftHeld;");
  // B1: a press refused as held or changed puts the focus back in the box
  expect(send).toContain('else if (begun.reason === "held" || begun.reason === "changed") refocusInput();');
  // the attach button, the goal chip, the reply strip and the attachment chips are read-only too
  expect(composer).toMatch(/onClick=\{\(\) => fileInput\.current\?\.click\(\)\}\s+disabled=\{sendPending\}/);
  expect(composer).toMatch(/aria-pressed=\{effectiveChannelMode === "goal"\}\s+disabled=\{sendPending\}/);
  expect(composer).toContain("onClear={() => { if (!sendPending) onClearReply?.(); }}");
  expect(composer).toContain("frozen={sendPending}");
  const chips = readFileSync(join(dir, "..", "components", "ComposerAttachments.tsx"), "utf8");
  expect(chips).toContain("if (frozenRef.current) return;");
  expect(chips).toContain("disabled={locked}");
});
