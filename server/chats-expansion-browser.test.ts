import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { threadKey, trigramQuery } from "./message-search-index.ts";
import { afterAll, expect, it } from "vitest";
import { BASE, DESKTOP_HEADERS, home, desktopApi } from "./testing/index-harness.ts";

// The original fixture seeds derived postings directly. With the isolated
// worker (5d5a791f19), pause its steps so it cannot rebuild over that seed.
const originalEntry = process.env.MURAGE_IDENTITY_CONTROL_ENTRY;
process.env.MURAGE_IDENTITY_CONTROL_ENTRY = join(process.cwd(), "server/testing/chats-search-fixture-entry.mjs");
afterAll(() => { if (originalEntry === undefined) delete process.env.MURAGE_IDENTITY_CONTROL_ENTRY; else process.env.MURAGE_IDENTITY_CONTROL_ENTRY = originalEntry; });

it("T-GROUP-EXPAND: real grouped route expands an incomplete singleton and ordinary pagination reaches its oldest hit",async()=>{
  const target=(await desktopApi("POST","/api/bots",{name:"Target expansion"})).body.bot;
  const padding=(await desktopApi("POST","/api/bots",{name:"Padding expansion"})).body.bot;
  const db=new DatabaseSync(join(home,".murage","messages.db"));
  // 5d5a791f19 moved derived postings into search.db. This pagination
  // fixture seeds a complete derived index, as the original fixture did;
  // worker admission and rebuilding have their own isolated proofs.
  // MAIN RULING INT-CONFLICT-DEFAULT 5d5a791f19: reset replaces search.db.
  // Reopen each probe so a handle opened before unlink cannot retain the old,
  // empty inode; seed only the worker's current, owner-qualified index.
  await expect.poll(() => {
    const probe = new DatabaseSync(join(home, ".murage", "search.db"));
    try {
      const owner = probe.prepare("SELECT v FROM search_state WHERE k='owner'").get()?.v;
      return typeof owner === "string" && owner === db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()?.done;
    } catch { return false; }
    finally { probe.close(); }
  }, { timeout: 10000 }).toBe(true);
  const search = new DatabaseSync(join(home, ".murage", "search.db"));
  search.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
  db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
  const fts=search.prepare("INSERT INTO messages_fts(rowid,t) VALUES(?,?)"), docs=search.prepare("INSERT INTO docs(rowid,thread_key) VALUES(?,?)");
  const insert=db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'user','text',?,?)");
  // MAIN RULING INT-CONFLICT-DEFAULT a62419d6d5: these owner-created search
  // rows carry desktop authorship, retaining every paging and forgotten-row check.
  const put=(thread:string,id:string,at:number,text:string)=>{const row=insert.run(thread,id,at,text,JSON.stringify({id,at,role:"user",kind:"text",text,origin:"desktop"}));fts.run(row.lastInsertRowid,text);docs.run(row.lastInsertRowid,threadKey(thread));};
  for(let i=0;i<2100;i++) put(padding.threadId,`pad-${i}`,i,"routepreview padding");
  for(let i=0;i<44;i++) put(target.threadId,`older-${i}`,10000+i,`routepreview older ${i}`);
  for(let i=0;i<600;i++) put(target.threadId,`gap-${i}`,11000+i,"nonmatching gap");
  put(target.threadId,"newest",20000,"routepreview newest"); db.exec("COMMIT");
  // The synthetic postings cover every inserted intent. Publish that watermark
  // with the index so the foreground reader does not mistake seeded rows for
  // an unfinished worker backlog and cap them as pending candidates.
  search.prepare("INSERT INTO search_state(k,v) VALUES('applied_seq',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM search_intents").get()!.seq));
  search.exec("DELETE FROM search_state WHERE k='built'; COMMIT");
  expect(Number(search.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?").get(trigramQuery("routepreview"))!.n)).toBe(2145);
  search.close();
  await desktopApi("PATCH",`/api/bots/${target.id}/tasks/${target.threadId}`,{pinned:true});
  const first=await desktopApi("GET","/api/search?view=chats&group_by=thread&q=routepreview&limit=1");
  expect(first.body.hits[0]).toMatchObject({threadId:target.threadId,hits:1,countComplete:false});
  expect(first.body.partial).toBe(false);
  // The ordinary reader owns a different SQLite connection from the grouped
  // route. Let its real worker open the seeded index before mounting a UI that
  // intentionally does not refresh a partial first response by itself.
  let ordinary: any;
  await expect.poll(async () => { ordinary = await desktopApi("GET", `/api/search?view=chats&q=routepreview&threadId=${target.threadId}&limit=40`); return ordinary.body.hits.length; }, { timeout: 10000 }).toBe(40).catch(error => {
    const probe = new DatabaseSync(join(home, ".murage", "search.db"));
    try { console.info("search fixture readiness", ordinary.body, probe.prepare("SELECT * FROM search_state").all(), probe.prepare("SELECT count(*) AS n FROM messages_fts").get()); }
    finally { probe.close(); }
    throw error;
  });
  const bundle=await build({entryPoints:["src/lib/testing/chats-route-fixture.tsx"],bundle:true,write:false,format:"iife",platform:"browser",jsx:"automatic",define:{"process.env.NODE_ENV":'"test"',"import.meta.env":"{}"},loader:{".css":"empty",".svg":"dataurl",".webp":"dataurl",".png":"dataurl",".jpg":"dataurl",".woff2":"dataurl"}});
  const server=createServer(async(req,res)=>{
    if(req.url?.startsWith("/api/")) {const response=await fetch(BASE+req.url,{headers:DESKTOP_HEADERS});res.writeHead(response.status,{"content-type":"application/json"});res.end(await response.text());}
    else {res.setHeader("content-type",req.url==="/app.js"?"text/javascript":"text/html");res.end(req.url==="/app.js"?bundle.outputFiles[0].text:'<div id="root"></div><script src="/app.js"></script>');}
  });
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));
  // Offline runners may supply an already-installed real browser and its libraries.
  const browserLibraries = process.env.MURAGE_TEST_BROWSER_LIBS;
  const browser=await chromium.launch({headless:true,args:["--no-sandbox"],executablePath:process.env.MURAGE_TEST_CHROMIUM_EXECUTABLE,
    ...(browserLibraries ? { env: { ...Object.fromEntries(Object.entries(process.env).filter(([,value]) => value !== undefined)), LD_LIBRARY_PATH: browserLibraries } } : {}) });
  try {
    const page=await browser.newPage();page.on("pageerror",error=>console.error(error));
    page.on("response", async response => { if (response.url().includes("/api/search")) { const body=await response.json(); console.log("Search fixture response",response.url(),JSON.stringify({gen:body.gen,next:body.next,partial:body.partial,hits:body.hits?.length,error:body.error})); } });
    await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
    const hit=page.locator('button[aria-expanded="false"]').filter({hasText:"routepreview newest"});
    await hit.waitFor();expect(await hit.textContent()).toContain("At least 1 match");await hit.click();
    expect(await page.evaluate(()=>(globalThis as any).opened??0)).toBe(0);
    await page.getByRole("button",{name:"More results",exact:true}).click();
    await page.waitForFunction(()=>(globalThis as any).document.body.textContent.includes("routepreview older 0"));
    let next=first.body.next;const seen=[target.threadId];
    while(next){expect(seen.length).toBeLessThan(4);const answer=await desktopApi("GET","/api/search?view=chats&group_by=thread&q=routepreview&limit=1&before="+encodeURIComponent(next));seen.push(...answer.body.hits.map((hit:any)=>hit.threadId));next=answer.body.next;}
    expect(seen.filter(id=>id===target.threadId)).toHaveLength(1);
    db.prepare("UPDATE messages SET json=json_set(json,'$.withheldFromBots','forgotten') WHERE thread_id=? AND id='older-0'").run(target.threadId);
    const forgotten=await desktopApi("GET",`/api/search?view=chats&q=routepreview&threadId=${target.threadId}&limit=100`);
    expect(forgotten.body.hits.some((hit:any)=>hit.messageId==="older-0")).toBe(false);
    expect(forgotten.body.hits).toHaveLength(44);
    await page.reload();
    await page.locator('button[aria-expanded="false"]').filter({hasText:"routepreview newest"}).click();
    await page.getByRole("button",{name:"More results",exact:true}).click();
    await page.waitForFunction(()=>/routepreview older 1(?!\d)/.test((globalThis as any).document.body.textContent));
    expect(await page.locator("body").innerText()).not.toContain("routepreview older 0");
  } finally {await browser.close();await new Promise<void>(done=>server.close(()=>done()));db.close();await desktopApi("DELETE",`/api/bots/${target.id}`);await desktopApi("DELETE",`/api/bots/${padding.id}`);}
},90_000);
