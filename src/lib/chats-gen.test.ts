import { afterEach, expect, it, vi } from "vitest";
import { chatsGenAnswer, chatsGenFrame, chatsGenHello, chatsGenSession, chatsGenSnapshot, chatsGenUnproven, chatsEligible, compareGen, registerChatsGenReplacement } from "./chats-gen";
import { fetchChats, scheduleRefetch } from "./all-chats";
const A = { epoch: "A", rev: 3 }, B = { epoch: "B", rev: 0 };
afterEach(() => vi.useRealTimers());
it("T-H1-epoch: old-session answers cannot disturb a restored stream", async () => {
  chatsGenHello(A);
  let resolve!: (body: { gen: typeof A }) => void;
  const pending = fetchChats("/fixture", null, () => new Promise<{ gen: typeof A }>(done => { resolve = done; }));
  chatsGenHello(B); const session = chatsGenSession();
  resolve({ gen: A }); expect(await pending).toBeNull();
  expect(chatsGenSnapshot()).toEqual({ known: B, proven: true }); expect(chatsGenSession()).toBe(session);
  const replace = vi.fn(), dispose = registerChatsGenReplacement(replace);
  expect(chatsGenAnswer(A, session)).toBe("stale"); expect(replace).toHaveBeenCalledOnce();
  expect(chatsGenSnapshot()).toEqual({ known: B, proven: false });
  chatsGenFrame(A, true); expect(chatsGenSnapshot().known).toEqual(B);
  chatsGenFrame(A, false); expect(chatsGenSnapshot()).toEqual({ known: A, proven: false });
  chatsGenHello(B); expect(chatsGenSnapshot()).toEqual({ known: B, proven: true }); dispose();
});
it("H5-append-rule: a newer answer invalidates retained rows and cannot append", async () => {
  chatsGenHello(A);
  expect(await fetchChats("/fixture", A, async () => ({ gen: { ...A, rev: 4 } }))).toBeNull();
  expect(chatsEligible(A)).toBe(false); expect(chatsGenSnapshot().known?.rev).toBe(4);
  chatsGenUnproven(); const session = chatsGenSession();
  chatsGenAnswer({ ...A, rev: 4 }, session); expect(chatsGenSnapshot().proven).toBe(false);
  chatsGenUnproven(); expect(chatsGenSession()).toBeGreaterThan(session);
});
it.each([[A,A,"same"], [A,{...A,rev:4},"older"], [{...A,rev:4},A,"newer"], [A,B,"foreign"]] as const)("compareGen %j %j is %s", (a,b,order) => expect(compareGen(a,b)).toBe(order));
it("T-CONCURRENT: 500 invalidations have one flight and a 500ms start gap", async () => {
  vi.useFakeTimers(); const starts: number[] = []; let active = 0, peak = 0;
  const runner = scheduleRefetch(async () => { starts.push(Date.now()); active++; peak = Math.max(peak,active); await new Promise(done => setTimeout(done,1)); active--; });
  for (let i=0;i<500;i++) { runner.schedule(); await vi.advanceTimersByTimeAsync(4); }
  await vi.advanceTimersByTimeAsync(500);
  expect(starts.length).toBeLessThanOrEqual(5); expect(peak).toBe(1);
  for (let i=1;i<starts.length;i++) expect(starts[i]-starts[i-1]).toBeGreaterThanOrEqual(500);
  runner.schedule(); runner.dispose(); const count = starts.length; await vi.advanceTimersByTimeAsync(1000); expect(starts).toHaveLength(count);
});

import { readFileSync } from "node:fs";
it("H3-seven-fetchers includes archived storage, sidebar and the provider hydration bypass", () => {
  for (const file of ["AllChatsPage", "AllChatsSections", "ChatPickerSearch", "ChatThreadMatches", "SearchResults"]) {
    const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8");
    expect(source, file).toContain("useChatResource");
    expect(source, file).not.toMatch(/\bapi\s*\(/);
  }
  const previews = readFileSync(new URL("./chat-previews.ts", import.meta.url), "utf8");
  expect(previews).toContain("fetchChats<T>");
  const provider = readFileSync(new URL("../state/store.tsx", import.meta.url), "utf8");
  const start = provider.indexOf("onFrame: (frame, delivery) =>");
  expect(provider.indexOf('frame.kind === "chats.forgot"',start)).toBeLessThan(provider.indexOf("if (hydrated)",start));
  expect(provider).not.toContain("murage:chats-forgot");
  for (const file of ["chats-gen.ts", "chat-previews.ts", "all-chats.ts", "live-events.ts"]) expect(readFileSync(new URL(file, import.meta.url), "utf8")).not.toContain("/api/chats/gen");
});

it("RULE proof is never borrowed by list holders", () => {
  for (const file of ["../components/AllChatsSections.tsx", "../components/AllChatsPage.tsx", "../components/TaskPicker.tsx", "../components/CommandPalette.tsx", "../components/ChatFindBar.tsx", "../components/ChatThreadMatches.tsx", "../components/ChatPickerSearch.tsx", "../components/SearchResults.tsx", "chat-previews.ts", "all-chats.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source, file).not.toMatch(/(?:\?\?|\|\|)\s*(?:[\w$.]+\.known|[\w$.]+\.listGen|chatsGenSnapshot\(\)\.known|state\.chatsGen|listGen\b|known\b(?!\.))/);
  }
});

it("RULE path 12 no response can borrow proof, and path 7 replay cannot advance hydration proof", async()=>{
  chatsGenHello(A);
  expect(await fetchChats('/unversioned',null,async()=>({gen:undefined,hits:[{snippet:'secret'}]}))).toBeNull();
  chatsGenFrame({...A,rev:99},true);
  expect(chatsGenSnapshot().known).toEqual(A);
  chatsGenUnproven();
  expect(chatsEligible(A)).toBe(false);
  chatsGenHello(A);
  expect(chatsEligible(A)).toBe(true);
});

it("RULE paths 14 and 15 use versioned ordinary owner search without preview exclusions",()=>{
  for(const name of ['CommandPalette','ChatFindBar']) {
    const source=readFileSync(new URL(`../components/${name}.tsx`,import.meta.url),'utf8');
    expect(source).toContain('useChatResource<HitsPage>');
    expect(source).toContain('/api/search?q=');
    expect(source).not.toContain('view=chats');
    expect(source).not.toContain('excludeForgotten');
  }
});
