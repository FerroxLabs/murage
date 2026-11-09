import { checkSession } from "@/lib/session-check";
import { Profiler, useMemo, useState } from "react";
import { StoreProvider, useStore } from "@/state/store";
import { CommandPalette } from "@/components/CommandPalette";
import { ChatFindBar } from "@/components/ChatFindBar";
import { SearchResults } from "@/components/SearchResults";
import { setDesktopSurfaceSecretForTest } from "@/lib/live-events";
setDesktopSurfaceSecretForTest("0123456789abcdef".repeat(4));
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { AllChatsPage, AllChatsView } from "@/components/AllChatsPage";
import { ConversationTaskPicker } from "@/components/TaskPicker";
import { AllChatsSections } from "@/components/AllChatsSections";
import { ChatPickerSearch } from "@/components/ChatPickerSearch";
import { ChatThreadMatches } from "@/components/ChatThreadMatches";
import { useChatResource } from "@/lib/chat-previews";
import { appendChatPage, NO_CHATS, type ChatPage } from "@/lib/all-chats";
import { chatsGenHello, chatsGenFrame, chatsGenUnproven, chatsGenSnapshot, type ChatsGen } from "@/lib/chats-gen";
const pending: Array<{ path: string; done: (body: any) => void; reject: (error: Error) => void }> = [];
const starts: Array<{path:string; at:number}> = [];
let stormLatency: number | null = null;
let stormBumps = 0, ordinaryFrames = 0;
const inFlight = new Map<string,number>(), maximum = new Map<string,number>();
const renders: Array<{known:ChatsGen|null;proven:boolean;text:string}> = [];
const request = (path: string): Promise<ChatPage> => new Promise((done, reject) => {
  starts.push({path, at:Date.now()});
  if (stormLatency !== null && path.startsWith("/api/chats?")) {
    const key=path.includes("threads=") ? "popup" : "all";
    const active=(inFlight.get(key) ?? 0)+1; inFlight.set(key,active); maximum.set(key,Math.max(maximum.get(key) ?? 0,active));
    const gen={...chatsGenSnapshot().known!};
    setTimeout(() => { inFlight.set(key,inFlight.get(key)!-1); done({gen,total:1,next:null,chats:[{threadId:"main0",title:"Storm chat",createdAt:1,snippet:`storm-${gen.rev}`,lastRole:"user"}]}); },stormLatency);
  } else pending.push({ path, done, reject });
});
const noop = () => {};
let mode = "list";
let heldMemory: ChatPage | null = null;
const countOnly = (page: ChatPage): ChatPage => ({total:page.total,chats:[],next:null});
function ArchiveResource() {
  const held = useChatResource<ChatPage>("/archive-resource", request, 0, countOnly);
  return <><output id="retained">{JSON.stringify(held.data)}</output><button id="archive-refresh" onClick={() => held.more("/archive-resource")}>Refresh</button></>;
}
function Paging() {
  const held = useChatResource<ChatPage>("/page", request);
  const [index, setIndex] = useState(0);
  return <><span id="page-index">{index}</span><button id="next-page" onClick={() => held.more("/page?before=next", undefined, () => setIndex(index + 1))}>Next</button><p>{held.eligible && held.data?.chats[0]?.snippet}</p></>;
}
function Storm({name}: {name:string}) {
  const held = useChatResource<ChatPage>("/storm/" + name, request);
  return <p>{held.eligible && held.data?.chats[0]?.snippet}</p>;
}
function RenderControl() {
  const { dispatch } = useStore();
  return <button id="unrelated-update" onClick={() => dispatch({ type: "error", message: "fixture unrelated update" })}>Update store</button>;
}
function Popup() {
  const tasks = [{threadId:"main0",title:"Storm chat",createdAt:1,snippet:"store backed secret"}];
  return <ConversationTaskPicker threadId="main0" tasks={tasks} busy={false} onNew={noop} onSwitch={noop} onRename={noop} onDelete={noop} initialOpen deleteScope={{botId:"bot"}} />;
}
function RealPair() {
  const [shown,setShown]=useState(false);
  return <><button id="mount-pair" onClick={()=>setShown(true)}>Mount pair</button>{shown && <Profiler id="pair" onRender={()=>renders.push({...chatsGenSnapshot(),text:document.body.textContent ?? ""})}><AllChatsPage /><Popup /></Profiler>}</>;
}
function FindError() {
  const { state } = useStore();
  return <span id="find-error">{state.error}</span>;
}
function ProviderChild() {
  const { state } = useStore();
  return <><span id="hydrated">{String(state.hydrated)}</span><SearchResults query="secret" onLanded={noop} /></>;
}
const streams: FakeEvents[] = [];
class FakeEvents {
  onopen: (()=>void) | null = null;
  onmessage: ((event:any)=>void) | null = null;
  onerror: (()=>void) | null = null;
  closed = false;
  constructor(public url:string) { streams.push(this); }
  close() { this.closed = true; }
  send(data:unknown) { this.onmessage?.({ data:JSON.stringify(data),lastEventId:"" }); }
}
const suppliedArchive = { total: 7, rows: [{threadId:"old",title:"Supplied archived title",createdAt:Date.now(),botId:"old",archived:true as const,snippet:"supplied secret"}] };
function App() {
  const held = useChatResource<ChatPage>(mode === "list" ? "/main" : null, request);
  heldMemory = held.data;
  const list = useMemo(() => held.data ? appendChatPage(NO_CHATS, held.data, true) : NO_CHATS, [held.data]);
  if (mode === "archive-resource") return <ArchiveResource />;
  if (mode.startsWith("archive-")) return <AllChatsSections rows={[]} now={Date.now()} waiting={() => 0} ownerName={() => "Archive owner"} avatar={() => null} time={() => ""} renderChat={(row,eligible) => <li key={row.threadId}>{row.title}{eligible && row.snippet}</li>} onOpenRow={noop} fetchPage={request} folded={mode.endsWith("folded") ? ["archived"] : []} archived={mode.includes("supplied") ? { ...suppliedArchive, ...(mode.includes("unversioned") ? {} : {gen:{epoch:"A",rev:0}}) } : undefined} />;
  if (mode === "real-pair") return <StoreProvider><RealPair /></StoreProvider>;
  if (mode === "palette") return <StoreProvider><CommandPalette request={{ token: 1, query: "secret", opener: null, openingSequence: 0 }} isCurrent={() => true} onClose={noop} /></StoreProvider>;
  if (mode === "find") return <StoreProvider><ChatFindBar threadId="main" onClose={noop} /><FindError /></StoreProvider>;
  if (mode === "sidebar") return <StoreProvider><SearchResults query="secret" onLanded={noop} /></StoreProvider>;
  if (mode === "popup") return <Popup />;
  if (mode === "all-page") return <StoreProvider><RenderControl /><AllChatsPage /></StoreProvider>;
  if (mode === "page") return <Paging />;
  if (mode === "storm") return <><Storm name="a" /><Storm name="b" /></>;
  if (mode === "provider") return <StoreProvider><ProviderChild /></StoreProvider>;
  if (mode === "picker") return <ChatPickerSearch query="secret" scope={{ botId: "bot" }} onOpen={noop} />;
  if (mode === "matches") return <ChatThreadMatches query="secret" threadId="main" filters={{}} onOpen={noop} />;
  return <AllChatsView bots={[]} groups={[]} filters={{}} onFilters={noop} query="" onQuery={noop}
    held={list} listGen={held.listGen}
    loading={held.data ? null : "first"} failed={null} hitRows={null} searchingMessages={false} hitsPartial={false} hitsFailed={null}
    onOpenRow={noop} onOpenHit={noop} onLoadMore={noop} onClose={noop} fetchPage={request} sectionsOpen={["archived:old", "bots:bot"]} />;
}
let root = createRoot(document.getElementById("root")!);
window.EventSource = FakeEvents as unknown as typeof EventSource;
window.fetch = (async (path: string) => {
  const url = String(path);
  if (url === "/session") return {ok:false,status:401};
  const body = url.includes("resource-ticket") ? {ticket:"fixture"} : url.includes("desktop-secret") ? {secret:["01234567","89abcdef"].join("").repeat(4)} : url === "/api/instances" ? {instances:[]} : url === "/api/config" ? {config:{}} : url === "/api/routines" ? {routines:[],runs:[]} : url === "/api/webhooks" ? {webhooks:[]} : undefined;
  const reply = body ?? await request(url);
  return { ok:true, status:200, json: () => Promise.resolve(reply) };
}) as unknown as typeof fetch;
const mount = () => flushSync(() => root.render(<App />));
(window as any).fixture = {
  startStorm: (latency:number) => {
    stormLatency=latency; starts.length=0;
    flushSync(() => (document.querySelector('#mount-pair') as HTMLButtonElement).click());
    const bumps=setInterval(() => {
      const gen={epoch:"A",rev:++stormBumps};
      flushSync(()=>chatsGenFrame(gen,false)); // immediate answer/heartbeat backstops
      if(stormBumps === 500) clearInterval(bumps);
    },4);
    const ordinary=setInterval(() => {
      ordinaryFrames++; flushSync(()=>chatsGenFrame({epoch:"A",rev:stormBumps},false));
      if(ordinaryFrames === 8) clearInterval(ordinary);
    },250);
  },
  stormResult: () => ({bumps:stormBumps,ordinaryFrames,starts,maximum:Object.fromEntries(maximum),renders}),
  pending: () => pending.map(row => row.path),
  starts: () => starts,
  reject: (index:number) => pending.splice(index,1)[0].reject(Error("fixture failure")),
  raw: (index:number,body:unknown) => pending.splice(index,1)[0].done(body),
  stream: (data:unknown) => flushSync(() => streams.at(-1)?.send(data)),
  streams: () => streams.map(stream => ({closed:stream.closed,url:stream.url})),
  answer: (index: number, gen: ChatsGen, text: string) => {
    const [entry] = pending.splice(index, 1);
    const archived = entry.path.includes("archived=1");
    entry.done(entry.path.includes("/api/search") ? { gen, hits: [{ threadId: "main", messageId: "m", at: 1, role: "user", kind: "text", snippet: text, matchStart: 0, matchLength: text.length, hits: 1, countComplete: false }] } : {
      gen, chats: [0,1].map(i => ({ threadId: `${archived ? "archived" : "main"}${i}`, title: `Chat ${i}`, createdAt: Date.now(), botId: archived ? "old" : "bot", archived, snippet: text, lastRole: "user" })), next: null, total: 60,
    });
  },
  hello: (gen: ChatsGen) => flushSync(() => chatsGenHello(gen)),
  frame: (gen: ChatsGen) => flushSync(() => chatsGenFrame(gen, false)),
  wake: () => flushSync(chatsGenUnproven),
  snapshot: chatsGenSnapshot,
  memory: () => heldMemory,
  signout: () => checkSession(),
  unmount: () => flushSync(() => root.unmount()),
  mount: (nextMode = "list") => { mode = nextMode; root = createRoot(document.getElementById("root")!); mount(); },
};
if (!location.search.includes("nohello")) chatsGenHello({ epoch: "A", rev: 0 }); mount();
