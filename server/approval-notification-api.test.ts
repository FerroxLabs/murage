import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { openSse } from "./testing/sse.ts";

let fixture: VerificationServer, headers: Record<string,string>;
type BotResponse = { bot: { id: string; threadId: string } };
async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res=await fetch(fixture.info.url+path,{method,headers:{...headers,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});
  expect(res.ok).toBe(true); return res.json() as Promise<T>;
}
beforeAll(async()=>{
  // Existing in-process fixture driver: replace its normal reply with a
  // normalized pending permission, then use the real server event fold/SSE.
  // Its respondToRequest returns unavailable, exercising auto-mode fallback.
  const source=[
    "const fs=await import('node:fs');const path=await import('node:path');const {registerHooks}=await import('node:module');",
    "registerHooks({load(url,ctx,next){if(!url.endsWith('/fake-late-terminal-driver.ts'))return next(url,ctx);let source=fs.readFileSync(new URL(url),'utf8');",
    "const old='emit({ type: \"item.completed\", itemType: \"assistant_text\", text: \"Hello from late\", threadId: turn.threadId, turnId });';if(!source.includes(old))throw Error('fixture anchor changed');",
    "source=source.replace(old,'emit({ type: \"request.opened\", requestType: \"permission\", tool: \"Read\", summary: \"Read fixture notes\", requestId: turnId + \"-approval\", threadId: turn.threadId, turnId }); return;');return{format:'module-typescript',shortCircuit:true,source};}});",
    "const {BUILT_IN_DRIVERS}=await import("+JSON.stringify(new URL("./drivers/builtIn.ts",import.meta.url).href)+");",
    "const {makeLateTerminalDriver}=await import("+JSON.stringify(new URL("./testing/fake-late-terminal-driver.ts",import.meta.url).href)+");BUILT_IN_DRIVERS.push(makeLateTerminalDriver());",
    "const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));cfg.instances.alert={driver:'fakeLateTerminal'};fs.writeFileSync(file,JSON.stringify(cfg));",
  ].join("\n");
  fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:source});
  const proof=await(await fetch(fixture.info.url+"/api/desktop-secret")).json();
  if (!proof || typeof proof !== "object" || !("secret" in proof) || typeof proof.secret !== "string") throw new Error("Missing fixture desktop proof");
  headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.secret};
},30000);
afterAll(async()=>{await fixture?.close();});

it.each([false,true])("human approval includes stable identity with autoApprove=%s",async autoApprove=>{
  const {bot}=await api<BotResponse>("POST","/api/bots",{name:"Approval fixture",modelSelection:{instanceId:"alert",model:"late-1"}});
  await api("PATCH",`/api/bots/${bot.id}`,{notifications:true,autoApprove,autoReview:"off",computer:"off"});
  const stream=await openSse(fixture.info.url+"/api/events");
  try{
    await stream.until(frame=>frame.kind==="hello");
    await api("POST",`/api/bots/${bot.id}/messages`,{text:"Approval fixture",threadId:bot.threadId});
    const frame=await stream.until(frame=>frame.kind==="notify"&&frame.notification?.botId===bot.id&&frame.notification.kind==="approval");
    const {messages}=await api<{ messages: Array<{ id: string; card: { requestId: string; answered?: string; held?: string } }> }>("GET",`/api/threads/${bot.threadId}/messages`);
    const card=messages.find(message=>message.id===frame.notification.messageId)!;
    expect(card.card.requestId).toBe(frame.notification.requestId);
    expect(frame.notification.threadId).toBe(bot.threadId);
    expect(frame.notification.requestTurnId).toMatch(/^late-turn-/);
    expect(card.card.answered).toBeUndefined();
    if(autoApprove)expect(card.card.held).toBe("Auto mode couldn't answer this one.");
    await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});
  }finally{stream.close();}
},20000);

it("suppressed bot approvals remain pending without a notification",async()=>{
  const {bot}=await api<BotResponse>("POST","/api/bots",{name:"Quiet approval",modelSelection:{instanceId:"alert",model:"late-1"}});
  await api("PATCH",`/api/bots/${bot.id}`,{notifications:false,autoApprove:false,autoReview:"off",computer:"off"});
  const stream=await openSse(fixture.info.url+"/api/events");
  try{
    await stream.until(frame=>frame.kind==="hello");
    await api("POST",`/api/bots/${bot.id}/messages`,{text:"Approval fixture",threadId:bot.threadId});
    await stream.until(frame=>frame.kind==="message"&&frame.threadId===bot.threadId&&frame.message?.card?.requestId);
    await api("PATCH",`/api/bots/${bot.id}`,{name:"Quiet observed"});
    await stream.until(frame=>frame.kind==="bot"&&frame.bot?.name==="Quiet observed");
    expect(stream.frames.filter(frame=>frame.kind==="notify"&&frame.notification?.botId===bot.id)).toEqual([]);
    await api("POST",`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});
  }finally{stream.close();}
},20000);

it("wires harness-native producers through the same pending-card notification gate",()=>{
  // Source wiring only; provider/SSE and peer callback behavior are tested above.
  const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
  expect(source).toContain("onApproval: notifyApproval");
  expect(source).toContain("notifyApproval(ownerId, threadId, requestId, messageId)");
  expect(source).toContain("notifyApproval(args.botId, args.threadId, requestId, approvalMessage.id)");
  expect(source).toContain("notifyApproval(from.id, fromThreadId, proposed.requestId, proposed.messageId)");
  expect(source).toContain("notifyApproval(owner.id, owner.threadId, proposal.requestId, proposal.messageId)");
  expect(source).toContain("card.requestId !== requestId || card.answered || card.dismissed");
});
