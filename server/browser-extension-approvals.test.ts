// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { privateTestDirectorySync, writePrivateTestFile } from "./testing/private-test-dir.ts";
import { join } from "node:path";
import { BrowserExtensionApprovals, BROWSER_EXTENSION_APPROVAL_TOOL, CARD_LIFETIME_MS, type ApprovalBinding, type ContinuationInfo } from "./browser-extension-approvals.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import type { Message } from "./store.ts";
function fixture() {
  const messages = new Map<string, Message[]>(); let counter=0;
  const store = {
    bots:[{threadId:"thread",tasks:[{threadId:"task"}]}],groups:[{threadId:"group",tasks:[]}],
    messagesFor:(thread:string)=>messages.get(thread)??[],
    appendMessage:(thread:string,input:Partial<Message>)=>{const message={...input,id:String(++counter)} as Message;messages.set(thread,[...(messages.get(thread)??[]),message]);return message;},
    patchMessage:(thread:string,id:string,patch:Partial<Message>)=>{const message=messages.get(thread)?.find(m=>m.id===id);if(!message)return null;Object.assign(message,patch);return message;},
  };
  const onApproval=vi.fn(); const bus={store,broadcast:vi.fn(),onApproval} as unknown as ApprovalBus;
  const approvals=new BrowserExtensionApprovals(bus);
  const input={bot:{id:"bot",name:"Mira",color:"blue" as const},threadId:"thread",bindingId:"binding",generation:3,digest:"a".repeat(64),summary:"Send the reviewed message on example.com",waitMs:1000};
  const card=(thread="thread")=>store.messagesFor(thread).at(-1)!.card!;
  return {approvals,input,card,onApproval,store,bus};
}
afterEach(()=>vi.useRealTimers());
describe("browser extension approval lifecycle",()=>{
  it("allows once through an ordinary notified card",async()=>{const f=fixture();const result=f.approvals.request(f.input);expect(f.onApproval).toHaveBeenCalledTimes(1);expect(f.card()).toMatchObject({tool:BROWSER_EXTENSION_APPROVAL_TOOL,subtitle:f.input.summary,options:["Allow","Deny"]});const id=f.card().requestId!;expect(f.approvals.resolve("thread",id,"allow")).toBe(true);expect(await result).toBe(true);expect(f.card().answered).toBe("allow");expect(f.approvals.resolve("thread",id,"allow")).toBe(false);});
  it("0.1.63 regression: the free-text card stays exactly the text written, with no structured-input fields",async()=>{const f=fixture();const result=f.approvals.request(f.input);const c=f.card() as unknown as Record<string,unknown>;expect(c.subtitle).toBe(f.input.summary);expect(c).not.toHaveProperty("summary");expect(c).not.toHaveProperty("toolInput");f.approvals.resolve("thread",f.card().requestId!,"deny");await result;});
  it("denial never authorizes",async()=>{const f=fixture();const result=f.approvals.request(f.input);f.approvals.resolve("thread",f.card().requestId!,"deny");expect(await result).toBe(false);expect(f.card().answered).toBe("deny");});
  it("rejects cross-thread and unsupported answers",async()=>{const f=fixture();const result=f.approvals.request(f.input);const id=f.card().requestId!;expect(f.approvals.resolve("other",id,"allow")).toBe(false);expect(f.approvals.resolve("thread",id,"answer")).toBe(false);f.approvals.cancelThread("thread");expect(await result).toBe(false);});
  it("times out before proxy deadline and rejects late answers",async()=>{vi.useFakeTimers();const f=fixture();const result=f.approvals.request(f.input);const id=f.card().requestId!;await vi.advanceTimersByTimeAsync(1000);expect(await result).toBe(false);expect(f.card()).toMatchObject({answered:"unavailable",dismissed:true});expect(f.approvals.resolve("thread",id,"allow")).toBe(false);});
  it("binding revocation closes all its pending actions",async()=>{const f=fixture();const a=f.approvals.request(f.input),b=f.approvals.request({...f.input,digest:"b".repeat(64)});f.approvals.cancelBinding("binding");expect(await a).toBe(false);expect(await b).toBe(false);});
  it("one card cannot authorize multiple identical calls",async()=>{const f=fixture();const a=f.approvals.request(f.input),id=f.card().requestId!;const b=f.approvals.request(f.input),second=f.card().requestId!;expect(second).not.toBe(id);f.approvals.resolve("thread",id,"allow");expect(await a).toBe(true);expect(f.approvals.resolve("thread",id,"allow")).toBe(false);f.approvals.resolve("thread",second,"deny");expect(await b).toBe(false);});
  it("disconnect signal dismisses card and removes listener",async()=>{const f=fixture();const controller=new AbortController();const removed=vi.spyOn(controller.signal,"removeEventListener");const result=f.approvals.request({...f.input,signal:controller.signal});controller.abort();expect(await result).toBe(false);expect(removed).toHaveBeenCalled();expect(f.card().dismissed).toBe(true);});
  it("already disconnected request never opens a card",async()=>{const f=fixture();expect(await f.approvals.request({...f.input,signal:AbortSignal.abort()})).toBe(false);expect(f.store.messagesFor("thread")).toHaveLength(0);});
  it("startup dismisses stale cards without touching live ones or unrelated cards",async()=>{const f=fixture();f.store.appendMessage("task",{card:{title:"old",subtitle:"old action",options:["Allow"],tool:BROWSER_EXTENSION_APPROVAL_TOOL,requestId:"old"}});f.store.appendMessage("group",{card:{title:"unrelated",subtitle:"unrelated action",options:["Allow"],tool:"other",requestId:"other"}});const result=f.approvals.request(f.input);expect(f.approvals.dismissStale()).toBe(1);expect(f.card().answered).toBeUndefined();expect(f.card("task").dismissed).toBe(true);expect(f.card("group").answered).toBeUndefined();f.approvals.cancelThread("thread");expect(await result).toBe(false);});
  it("missing or already-settled card cannot deliver allowance",async()=>{const f=fixture();const result=f.approvals.request(f.input);const id=f.card().requestId!;f.card().dismissed=true;f.approvals.resolve("thread",id,"allow");expect(await result).toBe(false);});
  it("invalid context and excessive wait refuse without card",async()=>{const f=fixture();expect(await f.approvals.request({...f.input,generation:0})).toBe(false);expect(await f.approvals.request({...f.input,waitMs:600000})).toBe(false);expect(await f.approvals.request({...f.input,digest:"model prose"})).toBe(false);expect(f.store.messagesFor("thread")).toHaveLength(0);});
  it("notification failure does not change the decision",async()=>{const f=fixture();f.onApproval.mockImplementation(()=>{throw Error("offline")});const result=f.approvals.request(f.input);f.approvals.resolve("thread",f.card().requestId!,"deny");expect(await result).toBe(false);});
});

describe("Fable M3, M9, H4: human decision time, long text, push bodies",()=>{
  it("lets a card wait two minutes for a person (the ceiling is three), but not longer",async()=>{const f=fixture();const a=f.approvals.request({...f.input,waitMs:120000});expect(f.store.messagesFor("thread")).toHaveLength(1);f.approvals.resolve("thread",f.card().requestId!,"deny");await a;expect(await f.approvals.request({...f.input,waitMs:180001})).toBe(false);});
  it("accepts a reviewed 2,500 character body and stores it whole",async()=>{const f=fixture();const body="word ".repeat(500);const result=f.approvals.request({...f.input,summary:`fill\n${body}`});expect(f.card().subtitle).toContain(body.trim());f.approvals.resolve("thread",f.card().requestId!,"allow");expect(await result).toBe(true);});
  it("refuses a summary beyond what can be reviewed",async()=>{const f=fixture();expect(await f.approvals.request({...f.input,summary:"x".repeat(12001)})).toBe(false);});
  it("keeps what a push may say apart from what the card shows",async()=>{const f=fixture();void f.approvals.request({...f.input,summary:"fill: SECRET-BODY",pushSummary:"fill on example.com. Fields: title, body (2)"});expect(f.card().pushBody).toBe("fill on example.com. Fields: title, body (2)");expect(f.card().subtitle).toContain("SECRET-BODY");f.approvals.cancelBinding("binding");});
  it("says on the card that page text is the page's",()=>{const f=fixture();void f.approvals.request(f.input);expect(f.card().held).toMatch(/written by the website/i);f.approvals.cancelBinding("binding");});
});

// T22 / F9: durable cards. The decision time (a person answering in their own time) is separate from the execution time.
describe("T22 durable cards", () => {
  let dir: string, file: string;
  beforeEach(() => { const made = privateTestDirectorySync(join(tmpdir(), "approvals-durable-")); dir = made.root; file = join(made.directory, "approvals.json"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const binding = (over: Partial<ApprovalBinding> = {}): ApprovalBinding => ({ generation: 3, documentEpoch: "1:7:https://example.com", targetDigest: "1".repeat(64), submissionDigest: "2".repeat(64), payloadDigest: "3".repeat(64), actionDigest: "4".repeat(64), ...over });
  type Clock = { t: number };
  function durable(clock: Clock = { t: 1_000_000 }, extra: { valid?: () => boolean; started?: boolean } = {}) {
    const f = fixture();
    const continued: ContinuationInfo[] = [];
    let accept = extra.started ?? true;
    const make = (bus = f.bus) => new BrowserExtensionApprovals(bus, { file, now: () => clock.t, valid: () => (extra.valid ? extra.valid() : true), onContinue: info => { continued.push(info); return accept; } });
    const approvals = make();
    const ask = (over: Partial<ApprovalBinding> = {}, more: object = {}) => approvals.ask({ ...f.input, binding: binding(over), kind: "action", ...more });
    return { ...f, approvals, make, ask, continued, clock, refuse: () => { accept = false; }, take: () => { accept = true; } };
  }
  const query = (over: Partial<ApprovalBinding> = {}) => ({ bindingId: "binding", kind: "action" as const, binding: binding(over) });

  it("after the in-turn wait the call gets 'waiting', the card stays live and a record is saved privately", async () => {
    vi.useFakeTimers(); const f = durable();
    const result = f.ask();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe("waiting");
    expect(f.card()).toMatchObject({ tool: BROWSER_EXTENSION_APPROVAL_TOOL, options: ["Allow", "Deny"] });
    expect(f.card().answered).toBeUndefined(); expect(f.card().dismissed).toBeFalsy();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.version).toBe(1); expect(saved.records).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain("Send the reviewed message");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("a plain request keeps the old timeout: the card is dismissed and nothing is saved", async () => {
    vi.useFakeTimers(); const f = durable();
    const result = f.approvals.request(f.input); await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(false); expect(f.card()).toMatchObject({ answered: "unavailable", dismissed: true }); expect(existsSync(file)).toBe(false);
  });
  it("an answer inside the wait is allow or deny as before, with no record left", async () => {
    const f = durable(); const result = f.ask(); f.approvals.resolve("thread", f.card().requestId!, "allow");
    expect(await result).toBe("allow"); expect(f.approvals.consume(query())).toBe(false); expect(f.continued).toHaveLength(0);
  });
  it("Allow later starts one continuation, and the approval is consumed once by the first action that matches", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    const id = f.card().requestId!;
    expect(f.approvals.consume(query())).toBe(false); // not answered yet
    expect(f.approvals.resolve("thread", id, "allow")).toBe(true);
    expect(f.card().answered).toBe("allow");
    expect(f.continued).toEqual([expect.objectContaining({ decision: "allow", botId: "bot", threadId: "thread", bindingId: "binding", requestId: id })]);
    expect(f.approvals.resolve("thread", id, "allow")).toBe(false); // an answered card answers once
    expect(f.approvals.consume(query())).toBe(true);
    expect(f.approvals.consume(query())).toBe(false);
  });
  for (const field of ["generation", "documentEpoch", "targetDigest", "submissionDigest", "payloadDigest", "actionDigest"] as const) {
    it(`a different ${field} does not consume the approval, so the caller asks with a fresh card`, async () => {
      vi.useFakeTimers(); const f = durable(); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
      f.approvals.resolve("thread", f.card().requestId!, "allow");
      const other = field === "generation" ? 4 : field === "documentEpoch" ? "1:8:https://example.com" : "6".repeat(64);
      expect(f.approvals.consume(query({ [field]: other } as Partial<ApprovalBinding>))).toBe(false);
      expect(f.approvals.consume({ ...query(), bindingId: "other-binding" })).toBe(false);
      expect(f.approvals.consume({ ...query(), kind: "site" })).toBe(false);
      expect(f.approvals.consume(query())).toBe(true); // the exact action still can, once
    });
  }
  it("asking again for the same step while a card is waiting makes no second card", async () => {
    vi.useFakeTimers(); const f = durable(); const first = f.ask(); await vi.advanceTimersByTimeAsync(1000); await first;
    expect(await f.ask()).toBe("waiting"); expect(f.store.messagesFor("thread")).toHaveLength(1);
    expect(await (async () => { const next = f.ask({ payloadDigest: "5".repeat(64) }); await vi.advanceTimersByTimeAsync(1000); return next; })()).toBe("waiting");
    expect(f.store.messagesFor("thread")).toHaveLength(2);
  });
  it("Deny later tells the bot the owner declined, grants nothing and leaves no record", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    f.approvals.resolve("thread", f.card().requestId!, "deny");
    expect(f.card().answered).toBe("deny"); expect(f.continued).toEqual([expect.objectContaining({ decision: "deny" })]);
    expect(f.approvals.consume(query())).toBe(false);
    await f.approvals.drain(); // the continuation has started; the decline is told once and nothing is kept
    expect(JSON.parse(readFileSync(file, "utf8")).records).toHaveLength(0);
  });
  it("Stop, Never, Revoke and End task (cancelBinding) cancel every waiting card of that binding only", async () => {
    vi.useFakeTimers(); const f = durable();
    const a = f.ask(); await vi.advanceTimersByTimeAsync(1000); await a; const idA = f.card().requestId!;
    const b = f.approvals.ask({ ...f.input, bindingId: "binding-2", binding: binding(), kind: "action" }); await vi.advanceTimersByTimeAsync(1000); await b; const idB = f.card().requestId!;
    f.approvals.cancelBinding("binding");
    expect(f.store.messagesFor("thread").find(m => m.card?.requestId === idA)!.card).toMatchObject({ dismissed: true });
    expect(f.approvals.resolve("thread", idA, "allow")).toBe(false);
    expect(f.continued).toHaveLength(0);
    expect(f.approvals.resolve("thread", idB, "allow")).toBe(true);
  });
  it("cancelling also withdraws an approval that was answered but not yet used", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    f.approvals.resolve("thread", f.card().requestId!, "allow"); f.approvals.cancelBinding("binding");
    expect(f.approvals.consume(query())).toBe(false);
  });
  it("a card is answerable for 24 hours and no longer", async () => {
    vi.useFakeTimers(); const clock = { t: 5_000_000 }; const f = durable(clock); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    const id = f.card().requestId!;
    clock.t += CARD_LIFETIME_MS - 1; expect(CARD_LIFETIME_MS).toBe(24 * 3600_000);
    clock.t += 2;
    expect(f.approvals.resolve("thread", id, "allow")).toBe(false);
    expect(f.card()).toMatchObject({ answered: "unavailable", dismissed: true });
  });
  it("an approval that was never used also ends after 24 hours", async () => {
    vi.useFakeTimers(); const clock = { t: 5_000_000 }; const f = durable(clock); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    f.approvals.resolve("thread", f.card().requestId!, "allow"); clock.t += CARD_LIFETIME_MS + 1;
    expect(f.approvals.consume(query())).toBe(false);
  });
  it("RESTART within 24 hours keeps the card answerable; the binding is re-checked before anything runs", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    const id = f.card().requestId!;
    const again = f.make(); // a new service instance over the same data
    expect(again.dismissStale()).toBe(0);
    expect(f.card().dismissed).toBeFalsy();
    expect(again.resolve("thread", id, "allow")).toBe(true);
    expect(f.continued).toHaveLength(1);
    expect(again.consume(query())).toBe(true);
    expect(again.consume(query())).toBe(false);
  });
  it("RESTART: a card whose binding is gone or changed is dismissed on answer and runs nothing", async () => {
    vi.useFakeTimers(); let ok = true; const f = durable({ t: 1_000_000 }, { valid: () => ok }); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    const id = f.card().requestId!; ok = false; const again = f.make();
    expect(again.resolve("thread", id, "allow")).toBe(false);
    expect(f.card()).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(f.continued).toHaveLength(0); ok = true; expect(again.consume(query())).toBe(false);
  });
  it("RESTART with a pending approval: the old digest cannot approve, and the owner gets one fresh card that says why", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask({ submissionDigest: "a".repeat(64) }); await vi.advanceTimersByTimeAsync(1000); await result;
    const oldId = f.card().requestId!;
    const again = f.make(); // restart: this run keys its digests with a new secret, so the same step now reads differently
    const fresh = { submissionDigest: "b".repeat(64) };
    expect(again.resolve("thread", oldId, "allow")).toBe(true);
    expect(again.consume(query(fresh))).toBe(false);
    void again.ask({ ...f.input, binding: binding(fresh), kind: "action" });
    const card = f.card();
    expect(card.requestId).not.toBe(oldId);
    expect(card.subtitle).toMatch(/restarted/i);
    expect(card.subtitle).not.toMatch(/\u2014|\u2013|\bsafe|safety/i);
    expect(again.consume(query())).toBe(false);
    expect(again.consume(query(fresh))).toBe(false);
  });
  it("RESTART after 24 hours dismisses the card", async () => {
    vi.useFakeTimers(); const clock = { t: 1_000_000 }; const f = durable(clock); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    clock.t += CARD_LIFETIME_MS + 1; const again = f.make();
    expect(again.dismissStale()).toBe(1); expect(f.card().dismissed).toBe(true);
  });
  it("cards with no saved record are still dismissed at startup", async () => {
    const f = durable(); f.store.appendMessage("thread", { card: { title: "old", subtitle: "x", options: ["Allow", "Deny"], tool: BROWSER_EXTENSION_APPROVAL_TOOL, requestId: "no-record" } });
    expect(f.make().dismissStale()).toBe(1);
  });
  it("a damaged or unknown-version file fails closed: nothing is answerable and every card is dismissed", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    for (const content of ["{not json", JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [{ requestId: 5 }] }), "[]"]) {
      writePrivateTestFile(file, content);
      const again = f.make(); expect(() => again.dismissStale()).not.toThrow();
      expect(again.resolve("thread", f.card().requestId!, "allow")).toBe(false);
      expect(again.consume(query())).toBe(false);
    }
    expect(f.card().dismissed).toBe(true);
  });
  it("a record that says allowed but names a card that is not answered allow is not trusted", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    const saved = JSON.parse(readFileSync(file, "utf8")); saved.records[0].status = "allowed"; writePrivateTestFile(file, JSON.stringify(saved));
    expect(f.make().consume(query())).toBe(false);
  });
  it("a continuation that could not start (the bot is busy) is retried by drain, and never twice", async () => {
    vi.useFakeTimers(); const f = durable(); f.refuse(); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    f.approvals.resolve("thread", f.card().requestId!, "allow"); expect(f.continued).toHaveLength(1);
    await f.approvals.drain(); expect(f.continued).toHaveLength(2);
    f.take(); await f.approvals.drain(); expect(f.continued).toHaveLength(3);
    await f.approvals.drain(); await f.make().drain(); expect(f.continued).toHaveLength(3);
    expect(f.approvals.consume(query())).toBe(true);
  });
  it("sweep dismisses expired cards", async () => {
    vi.useFakeTimers(); const clock = { t: 1_000_000 }; const f = durable(clock); const result = f.ask(); await vi.advanceTimersByTimeAsync(1000); await result;
    expect(f.approvals.sweep()).toBe(0); clock.t += CARD_LIFETIME_MS + 1; expect(f.approvals.sweep()).toBe(1); expect(f.card().dismissed).toBe(true);
  });
  it("an abort during the in-turn wait cancels the card (no record); durable applies only to a wait that ran out", async () => {
    const f = durable(); const controller = new AbortController(); const result = f.ask({}, { signal: controller.signal }); controller.abort();
    expect(await result).toBe("cancelled"); expect(f.card().dismissed).toBe(true); expect(existsSync(file)).toBe(false);
  });
});

describe("C2b hasWaiting", () => {
  it("is true while a card of the binding is unanswered and false once it is answered or cancelled", async () => {
    const f = fixture(); const result = f.approvals.request(f.input);
    expect(f.approvals.hasWaiting("binding")).toBe(true); expect(f.approvals.hasWaiting("other")).toBe(false);
    f.approvals.resolve("thread", f.card().requestId!, "allow"); await result;
    expect(f.approvals.hasWaiting("binding")).toBe(false);
  });
});
