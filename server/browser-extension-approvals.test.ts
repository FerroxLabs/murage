// SPDX-License-Identifier: AGPL-3.0-or-later
import { serviceQueueFixture } from './testing/service-queue-fixture.ts';
import { RELEASE_SUPERSEDED } from './decision/release-guard.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from 'node:module';
import { answerApproval, lookupApproval, readApproval, readApprovalExecution } from './decision/index.ts';
import { isQuestionCard } from '../shared/questions.ts';
import { tmpdir } from "node:os";
import { privateTestDirectorySync, writePrivateTestFile } from "./testing/private-test-dir.ts";
import { join } from "node:path";
import { BrowserExtensionApprovals, BROWSER_EXTENSION_APPROVAL_TOOL, CARD_LIFETIME_MS, type ApprovalBinding, type ContinuationInfo } from "./browser-extension-approvals.ts";
import { producerBase } from "./narrow-denials.ts";
import { flushApprovalPresentation } from "./testing/channel-approval-fixture.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { BrowserTurnExecution } from "./browser-turn-execution.ts";
function fixture() {
  const messages = new Map<string, Message[]>(); let counter=0;
  const store = {
    bots:[{threadId:"thread",tasks:[{threadId:"task"}]}],groups:[{threadId:"group",tasks:[]}],
    messagesFor:(thread:string)=>messages.get(thread)??[],
    messageById:(thread:string,id:string)=>(messages.get(thread)??[]).find(m=>m.id===id),
    openRequestCardRows:(thread:string)=>(messages.get(thread)??[]).filter(m=>m.card?.requestId&&!m.card.answered&&!m.card.dismissed),
    appendMessage:(thread:string,input:Partial<Message>)=>{const message={...input,id:String(++counter)} as Message;messages.set(thread,[...(messages.get(thread)??[]),message]);return message;},
    patchMessage:(thread:string,id:string,patch:Partial<Message>)=>{const message=messages.get(thread)?.find(m=>m.id===id);if(!message)return null;Object.assign(message,patch);return message;},
    patchMessagePoint:(thread:string,id:string,patch:Partial<Message>)=>store.patchMessage(thread,id,patch),
  };
  const seedLegacyCard=store.appendMessage;
  const serviceFixture=serviceQueueFixture(store);
  const onApproval=vi.fn(); const bus={store,authorityFor:serviceFixture.authorityFor,broadcast:vi.fn(),onApproval} as unknown as ApprovalBus;
  const approvals=new BrowserExtensionApprovals(bus);
  serviceFixture.queue(approvals.approvalQueue());
  const input={bot:{id:"bot",name:"Mira",color:"blue" as const},threadId:"thread",bindingId:"binding",generation:3,digest:"a".repeat(64),summary:"Send the reviewed message on example.com",waitMs:1000};
  const card=(thread="thread")=>store.messagesFor(thread).at(-1)!.card!;
  let observedPresentations = 0;
  const presented = async (count = observedPresentations + 1) => {
    await vi.waitFor(() => { if(onApproval.mock.calls.length < count) throw new Error('service approval was not presented'); }, {interval:1,timeout:1000});
    observedPresentations = count;
  };
  return {approvals,input,card,onApproval,store,bus,presented,seedLegacyCard};
}
// Run the registered production answer branch, including its real receipt check.
// Authentication and unrelated card kinds are fixture seams; delivery is real.
function registeredAnswerRoute(store: ReturnType<typeof fixture>['store']) {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const cut = (name: string) => {
    const found = new RegExp(`^(?:async )?function ${name}\\b`, 'm').exec(source)!;
    return source.slice(found.index, source.indexOf('\n}\n', found.index) + 3);
  };
  const bindings = {
    store, lookupApproval, answerApproval, readApproval, readApprovalExecution, isQuestionCard, RELEASE_SUPERSEDED,
    APPROVE_ALL_THREAD: 'fixture-bulk', HIGHLEVEL_REQUEST_PREFIX: 'fixture-highlevel-',
    mayApprove: () => true, requestSurface: () => 'desktop', requestOrigin: () => 'owner',
    cardByRequest: (thread: string, id: string) => store.messagesFor(thread).find(message => message.card?.requestId === id),
    json: (res: any, status: number, body: unknown) => Object.assign(res, { status, body }),
    answerLimitCard: () => null, isEmailRequestId: () => false, isVenuePostRequestId: () => false,
    outsideFlights: new Set(), answeredWhere: { attempt() {}, forget() {} }, pushWarn() {},
    answerAsSendReply: async () => null, folderTrustBrowserGate: async () => null,
    questionReply: () => ({ kind: 'none' }), freshAuthRefusal: async () => null,
    publishAnswerAllowed: () => true,
  };
  const code = ['requestBehavior', 'answerRegisteredApproval', 'respondToCard'].map(cut).join('\n');
  return new Function(...Object.keys(bindings), stripTypeScriptTypes(code) + ';return respondToCard;')(...Object.values(bindings));
}

afterEach(()=>vi.useRealTimers());
describe("browser extension approval lifecycle",()=>{
  it("allows once through an ordinary notified card",async()=>{const f=fixture();const result=f.approvals.request(f.input);await f.presented();expect(f.onApproval).toHaveBeenCalledTimes(1);expect(f.card()).toMatchObject({tool:BROWSER_EXTENSION_APPROVAL_TOOL,subtitle:f.input.summary,options:["Allow","Deny"]});const id=f.card().requestId!;expect(f.approvals.resolve("thread",id,"allow")).toBe(true);expect(await result).toBe(true);expect(f.card().answered).toBe("allow");expect(f.approvals.resolve("thread",id,"allow")).toBe(false);});
  it("0.1.63 regression: the free-text card stays exactly the text written, with no structured-input fields",async()=>{const f=fixture();const result=f.approvals.request(f.input);await f.presented();const c=f.card() as unknown as Record<string,unknown>;expect(c.subtitle).toBe(f.input.summary);expect(c).not.toHaveProperty("summary");expect(c).not.toHaveProperty("toolInput");f.approvals.resolve("thread",f.card().requestId!,"deny");await result;});
  it("denial never authorizes",async()=>{const f=fixture();const result=f.approvals.request(f.input);await f.presented();f.approvals.resolve("thread",f.card().requestId!,"deny");expect(await result).toBe(false);expect(f.card().answered).toBe("deny");});
  it("rejects cross-thread and unsupported answers",async()=>{const f=fixture();const result=f.approvals.request(f.input);await f.presented();const id=f.card().requestId!;expect(f.approvals.resolve("other",id,"allow")).toBe(false);expect(f.approvals.resolve("thread",id,"answer")).toBe(false);f.approvals.cancelThread("thread");expect(await result).toBe(false);});
  it("times out before proxy deadline and rejects late answers",async()=>{vi.useFakeTimers();const f=fixture();const result=f.approvals.request(f.input);await f.presented();const id=f.card().requestId!;await vi.advanceTimersByTimeAsync(1000);expect(await result).toBe(false);expect(f.card()).toMatchObject({answered:"unavailable",dismissed:true});expect(f.approvals.resolve("thread",id,"allow")).toBe(false);});
  it("binding revocation closes all its pending actions",async()=>{const f=fixture();const a=f.approvals.request(f.input),b=f.approvals.request({...f.input,digest:"b".repeat(64)});await f.presented(2);f.approvals.cancelBinding("binding");expect(await a).toBe(false);expect(await b).toBe(false);});
  it("one card cannot authorize multiple identical calls",async()=>{const f=fixture();const a=f.approvals.request(f.input);await f.presented();const id=f.card().requestId!;const b=f.approvals.request(f.input);await f.presented(2);const second=f.card().requestId!;expect(second).not.toBe(id);f.approvals.resolve("thread",id,"allow");expect(await a).toBe(true);expect(f.approvals.resolve("thread",id,"allow")).toBe(false);f.approvals.resolve("thread",second,"deny");expect(await b).toBe(false);});
  it("disconnect signal dismisses card and removes listener",async()=>{const f=fixture();const controller=new AbortController();const removed=vi.spyOn(controller.signal,"removeEventListener");const result=f.approvals.request({...f.input,signal:controller.signal});await f.presented();controller.abort();expect(await result).toBe(false);expect(removed).toHaveBeenCalled();expect(f.card().dismissed).toBe(true);});
  it("already disconnected request never opens a card",async()=>{const f=fixture();expect(await f.approvals.request({...f.input,signal:AbortSignal.abort()})).toBe(false);expect(f.store.messagesFor("thread")).toHaveLength(0);});
  it("startup dismisses stale cards without touching live ones or unrelated cards",async()=>{const f=fixture();f.seedLegacyCard("task",{card:{title:"old",subtitle:"old action",options:["Allow"],tool:BROWSER_EXTENSION_APPROVAL_TOOL,requestId:"old"}});f.seedLegacyCard("group",{card:{title:"unrelated",subtitle:"unrelated action",options:["Allow"],tool:"other",requestId:"other"}});const result=f.approvals.request(f.input);await f.presented();expect(f.approvals.dismissStale()).toBe(1);expect(f.card().answered).toBeUndefined();expect(f.card("task").dismissed).toBe(true);expect(f.card("group").answered).toBeUndefined();f.approvals.cancelThread("thread");expect(await result).toBe(false);});
  it("missing or already-settled card cannot deliver allowance",async()=>{const f=fixture();const result=f.approvals.request(f.input);await f.presented();const id=f.card().requestId!;f.card().dismissed=true;f.approvals.resolve("thread",id,"allow");expect(await result).toBe(false);});
  it("invalid context and excessive wait refuse without card",async()=>{const f=fixture();expect(await f.approvals.request({...f.input,generation:0})).toBe(false);expect(await f.approvals.request({...f.input,waitMs:900001})).toBe(false);expect(await f.approvals.request({...f.input,digest:"model prose"})).toBe(false);expect(f.store.messagesFor("thread")).toHaveLength(0);});
  it("notification failure does not change the decision",async()=>{const f=fixture();f.onApproval.mockImplementation(()=>{throw Error("offline")});const result=f.approvals.request(f.input);await f.presented();f.approvals.resolve("thread",f.card().requestId!,"deny");expect(await result).toBe(false);});
});

describe("Fable M3, M9, H4: human decision time, long text, push bodies",()=>{
  it("lets a card wait fifteen minutes for a person (the same as every other approval card), but not longer",async()=>{const f=fixture();const a=f.approvals.request({...f.input,waitMs:900000});await f.presented();expect(f.store.messagesFor("thread")).toHaveLength(1);f.approvals.resolve("thread",f.card().requestId!,"deny");await a;expect(await f.approvals.request({...f.input,waitMs:900001})).toBe(false);});
  it("accepts a reviewed 2,500 character body and stores it whole",async()=>{const f=fixture();const body="word ".repeat(500);const result=f.approvals.request({...f.input,summary:`fill\n${body}`});await f.presented();expect(f.card().subtitle).toContain(body.trim());f.approvals.resolve("thread",f.card().requestId!,"allow");expect(await result).toBe(true);});
  it("refuses a summary beyond what can be reviewed",async()=>{const f=fixture();expect(await f.approvals.request({...f.input,summary:"x".repeat(12001)})).toBe(false);});
  it("keeps what a push may say apart from what the card shows",async()=>{const f=fixture();void f.approvals.request({...f.input,summary:"fill: SECRET-BODY",pushSummary:"fill on example.com. Fields: title, body (2)"});await f.presented();expect(f.card().pushBody).toBe("fill on example.com. Fields: title, body (2)");expect(f.card().subtitle).toContain("SECRET-BODY");f.approvals.cancelBinding("binding");});
  it("says on the card that page text is the page's",async()=>{const f=fixture();void f.approvals.request(f.input);await f.presented();expect(f.card().held).toMatch(/written by the website/i);f.approvals.cancelBinding("binding");});
});

// T22 / F9: durable cards. The decision time (a person answering in their own time) is separate from the execution time.
describe("T22 durable cards", () => {
  let dir: string, file: string;
  beforeEach(() => { const made = privateTestDirectorySync(join(tmpdir(), "approvals-durable-")); dir = made.root; file = join(made.directory, "approvals.json"); });
  afterEach(() => { removeTempDirSync(dir); });
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

  it("preserves a durable continuation when sibling ownership outlasts reacquisition", async () => {
    vi.useFakeTimers(); const f = durable();
    const runs = new IndependentThreadRuns<object>();
    const execution = new BrowserTurnExecution(runs);
    const a = runs.admit("bot", "thread", {}, ["browser:profile"]);
    const b = runs.admit("bot", "sibling", {});
    execution.register(a, ["browser:profile"], ["browser:profile"]);
    f.bus.onBrowserOwnerWait = (thread, id) => execution.approvalWaiting(thread, id);
    const call = execution.begin(a, "tools/call", "agent_browser_click");
    const result = call.within(() => f.ask()).catch(error => error);
    await f.presented();
    expect(runs.claim(b, ["browser:profile"])).toBe(true);
    await vi.advanceTimersByTimeAsync(6_001);
    expect(await result).toMatchObject({ code: "browser_resume_timeout" });
    call.finish(false);
    expect(f.card().answered).toBeUndefined();
    expect(f.card().dismissed).toBeFalsy();
    // It is still answerable after reloading the private durable record.
    const restored = f.make();
    expect(restored.resolve("thread", f.card().requestId!, "allow")).toBe(true);
    await restored.drain();
    expect(f.continued).toHaveLength(1);
    expect(restored.consume(query())).toBe(true);
    expect(restored.consume(query())).toBe(false);
    runs.release(b);
    expect(runs.owns(a, "browser:profile")).toBe(false);
  });

  it("after the in-turn wait the call gets 'waiting', the card stays live and a record is saved privately", async () => {
    vi.useFakeTimers(); const f = durable();
    const result = f.ask();await f.presented();
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
    const result = f.approvals.request(f.input);await f.presented(); await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(false); expect(f.card()).toMatchObject({ answered: "unavailable", dismissed: true }); expect(existsSync(file)).toBe(false);
  });
  it("an answer inside the wait is allow or deny as before, with no record left", async () => {
    const f = durable(); const result = f.ask();await f.presented(); f.approvals.resolve("thread", f.card().requestId!, "allow");
    expect(await result).toBe("allow"); expect(f.approvals.consume(query())).toBe(false); expect(f.continued).toHaveLength(0);
  });
  it.each(["allow", "deny"] as const)("an in-turn %s stays on its original call while browser ownership is being reacquired", async behavior => {
    const f = durable();
    let releaseOwner!: () => void;
    const owner = new Promise<void>(resolve => { releaseOwner = resolve; });
    let beginResume!: () => void;
    const resuming = new Promise<void>(resolve => { beginResume = resolve; });
    const resume = vi.fn(() => { beginResume(); return owner; });
    f.bus.onBrowserOwnerWait = () => resume;
    const result = f.ask();
    try {
      await f.presented();
      const requestId = f.card().requestId!;
      const registered = lookupApproval("thread", f.store.messagesFor("thread").at(-1)!.id)!;
      expect(f.approvals.resolve("thread", requestId, behavior)).toBe(true);
      await resuming;
      await f.approvals.drain();
      expect(readApprovalExecution(registered.ref)).toMatchObject({ delivery: "accepted", answer: { behavior } });
      expect(resume).toHaveBeenCalledOnce();
      expect(f.continued).toHaveLength(0);
      expect(f.approvals.consume(query())).toBe(false);
      releaseOwner();
      expect(await result).toBe(behavior);
      await f.approvals.drain();
      expect(f.continued).toHaveLength(0);
      expect(f.approvals.consume(query())).toBe(false);
      if (existsSync(file)) expect(JSON.parse(readFileSync(file, "utf8")).records).toHaveLength(0);
    } finally {
      releaseOwner();
      f.approvals.cancelBinding("binding");
      await result;
    }
  });
  it("normal registered UI Allow resumes a parked browser approval and consumes it once", async () => {
    vi.useFakeTimers(); const f = durable();
    const result = f.ask(); await f.presented();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe('waiting');
    const message = f.store.messagesFor('thread').at(-1)!;
    const registered = lookupApproval('thread', message.id)!;
    const response: any = {};
    await registeredAnswerRoute(f.store)({ req: { headers: {} }, url: new URL('http://fixture.invalid/respond'), res: response }, 'thread', { requestId: message.card!.requestId, behavior: 'allow' });
    expect(response).toMatchObject({ status: 200, body: { ok: true, outcome: 'allowed-once' } });
    await f.approvals.drain();
    expect(readApprovalExecution(registered.ref)).toMatchObject({ delivery: 'accepted', answer: { behavior: 'allow' } });
    expect(f.continued).toHaveLength(1);
    expect(f.approvals.consume(query())).toBe(true);
    expect(f.approvals.consume(query())).toBe(false);
  });

  it("Allow later starts one continuation, and the approval is consumed once by the first action that matches", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
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
      vi.useFakeTimers(); const f = durable(); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
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
  it("consumes canonical Allowed cards after dismissal and only after durable delivery acceptance", async () => {
    vi.useFakeTimers();const f=durable();const result=f.ask();await vi.advanceTimersByTimeAsync(1000);await result;
    expect(f.approvals.resolve("thread",f.card().requestId!,"allow")).toBe(true);
    const message=f.store.messagesFor("thread").at(-1)!;
    (f.store as any).patchMessagePoint("thread",message.id,{card:{...message.card,answered:"Allowed",dismissed:true}});
    expect(f.approvals.consume(query())).toBe(true);
    expect(f.approvals.consume(query())).toBe(false);
  });
  it("a continuation can consume its approval immediately because delivery has already committed", async () => {
    vi.useFakeTimers();const f=fixture();const consumed:boolean[]=[];
    const approvals=new BrowserExtensionApprovals(f.bus,{file,now:()=>1_000_000,onContinue:()=>{consumed.push(approvals.consume(query()));}});
    const result=approvals.ask({...f.input,binding:binding(),kind:"action"});await vi.advanceTimersByTimeAsync(1000);await result;
    expect(approvals.resolve("thread",f.card().requestId!,"allow")).toBe(true);
    expect(consumed).toEqual([true]);expect(approvals.consume(query())).toBe(false);
  });
  it("Deny later tells the bot the owner declined, grants nothing and leaves no record", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    f.approvals.resolve("thread", f.card().requestId!, "deny");
    expect(f.card().answered).toBe("deny"); expect(f.continued).toEqual([expect.objectContaining({ decision: "deny" })]);
    expect(f.approvals.consume(query())).toBe(false);
    await f.approvals.drain(); // the continuation has started; the decline is told once and nothing is kept
    expect(JSON.parse(readFileSync(file, "utf8")).records).toHaveLength(0);
  });
  it("Stop, Never, Revoke and End task (cancelBinding) cancel every waiting card of that binding only", async () => {
    vi.useFakeTimers(); const f = durable();
    const a = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await a; const idA = f.card().requestId!;
    const b = f.approvals.ask({ ...f.input, bindingId: "binding-2", binding: binding(), kind: "action" }); await vi.advanceTimersByTimeAsync(1000); await b; const idB = f.card().requestId!;
    f.approvals.cancelBinding("binding");
    expect(f.store.messagesFor("thread").find(m => m.card?.requestId === idA)!.card).toMatchObject({ dismissed: true });
    expect(f.approvals.resolve("thread", idA, "allow")).toBe(false);
    expect(f.continued).toHaveLength(0);
    expect(f.approvals.resolve("thread", idB, "allow")).toBe(true);
  });
  it("cancelling also withdraws an approval that was answered but not yet used", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    f.approvals.resolve("thread", f.card().requestId!, "allow"); f.approvals.cancelBinding("binding");
    expect(f.approvals.consume(query())).toBe(false);
  });
  it("a card is answerable for 24 hours and no longer", async () => {
    vi.useFakeTimers(); const clock = { t: 5_000_000 }; const f = durable(clock); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    const id = f.card().requestId!;
    clock.t += CARD_LIFETIME_MS - 1; expect(CARD_LIFETIME_MS).toBe(24 * 3600_000);
    clock.t += 2;
    expect(f.approvals.resolve("thread", id, "allow")).toBe(false);
    expect(f.card()).toMatchObject({ answered: "unavailable", dismissed: true });
  });
  it("the in-turn wait does not extend the card's 24 hours from presentation", async () => {
    vi.useFakeTimers();const clock={t:1_000_000},shownAt=clock.t,f=durable(clock);
    const result=f.ask();await flushApprovalPresentation();clock.t+=1000;
    await vi.advanceTimersByTimeAsync(1000);expect(await result).toBe("waiting");
    const saved=JSON.parse(readFileSync(file,"utf8")).records[0];
    expect(saved.createdAt).toBe(shownAt);expect(saved.expiresAt).toBe(shownAt+CARD_LIFETIME_MS);
    clock.t=shownAt+CARD_LIFETIME_MS+1;
    expect(f.approvals.resolve("thread",f.card().requestId!,"allow")).toBe(false);
    expect(f.card()).toMatchObject({answered:"unavailable",dismissed:true});
  });
  it("an approval that was never used also ends after 24 hours", async () => {
    vi.useFakeTimers(); const clock = { t: 5_000_000 }; const f = durable(clock); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    f.approvals.resolve("thread", f.card().requestId!, "allow"); clock.t += CARD_LIFETIME_MS + 1;
    expect(f.approvals.consume(query())).toBe(false);
  });
  it("a version-one approval created before kind was stamped remains answerable after upgrade", async () => {
    const f=fixture(),queue=f.approvals.approvalQueue(),requestId="browser-legacy-kind",at=1_000_000;
    const request=queue.open({authority:f.bus.authorityFor!("thread","bot"),ref:requestId,
      tool:BROWSER_EXTENSION_APPROVAL_TOOL,input:{binding:binding()},
      action:{requestId,tool:BROWSER_EXTENSION_APPROVAL_TOOL,options:["Allow","Deny"],binding:binding(),bindingId:"binding",generation:3},
      view:{title:"Previous version",subtitle:f.input.summary},base:producerBase(true)});
    const outcome=queue.executeNow(request,()=>true);expect(outcome.kind).toBe("card");
    if(outcome.kind!=="card")throw Error("legacy fixture needs an approval");
    queue.presentNow(request,outcome.ref);const row=readApproval(outcome.ref.approvalId)!;
    writePrivateTestFile(file,JSON.stringify({version:1,records:[{requestId,threadId:"thread",messageId:row.chatMessageId,botId:"bot",bindingId:"binding",kind:"action",binding:binding(),createdAt:at,expiresAt:at+CARD_LIFETIME_MS,status:"waiting"}]}));
    const restored=new BrowserExtensionApprovals(f.bus,{file,now:()=>at});
    expect(restored.resolve("thread",requestId,"allow")).toBe(true);
    expect(restored.consume(query())).toBe(true);expect(restored.consume(query())).toBe(false);
  });
  it("a restored legacy action without a kind cannot become a site approval", async () => {
    const f=fixture(),queue=f.approvals.approvalQueue(),requestId="browser-legacy-site",at=1_000_000;
    const request=queue.open({authority:f.bus.authorityFor!("thread","bot"),ref:requestId,
      tool:BROWSER_EXTENSION_APPROVAL_TOOL,input:{binding:binding()},
      action:{requestId,tool:BROWSER_EXTENSION_APPROVAL_TOOL,options:["Allow","Deny"],binding:binding(),bindingId:"binding",generation:3},
      view:{title:"Previous version",subtitle:f.input.summary},base:producerBase(true)});
    const outcome=queue.executeNow(request,()=>true);expect(outcome.kind).toBe("card");
    if(outcome.kind!=="card")throw Error("legacy fixture needs an approval");
    queue.presentNow(request,outcome.ref);const row=readApproval(outcome.ref.approvalId)!;
    writePrivateTestFile(file,JSON.stringify({version:1,records:[{requestId,threadId:"thread",messageId:row.chatMessageId,botId:"bot",bindingId:"binding",kind:"site",binding:binding(),createdAt:at,expiresAt:at+CARD_LIFETIME_MS,status:"waiting"}]}));
    const restored=new BrowserExtensionApprovals(f.bus,{file,now:()=>at});
    expect(restored.resolve("thread",requestId,"allow")).toBe(false);
    expect(restored.consume({...query(),kind:"site"})).toBe(false);
    expect(restored.consume(query())).toBe(false);
  });
  it("RESTART within 24 hours keeps the card answerable; the binding is re-checked before anything runs", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    const id = f.card().requestId!;
    const again = f.make(); // a new service instance over the same data
    expect(again.dismissStale()).toBe(0);
    expect(f.card().dismissed).toBeFalsy();
    expect(again.resolve("thread", id, "allow")).toBe(true);
    expect(f.continued).toHaveLength(1);
    expect(again.consume(query())).toBe(true);
    expect(again.consume(query())).toBe(false);
  });
  it("a canonical terminal allow receipt authorizes only its bound action once", async () => {
    vi.useFakeTimers(); const f = durable(); const waiting = f.ask();
    await f.presented(); await vi.advanceTimersByTimeAsync(1000); await waiting;
    const decision = await import("./decision/index.ts");
    const receipt = decision.readApproval(f.card().approvalId!)!;
    expect(decision.answerApprovalSync(receipt.ref, { behavior: "allow" }).state).toBe("accepted");
    // Exercise the canonical terminal view over a genuinely accepted durable receipt.
    Object.assign(f.card(), { answered: "Allowed", dismissed: true });
    expect(f.card()).toMatchObject({ answered: "Allowed", dismissed: true });
    const restarted = f.make();
    expect(restarted.consume(query({ payloadDigest: "9".repeat(64) }))).toBe(false);
    expect(restarted.consume(query())).toBe(true);
    expect(restarted.consume(query())).toBe(false);
  });
  it("an allowed terminal receipt must still name its durable approval", async () => {
    vi.useFakeTimers(); const f = durable(); const waiting = f.ask();
    await f.presented(); await vi.advanceTimersByTimeAsync(1000); await waiting;
    const decision = await import("./decision/index.ts");
    const receipt = decision.readApproval(f.card().approvalId!)!;
    expect(decision.answerApprovalSync(receipt.ref, { behavior: "allow" }).state).toBe("accepted");
    // The display projection does not replace the durable approval authority.
    Object.assign(f.card(), { answered: "Allowed", dismissed: true });
    expect(f.card()).toMatchObject({ answered: "Allowed", dismissed: true });
    f.card().approvalId = "missing-approval";
    expect(f.make().consume(query())).toBe(false);
  });
  it("RESTART: a card whose binding is gone or changed is dismissed on answer and runs nothing", async () => {
    vi.useFakeTimers(); let ok = true; const f = durable({ t: 1_000_000 }, { valid: () => ok }); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    const id = f.card().requestId!; ok = false; const again = f.make();
    expect(again.resolve("thread", id, "allow")).toBe(false);
    expect(f.card()).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(f.continued).toHaveLength(0); ok = true; expect(again.consume(query())).toBe(false);
  });
  it("RESTART with a pending approval: the old digest cannot approve, and the owner gets one fresh card that says why", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask({ submissionDigest: "a".repeat(64) });await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    const oldId = f.card().requestId!;
    const again = f.make(); // restart: this run keys its digests with a new secret, so the same step now reads differently
    const fresh = { submissionDigest: "b".repeat(64) };
    expect(again.resolve("thread", oldId, "allow")).toBe(true);
    expect(again.consume(query(fresh))).toBe(false);
    void again.ask({ ...f.input, binding: binding(fresh), kind: "action" });await f.presented();
    const card = f.card();
    expect(card.requestId).not.toBe(oldId);
    expect(card.subtitle).toMatch(/restarted/i);
    expect(card.subtitle).not.toMatch(/\u2014|\u2013|\bsafe|safety/i);
    expect(again.consume(query())).toBe(false);
    expect(again.consume(query(fresh))).toBe(false);
  });
  it("RESTART after 24 hours dismisses the card", async () => {
    vi.useFakeTimers(); const clock = { t: 1_000_000 }; const f = durable(clock); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    clock.t += CARD_LIFETIME_MS + 1; const again = f.make();
    expect(again.dismissStale()).toBe(1); expect(f.card().dismissed).toBe(true);
  });
  it("cards with no saved record are still dismissed at startup", async () => {
    const f = durable(); f.seedLegacyCard("thread", { card: { title: "old", subtitle: "x", options: ["Allow", "Deny"], tool: BROWSER_EXTENSION_APPROVAL_TOOL, requestId: "no-record" } });
    expect(f.make().dismissStale()).toBe(1);
  });
  it("a damaged or unknown-version file fails closed: nothing is answerable and every card is dismissed", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    for (const content of ["{not json", JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [{ requestId: 5 }] }), "[]"]) {
      writePrivateTestFile(file, content);
      const again = f.make(); expect(() => again.dismissStale()).not.toThrow();
      expect(again.resolve("thread", f.card().requestId!, "allow")).toBe(false);
      expect(again.consume(query())).toBe(false);
    }
    expect(f.card().dismissed).toBe(true);
  });
  it("a record that says allowed but names a card that is not answered allow is not trusted", async () => {
    vi.useFakeTimers(); const f = durable(); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    const saved = JSON.parse(readFileSync(file, "utf8")); saved.records[0].status = "allowed"; writePrivateTestFile(file, JSON.stringify(saved));
    expect(f.make().consume(query())).toBe(false);
  });
  it("a changed private binding cannot spend the registered approval on another action", async () => {
    vi.useFakeTimers();const f=durable();const result=f.ask();await f.presented();
    await vi.advanceTimersByTimeAsync(1000);expect(await result).toBe('waiting');
    expect(f.approvals.resolve('thread',f.card().requestId!,'allow')).toBe(true);
    const saved=JSON.parse(readFileSync(file,'utf8'));
    const changed='f'.repeat(64);saved.records[0].binding.payloadDigest=changed;
    writePrivateTestFile(file,JSON.stringify(saved));
    expect(f.make().consume(query({payloadDigest:changed}))).toBe(false);
  });
  it("a continuation that could not start (the bot is busy) is retried by drain, and never twice", async () => {
    vi.useFakeTimers(); const f = durable(); f.refuse(); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    f.approvals.resolve("thread", f.card().requestId!, "allow"); expect(f.continued).toHaveLength(1);
    await f.approvals.drain(); expect(f.continued).toHaveLength(2);
    f.take(); await f.approvals.drain(); expect(f.continued).toHaveLength(3);
    await f.approvals.drain(); await f.make().drain(); expect(f.continued).toHaveLength(3);
    expect(f.approvals.consume(query())).toBe(true);
  });
  it("sweep dismisses expired cards", async () => {
    vi.useFakeTimers(); const clock = { t: 1_000_000 }; const f = durable(clock); const result = f.ask();await f.presented(); await vi.advanceTimersByTimeAsync(1000); await result;
    expect(f.approvals.sweep()).toBe(0); clock.t += CARD_LIFETIME_MS + 1; expect(f.approvals.sweep()).toBe(1); expect(f.card().dismissed).toBe(true);
  });
  it("a busy continuation remains recoverable across a restart and is consumed once", async () => {
    vi.useFakeTimers();const f=durable();f.refuse();
    const result=f.ask();await vi.advanceTimersByTimeAsync(1000);await result;
    expect(f.approvals.resolve("thread",f.card().requestId!,"allow")).toBe(true);
    await f.approvals.drain();expect(f.continued).toHaveLength(2);
    const restored=f.make();f.take();await restored.drain();
    expect(f.continued).toHaveLength(3);expect(restored.consume(query())).toBe(true);
    expect(restored.consume(query())).toBe(false);await f.make().drain();expect(f.continued).toHaveLength(3);
  });
  it("an abort during the in-turn wait cancels the card (no record); durable applies only to a wait that ran out", async () => {
    const f = durable(); const controller = new AbortController(); const result = f.ask({}, { signal: controller.signal });await f.presented(); controller.abort();
    expect(await result).toBe("cancelled"); expect(f.card().dismissed).toBe(true); expect(existsSync(file)).toBe(false);
  });
});

describe("C2b hasWaiting", () => {
  it("is true while a card of the binding is unanswered and false once it is answered or cancelled", async () => {
    const f = fixture(); const result = f.approvals.request(f.input);await f.presented();
    expect(f.approvals.hasWaiting("binding")).toBe(true); expect(f.approvals.hasWaiting("other")).toBe(false);
    f.approvals.resolve("thread", f.card().requestId!, "allow"); await result;
    expect(f.approvals.hasWaiting("binding")).toBe(false);
  });
});


describe("browser ownership around extension approval waits", () => {
  it.each(["allow", "deny"])("preserves the %s decision while ownership is reacquired", async behavior => {
    const f = fixture(); let release!: () => void;
    const owned = new Promise<void>(resolve => { release = resolve; });
    const resume = vi.fn(() => owned);
    f.bus.onBrowserOwnerWait = vi.fn(() => resume);
    let completed = false;
    const result = f.approvals.ask(f.input).then(state => { completed = true; return state; });
    await f.presented();
    const id = f.card().requestId!;
    expect(f.bus.onBrowserOwnerWait).toHaveBeenCalledWith("thread", id);
    f.approvals.resolve("thread", id, behavior);
    await Promise.resolve();
    expect(f.card().answered).toBe(behavior);
    await vi.waitFor(()=>expect(resume).toHaveBeenCalledWith(false, undefined));
    expect(completed).toBe(false);
    release(); expect(await result).toBe(behavior);
  });
  it("dismisses the card if its execution was revoked before it could park", async () => {
    const f = fixture();
    f.bus.onBrowserOwnerWait = () => { throw Error("turn ended"); };
    expect(await f.approvals.ask(f.input)).toBe("cancelled");
    expect(f.card()).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(f.onApproval).not.toHaveBeenCalled();
  });
});
