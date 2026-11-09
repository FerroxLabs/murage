import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ReplyState, type SpeechEvent } from "./reply-state.ts";
import { bindReplyStore } from "./reply-store.ts";
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); });
function fixture() {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const events: SpeechEvent[] = [];
  const state = new ReplyState({ db: database, transaction, emit: event => events.push(event) }); state.boot(); bindReplyStore(store, state);
  const bot = store.createBot(), thread = bot.threadId;
  const prompt = () => store.appendMessage(thread, { role: "user", kind: "text", text: "fixture prompt", origin: "desktop" });
  const begin = (id: string, promptId: string) => { state.begin(thread, bot.id, id, promptId); state.bind(id, `provider-${id}`); };
  const answer = (id: string) => store.appendMessage(thread, { role: "bot", kind: "text", text: "fixture answer", turnId: `provider-${id}` });
  return { store, state, events, bot, thread, prompt, begin, answer };
}
it("S-settle actual Store marks and settles atomically, never on metadata patch or duplicate completion", () => {
  const f = fixture(), prompt = f.prompt(); f.begin("g", prompt.id); const answer = f.answer("g");
  expect(answer.speechGenerationId).toBe("g"); f.events.length = 0;
  expect(() => transaction(() => { f.store.markTerminalAssistantMessage(f.thread, "provider-g"); throw Error("rollback"); })).toThrow("rollback");
  expect(f.events).toEqual([]); expect(database().prepare("SELECT count(*) n FROM speech_settlements").get()?.n).toBe(0);
  f.store.markTerminalAssistantMessage(f.thread, "provider-g");
  expect(f.events).toHaveLength(1); expect(f.events[0]).toMatchObject({ kind: "speech.ready", messageId: answer.id, generationId: "g" });
  f.store.patchMessage(f.thread, answer.id, { text: "metadata fixture" }); f.store.markTerminalAssistantMessage(f.thread, "provider-g");
  expect(f.events).toHaveLength(1);
});
it("S-late actual loaded and unloaded append paths preserve old attribution after a newer owner prompt", () => {
  const f = fixture(), p = f.prompt(); f.begin("old", p.id); f.prompt(); f.begin("new", "replacement");
  const unloaded = new Store(() => ({ instanceId: "fixture", model: "fixture" })); bindReplyStore(unloaded, f.state);
  const late = unloaded.appendMessage(f.thread, { role: "bot", kind: "text", text: "late", turnId: "provider-old" });
  expect(late.speechGenerationId).toBe("old");
  unloaded.markTerminalAssistantMessage(f.thread, "provider-old"); expect(f.events.filter(e => e.kind === "speech.ready")).toEqual([]);
  const current = f.answer("new"); f.store.markTerminalAssistantMessage(f.thread, "provider-new");
  expect(f.events.filter(e => e.kind === "speech.ready")).toMatchObject([{ messageId: current.id }]);
});
it("S-new acceptance and edits invalidate inside the insert transaction, with no revision change on rollback or redelivery", () => {
  const f = fixture(); const first = f.prompt(); const revision = f.state.revision(f.thread);
  expect(() => f.store.appendMessage(f.thread, { role: "user", kind: "text", text: "rollback", origin: "companion" }, "rollback", () => { throw Error("rollback"); })).toThrow("rollback");
  expect(f.state.revision(f.thread)).toBe(revision); expect(f.store.messageById(f.thread, "rollback")).toBeFalsy();
  f.store.appendMessage(f.thread, { role: "user", kind: "text", text: "retry", origin: "desktop" }, first.id);
  expect(f.state.revision(f.thread)).toBe(revision);
  f.store.branchMessage(f.thread, first.id, "edited", "companion"); expect(f.state.revision(f.thread)).toBe(revision + 1);
  const unloaded = new Store(() => ({ instanceId: "fixture", model: "fixture" })); bindReplyStore(unloaded, f.state);
  unloaded.branchMessage(f.thread, first.id, "edited again", "desktop"); expect(f.state.revision(f.thread)).toBe(revision + 2);
  unloaded.appendMessage(f.thread, { role: "user", kind: "text", text: "next", origin: "companion" }); expect(f.state.revision(f.thread)).toBe(revision + 3);
});
it("unknown, ambiguous and failed provider turns cannot become eligible on the actual terminal writer", () => {
  const f = fixture(); f.prompt(); f.answer("unknown"); f.store.markTerminalAssistantMessage(f.thread, "provider-unknown");
  f.begin("failed", "prompt"); f.answer("failed"); f.store.markTerminalAssistantMessage(f.thread, "provider-failed", "cancelled");
  f.store.markTerminalAssistantMessage(f.thread, "provider-failed");
  f.begin("a", "prompt"); f.state.begin(f.thread, f.bot.id, "b", "prompt"); f.state.bind("b", "provider-a");
  expect(f.answer("a").speechGenerationId).toBeUndefined(); f.store.markTerminalAssistantMessage(f.thread, "provider-a");
  expect(f.events.filter(e => e.kind === "speech.ready")).toEqual([]);
});
it("S-new queued prompt acceptance invalidates before dispatch and its later transcript append does not invalidate twice", async () => {
  const { SendStore } = await import("../send-store.ts");
  const f = fixture(), sends = new SendStore(database); bindReplyStore(f.store, f.state, sends);
  const input = { kind: "bot" as const, ownerId: f.bot.id, threadId: f.thread, sendId: "queued", fingerprint: "queued", text: "queued", origin: "companion", status: "queued" as const };
  const p = f.prompt(); f.begin("old", p.id); const revision = f.state.revision(f.thread);
  expect(() => sends.within(() => { sends.accept(input); throw Error("rollback"); })).toThrow("rollback");
  expect(f.state.revision(f.thread)).toBe(revision);
  sends.accept(input); expect(f.state.revision(f.thread)).toBe(revision + 1);
  f.answer("old"); f.store.markTerminalAssistantMessage(f.thread, "provider-old");
  expect(f.events.filter(e => e.kind === "speech.ready")).toEqual([]);
  sends.accept(input);
  f.store.appendMessage(f.thread, { role: "user", kind: "text", text: input.text, sendId: input.sendId, origin: "companion" });
  expect(f.state.revision(f.thread)).toBe(revision + 1);
});
it("an explicit accepted resend invalidates again while its transcript identity still deduplicates the append", async () => {
  const { SendStore } = await import("../send-store.ts");
  const f = fixture(), sends = new SendStore(database); bindReplyStore(f.store, f.state, sends);
  const input = { kind: "bot" as const, ownerId: f.bot.id, threadId: f.thread, sendId: "resend", fingerprint: "same-prompt", text: "same prompt", origin: "desktop", status: "queued" as const };
  const accepted = sends.accept(input); const firstRevision = f.state.revision(f.thread);
  f.store.appendMessage(f.thread, { role: "user", kind: "text", text: input.text, sendId: input.sendId, origin: "desktop" });
  expect(f.state.revision(f.thread)).toBe(firstRevision);
  sends.refuse(accepted.row.seq);
  expect(sends.accept({ ...input, resend: true, actionId: "explicit-retry" }).kind).toBe("new");
  expect(f.state.revision(f.thread)).toBe(firstRevision + 1);
  f.store.appendMessage(f.thread, { role: "user", kind: "text", text: input.text, sendId: input.sendId, origin: "desktop" });
  expect(f.state.revision(f.thread)).toBe(firstRevision + 1);
});
