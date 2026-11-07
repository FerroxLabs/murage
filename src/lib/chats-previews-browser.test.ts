import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
let browser: Browser, server: ReturnType<typeof createServer>, url: string;
beforeAll(async () => {
  const bundle = await build({ entryPoints: ["src/lib/testing/chats-preview-fixture.tsx"], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"test"', "import.meta.env": "{}" }, loader: { ".css": "empty", ".svg": "dataurl", ".webp": "dataurl", ".png": "dataurl", ".jpg": "dataurl", ".woff2": "dataurl" } });
  const script = bundle.outputFiles[0].text;
  server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8"); res.end(req.url === "/app.js" ? script : '<div id="root"></div><script src="/app.js"></script>'); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
}, 120_000);
afterAll(async () => { await browser?.close(); await new Promise<void>(done => server?.close(() => done())); });
const A = { epoch: "A", rev: 0 }, next = { epoch: "A", rev: 1 }, restored = { epoch: "B", rev: 0 };
async function answer(page: Page, pattern: string, gen = A, text = "secret old text") {
  await page.waitForFunction(pattern => (window as any).fixture.pending().some((path: string) => path.includes(pattern)), pattern, { timeout: 5000 }).catch(async error => { console.error("Pending", await page.evaluate(() => (window as any).fixture?.pending()), "DOM", await page.locator("body").innerText()); throw error; });
  await page.evaluate(({pattern,gen,text}) => { const f=(window as any).fixture; f.answer(f.pending().findIndex((path: string) => path.includes(pattern)), gen, text); }, {pattern,gen,text});
}
it("ADDENDUM-1: blocked archived replacement stays hidden after main completes, restore, wake and late answers", async () => {
  const page = await browser.newPage(); page.on("pageerror", error => console.error(error)); await page.goto(url);
  await answer(page, "/main"); await answer(page, "archived=1");
  await page.locator('[data-chats-section="archived"] h3 button').click();
  await answer(page, "archived=1");
  await page.waitForFunction(() => document.body.textContent!.includes("secret old text"));
  await page.evaluate(gen => (window as any).fixture.frame(gen), next);
  expect(await page.locator("body").textContent()).not.toContain("secret old text");
  await answer(page, "/main", next, "fresh main");
  expect(await page.locator("body").textContent()).not.toContain("secret old text");
  // The archived request began in A. A restored hello supersedes its token.
  await page.waitForFunction(() => (window as any).fixture.pending().some((path: string) => path.includes("archived=1")));
  await page.evaluate(gen => (window as any).fixture.hello(gen), restored);
  await answer(page, "archived=1", next);
  expect(await page.locator("body").textContent()).not.toContain("secret old text");
  expect(await page.evaluate(() => (window as any).fixture.snapshot())).toEqual({known:restored,proven:true});
  await answer(page, "/main", restored, "restored main");
  await answer(page, "archived=1", restored, "fresh archive");
  await page.waitForFunction(() => document.body.textContent!.includes("fresh archive"));
  const count = await page.evaluate(() => (window as any).fixture.pending().length);
  await page.evaluate(() => (window as any).fixture.wake());
  expect(await page.locator("body").textContent()).not.toContain("fresh archive");
  await page.evaluate(gen => (window as any).fixture.hello(gen), restored);
  await page.waitForFunction(() => document.body.textContent!.includes("fresh archive"));
  expect(await page.evaluate(() => (window as any).fixture.pending().length)).toBe(count);
  await page.evaluate(gen => (window as any).fixture.frame(gen), {...restored,rev:1});
  await page.waitForFunction(() => (window as any).fixture.pending().some((path: string) => path.includes("archived=1")));
  await page.evaluate(() => (window as any).fixture.unmount());
  await answer(page, "archived=1", {...restored,rev:2});
  expect(await page.locator("body").textContent()).toBe("");
  expect(await page.evaluate(() => (window as any).fixture.snapshot().known.rev)).toBe(2);
  await page.close();
}, 30_000);
it.each(["picker", "matches"])("H4: mounted %s hit rows disappear synchronously while replacements are blocked", async mode => {
  const page = await browser.newPage(); page.on("pageerror", error => console.error(error)); await page.goto(url);
  await page.evaluate(mode => { const f=(window as any).fixture; f.unmount(); f.mount(mode); }, mode);
  await answer(page, "/api/search");
  await page.waitForFunction(() => document.body.textContent!.includes("secret old text"));
  await page.evaluate(gen => (window as any).fixture.frame(gen), next);
  expect(await page.locator("body").textContent()).not.toContain("secret old text");
  await answer(page, "/api/search", next, "fresh match");
  await page.waitForFunction(() => document.body.textContent!.includes("fresh match"));
  await page.evaluate(() => (window as any).fixture.wake());
  expect(await page.locator("body").textContent()).not.toContain("fresh match");
  await page.close();
}, 30_000);

it("R2: an initial response dropped while offline is retried after the next hello", async () => {
  const page = await browser.newPage(); await page.goto(url);
  await page.waitForFunction(() => (window as any).fixture.pending().includes("/main"));
  await page.evaluate(() => (window as any).fixture.wake());
  await answer(page,"/main",A);
  expect(await page.locator("body").textContent()).not.toContain("secret old text");
  await page.evaluate(gen=>(window as any).fixture.hello(gen),A);
  await answer(page,"/main",A,"fresh initial");
  await page.waitForFunction(()=>document.body.textContent!.includes("fresh initial"));
  await page.close();
});

it("pagination commits metadata only after an accepted successful answer", async () => {
  const page = await browser.newPage(); await page.goto(url);
  await page.evaluate(() => { const f=(window as any).fixture; f.unmount(); f.mount("page"); });
  await answer(page,"/page");
  await page.getByText("secret old text", {exact:true}).waitFor();
  await page.locator("#next-page").click();
  expect(await page.locator("#page-index").textContent()).toBe("0");
  await page.waitForFunction(() => (window as any).fixture.pending().includes("/page?before=next"));
  await page.evaluate(() => { const f=(window as any).fixture; f.reject(f.pending().indexOf("/page?before=next")); });
  expect(await page.locator("#page-index").textContent()).toBe("0");
  await page.locator("#next-page").click();
  await answer(page,"/page?before=next",A,"page two");
  await page.waitForFunction(() => document.querySelector("#page-index")?.textContent === "1");
  await page.locator("#next-page").click();
  await page.waitForFunction(() => (window as any).fixture.pending().includes("/page?before=next"));
  await page.evaluate(gen => (window as any).fixture.frame(gen),next);
  await answer(page,"/page?before=next",A,"stale page");
  expect(await page.locator("#page-index").textContent()).toBe("1");
  expect(await page.locator("body").textContent()).not.toContain("stale page");
  await page.close();
});

it.each([20,650])("two mounted views bound a storm with %s ms responses", async latency => {
  const page = await browser.newPage(); await page.goto(url);
  await page.evaluate(() => { const f=(window as any).fixture; f.unmount(); f.mount("storm"); });
  const result = await page.evaluate(async latency => {
    const f=(window as any).fixture;
    let rev=0, maximum=0;
    const answering=new Set<string>();
    const started=Date.now();
    const tick=setInterval(() => {
      f.frame({epoch:"A",rev:++rev});
      const paths=f.pending().filter((path:string)=>path.startsWith("/storm/"));
      maximum=Math.max(maximum, paths.filter((p:string)=>p.endsWith("a")).length, paths.filter((p:string)=>p.endsWith("b")).length);
      for(const path of paths) if(!answering.has(path)) {
        answering.add(path);
        setTimeout(()=>{const index=f.pending().indexOf(path); if(index>=0)f.answer(index,{epoch:"A",rev},"current storm"); answering.delete(path);},latency);
      }
    },25);
    await new Promise(done=>setTimeout(done,1700)); clearInterval(tick);
    const elapsed=Date.now()-started;
    await new Promise(done=>setTimeout(done,latency+550));
    for(const path of f.pending().filter((p:string)=>p.startsWith("/storm/"))) f.answer(f.pending().indexOf(path),{epoch:"A",rev},"final storm");
    return {maximum,elapsed,starts:f.starts().filter((row:any)=>row.path.startsWith("/storm/"))};
  },latency);
  expect(result.maximum).toBe(1);
  for(const name of ["a","b"]) {
    const starts=result.starts.filter((row:any)=>row.path.endsWith(name));
    expect(starts.length).toBeLessThanOrEqual(Math.ceil(result.elapsed/500)+2);
    for(let i=1;i<starts.length;i++) expect(starts[i].at-starts[i-1].at).toBeGreaterThanOrEqual(480);
  }
  await page.close();
});

it.each(["unmount","signout"])("mounted StoreProvider handles generation during blocked hydration, Sidebar hides immediately, Stop %s invalidates", async stop => {
  const page=await browser.newPage(); const errors:string[]=[]; page.on("pageerror", e=>errors.push(e.message)); await page.goto(url);
  await page.evaluate(() => {const f=(window as any).fixture; f.unmount(); f.mount("provider");});
  await page.waitForFunction(() => (window as any).fixture.streams().length > 0);
  await page.evaluate(gen=>(window as any).fixture.stream({kind:"hello",resumed:false,chatsGen:gen}),A);
  await page.waitForFunction(() => (window as any).fixture.pending().some((p:string)=>p.includes("view=sidebar")));
  await answer(page,"/api/search",A,"sidebar old secret");
  await page.waitForFunction(()=>document.body.textContent!.includes("sidebar old secret"));
  expect(await page.locator("#hydrated").textContent()).toBe("false");
  await page.evaluate(gen=>(window as any).fixture.stream({kind:"chats.forgot",gen}),next);
  expect(await page.locator("body").textContent()).not.toContain("sidebar old secret");
  expect(await page.getByRole("status").textContent()).toBe("Checking for changes…");
  expect(await page.evaluate(()=>(window as any).fixture.snapshot().known)).toEqual(next);
  await page.evaluate(()=>{const f=(window as any).fixture; f.raw(f.pending().findIndex((p:string)=>p.includes("view=sidebar")),{bots:[],groups:[]});});
  await page.waitForFunction(()=>document.querySelector("#hydrated")?.textContent==="true");
  await answer(page,"/api/search",next,"sidebar fresh");
  await page.waitForFunction(()=>document.body.textContent!.includes("sidebar fresh"));
  await page.evaluate(stop => (window as any).fixture[stop === "unmount" ? "unmount" : "signout"](),stop);
  expect(await page.evaluate(()=>(window as any).fixture.snapshot().proven)).toBe(false);
  expect(await page.evaluate(()=>(window as any).fixture.streams().at(-1).closed)).toBe(true);
  expect(errors).toEqual([]);
  await page.close();
});

it("mounted AllChatsPage keeps its current page after HTTP failure", async()=>{
  const page=await browser.newPage();await page.goto(url);
  await page.evaluate(()=>{const f=(window as any).fixture;f.unmount();f.mount("all-page");});
  await page.waitForFunction(()=>(window as any).fixture.streams().length>0);
  await page.evaluate(gen=>(window as any).fixture.stream({kind:"hello",resumed:true,chatsGen:gen}),A);
  const reply={gen:A,chats:[{threadId:"a",title:"first page",createdAt:1,snippet:"first snippet"}],total:3,next:"cursor"};
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.startsWith("/api/chats?")));
  await page.evaluate(async body=>{
    const f=(window as any).fixture;
    for(let i=0;i<60 && !document.body.textContent?.includes("first snippet");i++) {
      const index=f.pending().findIndex((p:string)=>p.startsWith("/api/chats?") && !p.includes("archived"));
      if(index>=0)f.raw(index,body);
      await new Promise(done=>setTimeout(done,50));
    }
  },reply);
  await page.getByRole("button",{name:"Show older chats (1 of 3 shown)",exact:true}).click();
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes("before=cursor")));
  await page.evaluate(()=>{const f=(window as any).fixture;f.reject(f.pending().findIndex((p:string)=>p.includes("before=cursor")));});
  await page.getByRole("button",{name:"Show older chats (1 of 3 shown)",exact:true}).waitFor();
  await page.getByRole("button",{name:"Show older chats (1 of 3 shown)",exact:true}).click();
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes("before=cursor")));
  await page.evaluate(body=>{const f=(window as any).fixture;f.raw(f.pending().findIndex((p:string)=>p.includes("before=cursor")),body);},{...reply,chats:[{threadId:"b",title:"second page",createdAt:2,snippet:"second snippet"}]});
  await page.getByRole("button",{name:"Show older chats (51 of 3 shown)",exact:true}).waitFor();
  await page.close();
});

async function mountRealPage(page: Page) {
  page.on("pageerror", e => console.error(e));
  await page.goto(url);
  await page.evaluate(() => { const f=(window as any).fixture; f.unmount(); f.mount("all-page"); });
  await page.waitForFunction(() => (window as any).fixture.streams().length > 0);
  await page.evaluate(gen => (window as any).fixture.stream({kind:"hello",resumed:true,chatsGen:gen}), A);
}
async function rawAnswer(page: Page, pattern: string, body: unknown) {
  await page.waitForFunction(p => (window as any).fixture.pending().some((s:string) => s.includes(p)), pattern, {timeout:5000});
  await page.evaluate(({pattern,body}) => { const f=(window as any).fixture; f.raw(f.pending().findIndex((s:string) => s.includes(pattern)), body); }, {pattern,body});
}
it("unrelated store and search loading updates preserve real page scroll and expanded matches", async () => {
  const page=await browser.newPage(); await mountRealPage(page);
  await page.getByRole("textbox", {name:"Search all chats"}).fill("secret");
  await rawAnswer(page,"q=secret",{gen:A,chats:[{threadId:"main",title:"Chat",createdAt:1}],total:1});
  await rawAnswer(page,"/api/search",{gen:A,hits:[{threadId:"main",messageId:"m",at:1,role:"user",kind:"text",snippet:"matched secret",hits:1,countComplete:false}],next:"hits-cursor"});
  const hit=page.locator('[data-chat-hit="main"]'); await hit.click();
  await page.evaluate(() => { const el=document.querySelector('.overflow-y-auto') as HTMLElement; el.style.height="80px"; el.style.overflowY="auto"; el.style.flex="none"; el.scrollTop=25; });
  expect(await page.locator('.overflow-y-auto').evaluate(el=>el.scrollTop)).toBe(25);
  await page.locator('#unrelated-update').click();
  expect(await hit.getAttribute('aria-expanded')).toBe('true');
  expect(await page.locator('.overflow-y-auto').evaluate(el=>el.scrollTop)).toBe(25);
  // Starting another search page changes the parent's search-loading state.
  await page.getByRole('button',{name:'More results',exact:true}).evaluate((el:HTMLElement)=>el.click());
  await page.getByRole('button',{name:'Loading matches…',exact:true}).waitFor();
  expect(await hit.getAttribute('aria-expanded')).toBe('true');
  expect(await page.locator('.overflow-y-auto').evaluate(el=>el.scrollTop)).toBe(25);
  await page.close();
});

it("same generation reconnect replaces a later page with page one metadata", async () => {
  const page=await browser.newPage(); await mountRealPage(page);
  const first={gen:A,chats:[{threadId:"a",title:"First",createdAt:1,snippet:"first fresh"}],total:3,next:"cursor"};
  // The initial request may precede the provider hello; answer it and its fenced retry.
  await rawAnswer(page,"/api/chats?limit=50",first);
  if (!await page.getByText("first fresh",{exact:true}).count()) await rawAnswer(page,"/api/chats?limit=50",first);
  await page.getByRole('button',{name:'Show older chats (1 of 3 shown)',exact:true}).click();
  await rawAnswer(page,"before=cursor",{...first,chats:[{threadId:"b",title:"Second",createdAt:2}],next:"cursor2"});
  expect(await page.getByRole('button',{name:'Show newer chats',exact:true}).count()).toBe(1);
  await page.getByRole('button',{name:'Show older chats (51 of 3 shown)',exact:true}).click();
  await page.waitForFunction(() => (window as any).fixture.pending().some((p:string)=>p.includes('before=cursor2')));
  await page.evaluate(gen=>(window as any).fixture.hello(gen),A);
  await rawAnswer(page,'before=cursor2',{...first,chats:[{threadId:"c",title:"Dropped",createdAt:3}]});
  await rawAnswer(page,'/api/chats?limit=50',first);
  await page.getByText('first fresh',{exact:true}).waitFor();
  expect(await page.getByRole('button',{name:'Show older chats (1 of 3 shown)',exact:true}).count()).toBe(1);
  expect(await page.getByRole('button',{name:'Show newer chats',exact:true}).count()).toBe(0);
  await page.close();
});

it.each(["archive-fetched-open","archive-fetched-folded","archive-supplied-open","archive-supplied-folded"])("%s drops rows on generation change and retains count through failed refetch and unfolding", async mode => {
  const page=await browser.newPage(); await page.goto(url);
  await page.evaluate(mode=>{const f=(window as any).fixture; f.unmount(); f.mount(mode);},mode);
  const supplied=mode.includes("supplied"), folded=mode.endsWith("folded");
  if (!supplied) await rawAnswer(page,"archived=1",{gen:A,chats:[{threadId:"old",title:"Fetched archived title",createdAt:Date.now(),botId:"old",archived:true,snippet:"archive secret"}],total:7,next:null});
  const section=page.locator('[data-chats-section="archived"]');
  await section.getByRole('button',{name:/Archived.*7/}).waitFor();
  if (!folded) expect(await section.textContent()).toContain('archived title');
  await page.evaluate(gen=>(window as any).fixture.frame(gen),next);
  expect(await section.textContent()).not.toContain('archived title');
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes('archived=1')),undefined,{timeout:3000});
  await page.evaluate(()=>{const f=(window as any).fixture; f.reject(f.pending().findIndex((p:string)=>p.includes('archived=1')));});
  expect(await section.count()).toBe(1);
  expect(await section.textContent()).toContain('7');
  expect(await section.textContent()).not.toContain('archived title');
  if (folded) {
    await section.locator('h3 button').click();
    expect(await section.count()).toBe(1);
  expect(await section.textContent()).toContain('7');
    await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes('archived=1')));
    await page.evaluate(()=>{const f=(window as any).fixture; f.reject(f.pending().findIndex((p:string)=>p.includes('archived=1')));});
    expect(await section.count()).toBe(1);
  expect(await section.textContent()).toContain('7');
    expect(await section.textContent()).not.toContain('archived title');
  }
  await page.evaluate(gen=>(window as any).fixture.hello(gen),next);
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes('archived=1')));
  await page.evaluate(gen=>(window as any).fixture.hello(gen),restored);
  await answer(page,'archived=1',next,'late archived secret');
  expect(await section.textContent()).not.toContain('late archived secret');
  expect(await page.evaluate(()=>(window as any).fixture.snapshot())).toEqual({known:restored,proven:true});
  expect(await section.textContent()).toContain('7');
  await rawAnswer(page,'archived=1',{gen:restored,total:7,chats:[{threadId:'returned',title:'Returned archive title',createdAt:Date.now(),archived:true}],next:null});
  await section.getByText('Returned archive title',{exact:true}).waitFor();
  await page.close();
});

it("archive resource catch retains only count after a generation change", async () => {
  const page=await browser.newPage(); await page.goto(url);
  await page.evaluate(()=>{const f=(window as any).fixture; f.unmount(); f.mount("archive-resource");});
  await rawAnswer(page,"/archive-resource",{gen:A,total:7,chats:[{threadId:"old",title:"old title",snippet:"old secret",createdAt:1}],next:"old cursor"});
  await page.waitForFunction(()=>document.querySelector('#retained')?.textContent?.includes('old secret'));
  await page.evaluate(gen => (window as any).fixture.frame(gen), next);
  await page.waitForFunction(()=>(window as any).fixture.pending().includes('/archive-resource'));
  await page.evaluate(()=>{const f=(window as any).fixture; f.reject(f.pending().indexOf('/archive-resource'));});
  await page.waitForFunction(()=>!document.querySelector('#retained')?.textContent?.includes('old secret'));
  expect(JSON.parse((await page.locator('#retained').textContent())!)).toEqual({total:7,chats:[],next:null});
  await page.close();
});

it.each([1,650])("real All chats and popup obey the 500 bump contract with %s ms answers", async latency => {
  const page=await browser.newPage(); await page.goto(url);
  await page.evaluate(()=>{const f=(window as any).fixture; f.unmount(); f.mount("real-pair");});
  await page.waitForFunction(()=>(window as any).fixture.streams().length>0);
  await page.evaluate(gen=>(window as any).fixture.stream({kind:"hello",resumed:true,chatsGen:gen}),A);
  await page.clock.install(); await page.clock.pauseAt(new Date());
  await page.evaluate(latency=>(window as any).fixture.startStorm(latency),latency);
  await page.clock.runFor(4000);
  const result=await page.evaluate(()=>(window as any).fixture.stormResult());
  console.info("mounted storm", latency, JSON.stringify({bumps:result.bumps,ordinaryFrames:result.ordinaryFrames,starts:result.starts,maximum:result.maximum,renders:result.renders.length}));
  expect(result.bumps).toBe(500);
  expect(result.ordinaryFrames).toBeLessThanOrEqual(9);
  expect(result.maximum).toEqual({all:1,popup:1});
  for (const popup of [false,true]) {
    const starts=result.starts.filter((r:any)=>r.path.startsWith('/api/chats?') && r.path.includes('threads=')===popup);
    expect(starts.length).toBeGreaterThan(1);
    expect(starts.length).toBeLessThanOrEqual(Math.ceil(2000/500)+1);
    for(let i=1;i<starts.length;i++) expect(starts[i].at-starts[i-1].at).toBeGreaterThanOrEqual(500);
  }
  expect(result.renders.length).toBeGreaterThan(500);
  for (const render of result.renders) for (const match of render.text.matchAll(/storm-(\d+)/g)) {
    expect(render.proven).toBe(true);
    expect(Number(match[1])).toBe(render.known.rev);
  }
  expect(await page.getByText('You: storm-500',{exact:true}).count()).toBe(2);
  expect(await page.locator('body').textContent()).not.toMatch(/storm-(?!500(?!\d))\d+/);
  await page.close();
});

it("popup shows localized preview readiness until a complete page arrives", async () => {
  const page=await browser.newPage(); await page.goto(url);
  await page.evaluate(()=>{const f=(window as any).fixture; f.unmount(); f.mount("popup");});
  const reply={gen:A,total:1,next:null,partial:true,chats:[{threadId:"main0",title:"Chat",createdAt:1,snippet:"ready preview"}]};
  await rawAnswer(page,"threads=main0",reply);
  await page.getByText("ready preview",{exact:true}).waitFor();
  expect(await page.getByRole('status').allTextContents()).toContain('Chat previews are still getting ready.');
  await page.evaluate(gen=>(window as any).fixture.frame(gen),next);
  await rawAnswer(page,"threads=main0",{...reply,gen:next,partial:false});
  await page.getByText("ready preview",{exact:true}).waitFor();
  expect(await page.getByRole('status').allTextContents()).not.toContain('Chat previews are still getting ready.');
  await page.close();
});

it.each(["archive-supplied-unversioned-open", "archive-supplied-old-open"])("RULE unproven supplied rows never borrow current proof: %s", async mode => {
  const page=await browser.newPage(); await page.goto(url);
  await page.evaluate(mode=>{const f=(window as any).fixture;f.unmount();f.frame({epoch:"A",rev:2});f.mount(mode);},mode);
  expect(await page.locator("body").textContent()).not.toContain("Supplied archived title");
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes("archived=1")));
  expect(await page.locator('[data-chats-section="archived"]').textContent()).toContain("7");
  await page.close();
});
it("RULE same generation refresh failure preserves rows", async () => {
  const page=await browser.newPage(); await page.goto(url);
  await page.evaluate(()=>{const f=(window as any).fixture;f.unmount();f.mount("archive-resource");});
  const body={gen:A,total:7,chats:[{threadId:"old",title:"Title",snippet:"same secret",createdAt:1}],next:null};
  await rawAnswer(page,"/archive-resource",body);
  await page.waitForFunction(()=>document.querySelector('#retained')?.textContent?.includes('same secret'));
  await page.locator('#archive-refresh').click();
  await page.waitForFunction(()=>(window as any).fixture.pending().includes('/archive-resource'));
  await page.evaluate(()=>{const f=(window as any).fixture;f.reject(f.pending().indexOf('/archive-resource'));});
  await page.waitForTimeout(650);
  expect(JSON.parse((await page.locator('#retained').textContent())!)).toMatchObject(body);
  await page.close();
});

it.each(["picker", "matches", "sidebar", "palette", "find", "all-page"])("RULE search holder %s preserves reconnect, drops changed rows, fails once and rejects late answers", async mode => {
  const page=await browser.newPage(); await page.goto(url);
  await page.evaluate(mode=>{const f=(window as any).fixture; f.unmount(); f.mount(mode);},mode);
  if(["sidebar","palette","find","all-page"].includes(mode)) {
    await page.waitForFunction(()=>(window as any).fixture.streams().length>0);
    await page.evaluate(gen=>(window as any).fixture.stream({kind:"hello",resumed:true,chatsGen:gen}),A);
  }
  if(mode === "all-page") await page.getByRole('textbox',{name:'Search all chats'}).fill('secret');
  if(mode === "find") await page.getByRole('textbox',{name:'Find in this conversation'}).fill('secret');
  await answer(page,"/api/search",A,"secret retained");
  const shown=()=> mode === "find" ? page.getByText('1 of 1',{exact:true}) : page.getByText('secret retained',{exact:false}).first();
  await shown().waitFor();
  const count=await page.evaluate(()=>(window as any).fixture.starts().filter((r:any)=>r.path.includes("/api/search")).length);
  await page.evaluate(()=>(window as any).fixture.wake());
  expect(await shown().count()).toBe(0);
  await page.evaluate(gen=>(window as any).fixture.hello(gen),A);
  await shown().waitFor();
  expect(await page.evaluate(()=>(window as any).fixture.starts().filter((r:any)=>r.path.includes("/api/search")).length)).toBe(count);
  await page.evaluate(gen=>(window as any).fixture.frame(gen),next);
  expect(await shown().count()).toBe(0);
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes('/api/search')));
  await page.evaluate(()=>{const f=(window as any).fixture;f.reject(f.pending().findIndex((p:string)=>p.includes('/api/search')));});
  const failedCount=await page.evaluate(()=>(window as any).fixture.starts().filter((r:any)=>r.path.includes("/api/search")).length);
  await page.waitForTimeout(1100);
  expect(await page.evaluate(()=>(window as any).fixture.starts().filter((r:any)=>r.path.includes("/api/search")).length)).toBe(failedCount);
  await page.evaluate(gen=>(window as any).fixture.hello(gen),next);
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes('/api/search')));
  await page.evaluate(gen=>(window as any).fixture.hello(gen),restored);
  await answer(page,"/api/search",next,"late secret");
  expect(await page.locator('body').textContent()).not.toContain('late secret');
  await answer(page,"/api/search",restored,"restored secret");
  if(mode === 'find') await page.getByText('1 of 1',{exact:true}).waitFor();
  else await page.getByText('restored secret',{exact:false}).first().waitFor();
  const paths=await page.evaluate(()=>(window as any).fixture.starts().map((r:any)=>r.path).filter((p:string)=>p.includes('/api/search')));
  if(mode === 'palette' || mode === 'find') expect(paths.every((p:string)=>!p.includes('view=chats'))).toBe(true);
  await page.close();
});

it.each([false,true])("RULE first paint keeps metadata without proof and equal hello uses zero requests, no hello=%s", async nohello=>{
  const page=await browser.newPage();await page.goto(url+(nohello?'?nohello':''));
  if(!nohello) {
    await page.evaluate(()=>{const f=(window as any).fixture;f.unmount();f.wake();f.mount('list');});
    await answer(page,'/main',A,'discarded');
  }
  await answer(page,'/main',A,'first paint secret');
  await page.getByText('Chat 0',{exact:true}).first().waitFor();
  expect(await page.locator('body').textContent()).not.toContain('first paint secret');
  expect(await page.locator('body').textContent()).toContain('Checking for changes');
  const count=await page.evaluate(()=>(window as any).fixture.starts().length);
  await page.evaluate(gen=>(window as any).fixture.hello(gen),A);
  await page.getByText('You: first paint secret',{exact:true}).first().waitFor();
  expect(await page.evaluate(()=>(window as any).fixture.starts().length)).toBe(count);
  await page.close();
});

it("RULE count survives section unmount, main invalidation and failed folded archive refresh", async()=>{
  const page=await browser.newPage();await mountRealPage(page);
  const first={gen:A,chats:[{threadId:'a',botId:'b',title:'Count main',createdAt:1}],total:60,next:null};
  await rawAnswer(page,'/api/chats?limit=50',first);
  if(!await page.locator('[data-chats-sections]').count()) await rawAnswer(page,'/api/chats?limit=50',first);
  await rawAnswer(page,'archived=1',{gen:A,total:7,chats:[],next:null});
  await page.getByRole('button',{name:/Archived.*7/}).waitFor();
  await page.getByRole('textbox',{name:'Search all chats'}).fill('secret');
  await page.waitForFunction(()=>!document.querySelector('[data-chats-sections]'));
  await page.evaluate(gen=>(window as any).fixture.frame(gen),next);
  await page.getByRole('textbox',{name:'Search all chats'}).fill('');
  await rawAnswer(page,'/api/chats?limit=50',{...first,gen:next});
  await page.getByRole('button',{name:/Archived.*7/}).waitFor();
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes('archived=1')));
  await page.evaluate(()=>{const f=(window as any).fixture;f.reject(f.pending().findIndex((p:string)=>p.includes('archived=1')));});
  await page.waitForTimeout(600);
  expect(await page.getByRole('button',{name:/Archived.*7/}).count()).toBe(1);
  await page.close();
});

it.each(['list','popup'])("RULE %s metadata survives lost proof, failed replacement and late restart answer",async mode=>{
  const page=await browser.newPage();await page.goto(url);
  if(mode==='popup') await page.evaluate(()=>{const f=(window as any).fixture;f.unmount();f.mount('popup');});
  const path=mode==='list'?'/main':'threads=main0';
  await answer(page,path,A,'protected secret');
  await page.getByText('You: protected secret',{exact:true}).first().waitFor();
  await page.evaluate(()=>(window as any).fixture.wake());
  expect(await page.locator('body').textContent()).not.toContain('protected secret');
  expect(await page.locator('body').textContent()).toContain(mode==='list'?'Chat 0':'Storm chat');
  const count=await page.evaluate(()=>(window as any).fixture.starts().length);
  await page.evaluate(gen=>(window as any).fixture.hello(gen),A);
  await page.getByText('You: protected secret',{exact:true}).first().waitFor();
  expect(await page.evaluate(()=>(window as any).fixture.starts().length)).toBe(count);
  await page.evaluate(gen=>(window as any).fixture.frame(gen),next);
  await page.waitForFunction(p=>(window as any).fixture.pending().some((v:string)=>v.includes(p)),path);
  await page.evaluate(p=>{const f=(window as any).fixture;f.reject(f.pending().findIndex((v:string)=>v.includes(p)));},path);
  expect(await page.locator('body').textContent()).not.toContain('protected secret');
  expect(await page.locator('body').textContent()).toContain(mode==='list'?'Chat 0':'Storm chat');
  await page.evaluate(gen=>(window as any).fixture.hello(gen),next);
  await page.waitForFunction(p=>(window as any).fixture.pending().some((v:string)=>v.includes(p)),path);
  await page.evaluate(gen=>(window as any).fixture.hello(gen),restored);
  await answer(page,path,next,'late restart secret');
  expect(await page.locator('body').textContent()).not.toContain('late restart secret');
  await answer(page,path,restored,'current secret');
  await page.getByText('You: current secret',{exact:true}).first().waitFor();
  await page.close();
});

it.each(['picker','matches','all-page'])("RULE %s merge rejects a page captured before generation change",async mode=>{
  const page=await browser.newPage();await page.goto(url);
  await page.evaluate(mode=>{const f=(window as any).fixture;f.unmount();f.mount(mode);},mode);
  if(mode === 'all-page') {
    await page.waitForFunction(()=>(window as any).fixture.streams().length>0);
    await page.evaluate(gen=>(window as any).fixture.stream({kind:'hello',resumed:true,chatsGen:gen}),A);
    await page.getByRole('textbox',{name:'Search all chats'}).fill('secret');
  }
  const hit={threadId:'main',messageId:'one',at:1,role:'user',kind:'text',snippet:'page one secret',matchStart:0,matchLength:4,hits:2,countComplete:true};
  await rawAnswer(page,'/api/search',{gen:A,hits:[hit],next:'cursor'});
  await page.getByRole('button',{name:'More results',exact:true}).click();
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes('before=cursor')));
  await page.evaluate(gen=>(window as any).fixture.frame(gen),next);
  await rawAnswer(page,'before=cursor',{gen:next,hits:[{...hit,messageId:'two',snippet:'wrong append'}],next:null});
  expect(await page.locator('body').textContent()).not.toContain('wrong append');
  expect(await page.locator('body').textContent()).not.toContain('page one secret');
  await rawAnswer(page,'/api/search',{gen:next,hits:[{...hit,snippet:'replacement page one'}],next:null});
  await page.getByText('replacement page one',{exact:false}).first().waitFor();
  expect(await page.getByRole('button',{name:'More results',exact:true}).count()).toBe(0);
  await page.close();
});

it("RULE path 13 flat routine folds keep titles and marks while snippets are gated",async()=>{
  const page=await browser.newPage();await page.goto(url);
  const rows=[0,1].map(i=>({threadId:`routine-${i}`,botId:'bot',title:`Routine title ${i}`,createdAt:Date.now()-i,snippet:'routine secret',pinned:true,unread:true,routine:{routineId:'r',routineName:'Morning'}}));
  await rawAnswer(page,'/main',{gen:A,total:2,chats:rows,next:null});
  await page.getByRole('button',{name:/Morning.*2 runs/}).click();
  await page.getByText('routine secret',{exact:true}).first().waitFor();
  await page.evaluate(()=>(window as any).fixture.wake());
  expect(await page.locator('body').textContent()).not.toContain('routine secret');
  expect(await page.getByText('Routine title 0',{exact:true}).count()).toBe(1);
  expect(await page.locator('[data-chat-row]').getByLabel('Pinned',{exact:true}).count()).toBe(2);
  await page.evaluate(gen=>(window as any).fixture.hello(gen),A);
  await page.getByText('routine secret',{exact:true}).first().waitFor();
  await page.evaluate(gen=>(window as any).fixture.frame(gen),next);
  await page.waitForFunction(()=>(window as any).fixture.pending().includes('/main'));
  await page.evaluate(()=>{const f=(window as any).fixture;f.reject(f.pending().indexOf('/main'));});
  expect(await page.locator('body').textContent()).not.toContain('routine secret');
  const fold=page.getByRole('button',{name:/Morning.*2 runs/});
  if(await fold.getAttribute('aria-expanded')==='false') await fold.click();
  expect(await page.getByText('Routine title 0',{exact:true}).count()).toBe(1);
  await page.close();
});

it("RULE path 7 hello precedes stalled snapshot and replay cannot replace restart proof",async()=>{
  const page=await browser.newPage();await page.goto(url);
  await page.evaluate(()=>{const f=(window as any).fixture;f.unmount();f.mount('provider');});
  await page.waitForFunction(()=>(window as any).fixture.streams().length>0);
  await page.evaluate(gen=>(window as any).fixture.stream({kind:'hello',resumed:true,cursor:'stream:10',chatsGen:gen}),restored);
  expect(await page.locator('#hydrated').textContent()).toBe('false');
  await page.evaluate(gen=>(window as any).fixture.stream({kind:'chats.forgot',gen}),A);
  expect(await page.evaluate(()=>(window as any).fixture.snapshot().known)).toEqual(restored);
  await page.close();
});

it("RULE loss b disposes main transcript bytes while loss a keeps them in memory",async()=>{
  const page=await browser.newPage();await page.goto(url);
  await answer(page,'/main',A,'memory secret');
  await page.getByText('You: memory secret',{exact:true}).first().waitFor();
  await page.evaluate(()=>(window as any).fixture.wake());
  expect(JSON.stringify(await page.evaluate(()=>(window as any).fixture.memory()))).toContain('memory secret');
  await page.evaluate(gen=>(window as any).fixture.hello(gen),next);
  expect(JSON.stringify(await page.evaluate(()=>(window as any).fixture.memory()))).not.toContain('memory secret');
  expect(await page.evaluate(()=>(window as any).fixture.memory().total)).toBe(60);
  await page.close();
});

it("RULE path 6 changing the Find query rejects a late prior-path answer",async()=>{
  const page=await browser.newPage();await page.goto(url);
  await page.evaluate(()=>{const f=(window as any).fixture;f.unmount();f.mount('find');});
  await page.waitForFunction(()=>(window as any).fixture.streams().length>0);
  await page.evaluate(gen=>(window as any).fixture.stream({kind:'hello',resumed:true,chatsGen:gen}),A);
  const input=page.getByRole('textbox',{name:'Find in this conversation'});
  await input.fill('oldquery');
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.includes('q=oldquery')));
  await input.fill('newquery');
  expect(await page.getByText('1 of 1',{exact:true}).count()).toBe(0);
  await answer(page,'q=newquery',A,'current path secret');
  await page.getByText('1 of 1',{exact:true}).waitFor();
  await answer(page,'q=oldquery',A,'late path secret');
  await page.waitForTimeout(50);
  expect(await page.getByText('1 of 1',{exact:true}).count()).toBe(1);
  await page.close();
});

it("RULE main failed request retries on owner action but never polls",async()=>{
  const page=await browser.newPage();await mountRealPage(page);
  const initial={gen:A,total:1,chats:[{threadId:'retry',title:'Initial retry',createdAt:1}],next:null};
  await rawAnswer(page,'/api/chats?limit=50',initial);
  if(!await page.getByText('Initial retry',{exact:true}).count()) await rawAnswer(page,'/api/chats?limit=50',initial);
  await page.getByText('Initial retry',{exact:true}).waitFor();
  await page.evaluate(gen=>(window as any).fixture.frame(gen),next);
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.startsWith('/api/chats?')&&!p.includes('archived=1')));
  await page.evaluate(()=>{const f=(window as any).fixture;f.reject(f.pending().findIndex((p:string)=>p.startsWith('/api/chats?')&&!p.includes('archived=1')));});
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.waitForFunction(()=>(window as any).fixture.pending().some((p:string)=>p.startsWith('/api/chats?')&&!p.includes('archived=1')),undefined,{timeout:2000});
  await rawAnswer(page,'/api/chats?limit=50',{gen:next,total:1,chats:[{threadId:'retry',title:'Retry works',createdAt:1}],next:null});
  await page.getByText('Retry works',{exact:true}).waitFor();
  const count=await page.evaluate(()=>(window as any).fixture.starts().filter((r:any)=>r.path.startsWith('/api/chats?')).length);
  await page.waitForTimeout(650);
  expect(await page.evaluate(()=>(window as any).fixture.starts().filter((r:any)=>r.path.startsWith('/api/chats?')).length)).toBe(count);
  await page.close();
});

it("RULE rejected unversioned answers make at most one automatic request per generation",async()=>{
  const page=await browser.newPage();await page.goto(url);
  await page.evaluate(()=>{const f=(window as any).fixture;f.unmount();f.mount('archive-resource');});
  await rawAnswer(page,'/archive-resource',{total:7,chats:[],next:null});
  await page.waitForTimeout(1100);
  expect(await page.evaluate(()=>(window as any).fixture.starts().filter((r:any)=>r.path==='/archive-resource').length)).toBe(1);
  await page.evaluate(gen=>(window as any).fixture.hello(gen),A);
  await rawAnswer(page,'/archive-resource',{total:7,chats:[],next:null});
  await page.waitForTimeout(1100);
  expect(await page.evaluate(()=>(window as any).fixture.starts().filter((r:any)=>r.path==='/archive-resource').length)).toBe(2);
  await page.close();
});

it("RULE path 4 store task rows cannot supply preview text even after a proven empty page",async()=>{
  const page=await browser.newPage();await page.goto(url);
  await page.evaluate(()=>{const f=(window as any).fixture;f.unmount();f.mount('popup');});
  await page.getByText('Storm chat',{exact:true}).first().waitFor();
  expect(await page.locator('body').textContent()).not.toContain('store backed secret');
  await rawAnswer(page,'threads=main0',{gen:A,total:0,chats:[],next:null});
  await page.waitForFunction(()=>!document.body.textContent?.includes('Checking for changes'));
  expect(await page.locator('body').textContent()).not.toContain('store backed secret');
  expect(await page.getByText('Storm chat',{exact:true}).count()).toBe(2);
  await page.close();
});

it.each(["rejected", "empty"])("ChatFindBar distinguishes a %s request from search failure", async outcome => {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    await page.evaluate(() => { const f = (window as any).fixture; f.unmount(); f.mount("find"); });
    await page.waitForFunction(() => (window as any).fixture.streams().length > 0);
    await page.evaluate(gen => (window as any).fixture.stream({ kind: "hello", resumed: true, chatsGen: gen }), A);
    await page.getByRole("textbox", { name: "Find in this conversation" }).fill("needle");
    await page.waitForFunction(() => (window as any).fixture.pending().some((p: string) => p.includes("q=needle")));
    await page.evaluate(({ outcome, gen }) => {
      const f = (window as any).fixture;
      const index = f.pending().findIndex((p: string) => p.includes("q=needle"));
      if (outcome === "rejected") f.reject(index);
      else f.raw(index, { gen, hits: [] });
    }, { outcome, gen: A });
    await page.getByText("Searching…", { exact: true }).waitFor({ state: "hidden" });
    if (outcome === "rejected") {
      expect(await page.getByText("No results", { exact: true }).count()).toBe(0);
      await page.waitForFunction(() => document.querySelector("#find-error")?.textContent === "fixture failure", undefined, { timeout: 5000 });
    } else {
      await page.getByText("No results", { exact: true }).waitFor();
      expect(await page.locator("#find-error").textContent()).toBe("");
    }
  } finally {
    await page.close();
  }
});
