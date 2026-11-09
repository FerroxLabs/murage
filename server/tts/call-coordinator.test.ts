import { describe, expect, it } from "vitest";
import { CallSpeechCoordinator, type CallSpeechReady } from "./call-coordinator.ts";

function fixture() {
  const coordinator = new CallSpeechCoordinator((_session, botId) => ["bot", "member"].includes(botId));
  const connection = {};
  const ready: CallSpeechReady[] = [];
  coordinator.attach({ callId: "call", principal: "owner", threadId: "thread", targetId: "room" }, connection, (event) => { if (event.type === "call.speech.ready") ready.push(event); return true; });
  return { coordinator, connection, ready };
}
function answer(coordinator: CallSpeechCoordinator, generation = "turn", botId = "bot", text = "First sentence. Second sentence.") {
  coordinator.begin("thread", botId, generation);
  coordinator.append("thread", botId, generation, "delta", text);
  coordinator.item("thread", botId, generation, "item", text);
  coordinator.settle("thread", botId, generation, "message-" + generation, true);
}
describe("D24 authenticated call source coordinator", () => {
  it("requires a live connection and successful seal, then admits exactly one drain", () => {
    const { coordinator, ready } = fixture();
    coordinator.begin("thread", "bot", "turn");
    coordinator.append("thread", "bot", "turn", "delta", "password: hunter2");
    expect(ready).toEqual([]);
    coordinator.item("thread", "bot", "turn", "item", "password: hunter2");
    expect(ready).toEqual([]);
    coordinator.settle("thread", "bot", "turn", "message", true);
    expect(ready).toHaveLength(1);
    expect(coordinator.presentation("call", "owner", "thread", "message")).not.toMatch(/password|hunter2/);
    const job = coordinator.claim("call", "owner", "thread", ready[0].replyId);
    expect(() => coordinator.claim("call", "owner", "thread", ready[0].replyId)).toThrow();
    expect([...job.utterances].join(" ")).not.toContain("hunter2");
    expect(job.signal.aborted).toBe(false);
    expect(() => coordinator.claim("call", "owner", "thread", ready[0].replyId)).toThrow();
  });
  it("rejects cross-principal, cross-thread and forged reply identities", () => {
    const { coordinator, ready } = fixture();
    answer(coordinator);
    expect(() => coordinator.claim("call", "other", "thread", ready[0].replyId)).toThrow();
    expect(() => coordinator.claim("call", "owner", "elsewhere", ready[0].replyId)).toThrow();
    expect(() => coordinator.claim("call", "owner", "thread", "forged")).toThrow();
    expect([...coordinator.claim("call", "owner", "thread", ready[0].replyId).utterances]).toHaveLength(2);
  });
  it("Stop during intake or drain rejects late completion and cannot recreate the generation", () => {
    const { coordinator, ready } = fixture();
    coordinator.begin("thread", "bot", "old");
    coordinator.append("thread", "bot", "old", "delta", "Incomplete.");
    coordinator.invalidate("thread", "old");
    answer(coordinator, "old");
    expect(ready).toEqual([]);
    answer(coordinator, "next");
    const job = coordinator.claim("call", "owner", "thread", ready[0].replyId);
    expect(job.utterances.next().value).toBe("First sentence.");
    coordinator.invalidate("thread");
    expect(job.signal.aborted).toBe(true);
    expect(() => job.utterances.next()).toThrow();
  });
  it("connection replacement, stale cleanup and restart cannot resurrect source", () => {
    const { coordinator, connection, ready } = fixture();
    answer(coordinator);
    const oldId = ready[0].replyId;
    const next = {};
    coordinator.attach({ callId: "call", principal: "owner", threadId: "thread", targetId: "room" }, next, (event) => { if (event.type === "call.speech.ready") ready.push(event); return true; });
    coordinator.detach("call", connection);
    expect(() => coordinator.claim("call", "owner", "thread", oldId)).toThrow();
    answer(coordinator);
    expect(ready).toHaveLength(1);
    answer(coordinator, "new");
    expect([...coordinator.claim("call", "owner", "thread", ready[1].replyId).utterances]).toHaveLength(2);
    expect(() => fixture().coordinator.claim("call", "owner", "thread", ready[1].replyId)).toThrow();
    coordinator.detach("call", next);
    expect(() => coordinator.presentation("call", "owner", "thread", "message-new")).toThrow();
  });
  it("late provider events cannot acquire the current generation", () => {
    const { coordinator } = fixture();
    coordinator.begin("thread", "bot", "old");
    coordinator.bind("thread", "bot", "old", "provider-old");
    expect(coordinator.provider("thread", "provider-old")?.generationId).toBe("old");
    coordinator.invalidate("thread");
    coordinator.begin("thread", "bot", "new");
    coordinator.bind("thread", "bot", "new", "provider-new");
    expect(coordinator.provider("thread", "provider-old")).toBeUndefined();
    expect(coordinator.provider("thread", undefined)).toBeUndefined();
    expect(coordinator.provider("other", "provider-new")).toBeUndefined();
    expect(coordinator.provider("thread", "provider-new")?.generationId).toBe("new");
  });
  it("member replies remain separate and duplicate chunks cannot add source", () => {
    const { coordinator, ready } = fixture();
    coordinator.begin("thread", "bot", "a");
    coordinator.append("thread", "bot", "a", "delta", "Safe. password: hunter2");
    coordinator.append("thread", "bot", "a", "delta", "untrusted duplicate");
    coordinator.item("thread", "bot", "a", "item", "Safe. password: hunter2");
    answer(coordinator, "b", "member", "An independent answer.");
    coordinator.settle("thread", "bot", "a", "message-a", true);
    expect([...coordinator.claim("call", "owner", "thread", ready[0].replyId).utterances].join(" ")).toBe("An independent answer.");
    expect([...coordinator.claim("call", "owner", "thread", ready[1].replyId).utterances].join(" ")).not.toMatch(/hunter2|untrusted duplicate/);
  });
  it("failed completion and failed control-event delivery release authority", () => {
    const { coordinator, ready } = fixture();
    coordinator.begin("thread", "bot", "failed");
    coordinator.item("thread", "bot", "failed", "item", "Never spoken.");
    coordinator.settle("thread", "bot", "failed", "message", false);
    expect(ready).toEqual([]);
    coordinator.attach({ callId: "call", principal: "owner", threadId: "thread", targetId: "room" }, {}, () => false);
    answer(coordinator);
    expect(() => coordinator.presentation("call", "owner", "thread", "message-turn")).toThrow();
  });
});

describe("D24 server presentation choice", () => {
  it("protects a successful host source and consumes its engine fallback exactly once", () => {
    const { coordinator, ready } = fixture(); answer(coordinator, "engine", "bot", "An engine answer.");
    const lease = coordinator.openPresentation("call", "owner", "thread", "bot", ready[0].replyId);
    expect(() => coordinator.claim("call", "owner", "thread", ready[0].replyId)).toThrow();
    lease.source("A safe prefix. password: correct horse."); lease.source("battery staple.");
    const selected = lease.finish(true, true)!;
    expect(lease.finish(false, false)).toBeUndefined();
    expect(() => lease.source("late callback")).toThrow();
    expect([...coordinator.claim("call", "owner", "thread", selected.replyId).utterances].join(" ")).not.toMatch(/correct horse|battery staple/);
    expect(() => coordinator.claim("call", "owner", "thread", ready[0].replyId)).toThrow();
  });
  it("selects a bounded protected fallback only once and never reconstructs a closed source", () => {
    const { coordinator, ready } = fixture();
    answer(coordinator, "engine", "bot", "- password: correct horse\n\nbattery staple " + "padding ".repeat(100));
    const lease = coordinator.openPresentation("call", "owner", "thread", "bot", ready[0].replyId);
    expect(lease.answer).not.toMatch(/password|correct horse|battery staple/);
    const selected = lease.finish(false, false)!;
    expect(lease.finish(true, true)).toBeUndefined();
    expect(() => coordinator.openPresentation("call", "owner", "thread", "bot", selected.replyId)).toThrow();
    const spoken = [...coordinator.claim("call", "owner", "thread", selected.replyId).utterances].join(" ");
    expect(spoken.length).toBeLessThanOrEqual(450);
    expect(spoken).not.toMatch(/correct horse|battery staple/);
    // red-at-head: password fallback retains a redacted prefix at HEAD.
    expect(spoken).toBe("The rest is on screen.");
  });
  it("Stop invalidates the pending host under its engine generation and forbids fallback", () => {
    const { coordinator, ready } = fixture(); answer(coordinator, "engine");
    const lease = coordinator.openPresentation("call", "owner", "thread", "bot", ready[0].replyId);
    lease.source("Partial output."); coordinator.invalidate("thread", "engine");
    expect(lease.signal.aborted).toBe(true);
    expect(lease.finish(false, false)).toBeUndefined();
    expect(() => coordinator.claim("call", "owner", "thread", ready[0].replyId)).toThrow();
  });
  it("a replacement ordinary host cancels A without letting its late cleanup delete B", () => {
    const { coordinator } = fixture();
    const a = coordinator.openPresentation("call", "owner", "thread", "bot"); a.source("Old output.");
    const b = coordinator.openPresentation("call", "owner", "thread", "bot"); b.source("New output.");
    expect(a.signal.aborted).toBe(true); a.cancel(); expect(a.finish(true, true)).toBeUndefined();
    const selected = b.finish(true, true)!;
    expect([...coordinator.claim("call", "owner", "thread", selected.replyId).utterances]).toEqual(["New output."]);
  });
});

it("fleet disposal closes sealed call source and pending host authority without releasing late output", () => {
  const { coordinator, ready } = fixture(); answer(coordinator, "engine");
  const host = coordinator.openPresentation("call", "owner", "thread", "bot", ready[0].replyId); host.source("Pending reply.");
  coordinator.invalidateAll();
  expect(host.signal.aborted).toBe(true); expect(host.finish(false, false)).toBeUndefined();
  expect(() => coordinator.claim("call", "owner", "thread", ready[0].replyId)).toThrow();
});

describe("host history follows delivered audio", () => {
  const utterances = ["First", "Second", "Third"].map(word => `${word} ${"spoken words ".repeat(14).trim()}.`);
  it.each([
    { ended: 2, cut: false, cutIn: false, delivered: 3, expected: utterances.slice(0, 2).join(" ") },
    { ended: 1, cut: false, cutIn: true, delivered: 3, expected: utterances[0] + " [the owner cut in here]" },
    { ended: 0, cut: false, cutIn: false, delivered: 3, expected: undefined },
    { ended: 1, cut: true, cutIn: false, delivered: 3, expected: utterances[0] + " " + utterances[1].replace(/[.!?]+$/, "") + "…" },
    { ended: 1000, cut: false, cutIn: false, delivered: 1, expected: utterances[0] },
    { ended: 1000, cut: true, cutIn: false, delivered: 0, expected: undefined },
  ])("reconciles $ended ended with $delivered delivered", ({ ended, cut, cutIn, delivered, expected }) => {
    const { coordinator } = fixture();
    const host = coordinator.openPresentation("call", "owner", "thread", "bot");
    host.source(utterances.join(" "));
    const selected = host.finish(true, true)!;
    const job = coordinator.claim("call", "owner", "thread", selected.replyId);
    expect([...job.utterances]).toEqual(utterances);
    utterances.slice(0, delivered).forEach(text => job.delivered(text));
    const other = coordinator.openPresentation("call", "owner", "thread", "member");
    other.source("Another bot's reply."); other.finish(true, true);
    const otherHistory = coordinator.openPresentation("call", "owner", "thread", "member").history;
    const before = coordinator.openPresentation("call", "owner", "thread", "bot").history;
    expect(before).toEqual([{ role: "owner", text: "" }]);
    coordinator.reportHeard("call", "owner", "thread", "forged", { ended, cut, cutIn });
    expect(coordinator.openPresentation("call", "owner", "thread", "bot").history).toEqual(before);
    expect(() => coordinator.reportHeard("call", "other", "thread", selected.replyId, { ended, cut, cutIn })).toThrow();
    coordinator.reportHeard("call", "owner", "thread", selected.replyId, { ended, cut, cutIn });
    const history = coordinator.openPresentation("call", "owner", "thread", "bot").history;
    expect(history.find(entry => entry.role === "host")?.text).toBe(expected);
    expect(history).toEqual([...before, ...(expected ? [{ role: "host", text: expected }] : [])]);
    expect(history.filter(entry => entry.role === "owner")).toEqual(before.filter(entry => entry.role === "owner"));
    expect(coordinator.openPresentation("call", "owner", "thread", "member").history).toEqual(otherHistory);
    coordinator.reportHeard("call", "owner", "thread", selected.replyId, { ended: 0, cut: false, cutIn: false });
    expect(coordinator.openPresentation("call", "owner", "thread", "bot").history).toEqual(history);
  });
});

it.each([0, 1])("reconciles engine fallback history and retains hand-down metadata with %s ended", ended => {
  const { coordinator, ready } = fixture();
  answer(coordinator);
  const fallback = coordinator.openPresentation("call", "owner", "thread", "bot", ready[0].replyId);
  const selected = fallback.finish(false, false)!;
  expect(coordinator.openPresentation("call", "owner", "thread", "bot").history).toEqual([{ role: "owner", text: "" }]);
  const job = coordinator.claim("call", "owner", "thread", selected.replyId);
  for (const utterance of job.utterances) job.delivered(utterance);
  coordinator.reportHeard("call", "owner", "thread", selected.replyId, { ended: 1, cut: false, cutIn: false });
  const next = coordinator.openPresentation("call", "owner", "thread", "bot");
  expect(next.history.find(entry => entry.role === "host")?.text).toBe("First sentence.");
  const id = next.handDown("Check the board.");
  next.source("I will check the board.");
  const reply = next.finish(true, true)!;
  const hostJob = coordinator.claim("call", "owner", "thread", reply.replyId);
  for (const utterance of hostJob.utterances) hostJob.delivered(utterance);
  expect(coordinator.openPresentation("call", "owner", "thread", "bot").history.at(-1)).toEqual({ role: "host", text: "", handDown: { id, request: "Check the board." } });
  coordinator.reportHeard("call", "owner", "thread", reply.replyId, { ended, cut: false, cutIn: false });
  expect(coordinator.openPresentation("call", "owner", "thread", "bot").history.at(-1)).toEqual({ role: "host", text: ended ? "I will check the board." : "", handDown: { id, request: "Check the board." } });
});

it("inserts a late heard reply after its owner between older and newer turns", () => {
  const { coordinator } = fixture();
  const spoken = ["First", "Second"].map(word => `${word} ${"spoken words ".repeat(14).trim()}.`);
  const older = coordinator.openPresentation("call", "owner", "thread", "bot");
  older.handDown("Older task."); older.finish(true, false);
  const prior = coordinator.openPresentation("call", "owner", "thread", "bot").history;
  const host = coordinator.openPresentation("call", "owner", "thread", "bot");
  host.source(spoken.join(" "));
  const reply = host.finish(true, true)!;
  const job = coordinator.claim("call", "owner", "thread", reply.replyId);
  for (const text of job.utterances) job.delivered(text);
  const newer = coordinator.openPresentation("call", "owner", "thread", "bot");
  newer.source("Newer reply."); newer.finish(true, true);
  const before = coordinator.openPresentation("call", "owner", "thread", "bot").history;
  expect(before).toEqual([...prior, { role: "owner", text: "" }, { role: "owner", text: "" }]);
  coordinator.reportHeard("call", "owner", "thread", reply.replyId, { ended: 1, cut: false, cutIn: false });
  expect(coordinator.openPresentation("call", "owner", "thread", "bot").history).toEqual([
    ...prior, before[2], { role: "host", text: spoken[0] }, before[3],
  ]);
});

it("a second report for the same reply changes nothing", () => {
  const { coordinator } = fixture();
  const spoken = ["First", "Second"].map(word => `${word} ${"spoken words ".repeat(14).trim()}.`);
  const host = coordinator.openPresentation("call", "owner", "thread", "bot");
  host.source(spoken.join(" "));
  const reply = host.finish(true, true)!;
  const job = coordinator.claim("call", "owner", "thread", reply.replyId);
  for (const text of job.utterances) job.delivered(text);
  coordinator.reportHeard("call", "owner", "thread", reply.replyId, { ended: 1, cut: false, cutIn: false });
  const first = coordinator.openPresentation("call", "owner", "thread", "bot").history;
  expect(first.find(entry => entry.role === "host")?.text).toBe(spoken[0]);
  coordinator.reportHeard("call", "owner", "thread", reply.replyId, { ended: 2, cut: false, cutIn: true });
  expect(coordinator.openPresentation("call", "owner", "thread", "bot").history).toEqual(first);
});

it.each([11, 12])("bounds late history inserts and ignores evicted owners after %s newer turns", newerTurns => {
  const { coordinator } = fixture();
  const host = coordinator.openPresentation("call", "owner", "thread", "bot");
  host.source("Old reply.");
  const reply = host.finish(true, true)!;
  const job = coordinator.claim("call", "owner", "thread", reply.replyId);
  for (const text of job.utterances) job.delivered(text);
  for (let i = 0; i < newerTurns; i++) {
    const newer = coordinator.openPresentation("call", "owner", "thread", "bot");
    newer.source("Newer reply."); newer.finish(true, true);
  }
  const before = coordinator.openPresentation("call", "owner", "thread", "bot").history;
  expect(before).toHaveLength(12);
  expect(before.every(entry => entry.role === "owner")).toBe(true);
  coordinator.reportHeard("call", "owner", "thread", reply.replyId, { ended: 1, cut: false, cutIn: false });
  expect(coordinator.openPresentation("call", "owner", "thread", "bot").history).toEqual(
    newerTurns === 11 ? [{ role: "host", text: "Old reply." }, ...before.slice(1)] : before,
  );
});
