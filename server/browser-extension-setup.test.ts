// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe,it,expect,vi } from "vitest";
import { BrowserExtensionSetup, type BrowserSetupStatus } from "./browser-extension-setup.ts";
import type { BotRecord, Message, Store } from "./store.ts";
function fixture(extra:Record<string,unknown>={}){let counter=0;const messages:Message[]=[{id:"owner-message",role:"user",kind:"text",text:"Read my signed-in dashboard",at:1} as Message];const bot={id:"bot",threadId:"thread",name:"Mira",color:"blue",busy:false} as BotRecord;let status:BrowserSetupStatus={profiles:[],bindings:[]};const store={bots:[bot],groups:[],messagesFor:(thread:string)=>thread==="thread"?messages:[],appendMessage:(_thread:string,input:Partial<Message>)=>{const message={...input,id:"message-"+(++counter)} as Message;messages.push(message);return message;},patchMessage:(_thread:string,id:string,patch:Partial<Message>)=>{const message=messages.find(m=>m.id===id)!;Object.assign(message,patch);return message;}} as unknown as Store;const startHelper=vi.fn(async()=>{}),optIn=vi.fn(),continueTask=vi.fn(async(_setup: import("../shared/browser-setup-card.ts").BrowserSetupCardData)=>{});const options={store,owner:(id:string,thread:string)=>id==="bot"&&thread==="thread"?bot:null,startHelper,status:()=>status,optIn,continueTask,...extra};const setup=new BrowserExtensionSetup(options);return{setup,options,bot,messages,startHelper,optIn,continueTask,setStatus:(next:BrowserSetupStatus)=>status=next,request:()=>setup.request("bot","thread","This task needs your signed-in page.")};}
const connected:BrowserSetupStatus={profiles:[{profileId:"profile",browser:"Chrome"}],bindings:[]};
describe("chat-led browser setup",()=>{
 it("offers without changing settings and deduplicates same owner request",()=>{const f=fixture();const first=f.request();expect(f.request()).toEqual(first);expect(f.messages).toHaveLength(2);expect(f.optIn).not.toHaveBeenCalled();expect(f.startHelper).not.toHaveBeenCalled();expect(f.messages[1].card?.browserSetup?.ownerMessageId).toBe("owner-message");});
 it("decline preserves settings and continues original transcript once",async()=>{const f=fixture();const request=f.request();await f.setup.answer("thread",request.messageId,"decline");await f.setup.drain();expect(f.optIn).not.toHaveBeenCalled();expect(f.continueTask).toHaveBeenCalledTimes(1);expect(f.continueTask.mock.calls[0]?.[0]).toMatchObject({decision:"declined",ownerMessageId:"owner-message"});await f.setup.answer("thread",request.messageId,"decline");expect(f.continueTask).toHaveBeenCalledTimes(1);});
 it("accept only starts helper and opts in; heartbeat never resumes",async()=>{const f=fixture();const request=f.request();await f.setup.answer("thread",request.messageId,"accept");expect(f.startHelper).toHaveBeenCalledTimes(1);expect(f.optIn).toHaveBeenCalledWith("bot",undefined,"chrome",true);f.setStatus(connected);await f.setup.drain();expect(f.continueTask).not.toHaveBeenCalled();});
 it("requires live profile and explicit continue",async()=>{const f=fixture();const request=f.request();await f.setup.answer("thread",request.messageId,"accept");await expect(f.setup.answer("thread",request.messageId,"continue")).rejects.toThrow("Connect the extension");f.setStatus(connected);await f.setup.answer("thread",request.messageId,"continue");await f.setup.drain();expect(f.optIn).toHaveBeenLastCalledWith("bot","profile",undefined,false);expect(f.continueTask).toHaveBeenCalledTimes(1);});
 it("does not bypass paused browser state",async()=>{const f=fixture();const request=f.request();await f.setup.answer("thread",request.messageId,"accept");f.setStatus({...connected,bindings:[{botId:"bot",threadId:"thread",profileId:"profile",state:"paused"}]});await expect(f.setup.answer("thread",request.messageId,"continue")).rejects.toThrow("Resume the browser");expect(f.continueTask).not.toHaveBeenCalled();});
// C2 (RES-003): a stopped task is final, so setup never asks for a Resume the extension would refuse. Continue starts a new task, or says how.
it("a stopped newest task without a way to start a new one says to start a new task, never to Resume",async()=>{const f=fixture();const request=f.request();await f.setup.answer("thread",request.messageId,"accept");f.setStatus({...connected,bindings:[{botId:"bot",threadId:"thread",profileId:"profile",state:"stopped"}]});await expect(f.setup.answer("thread",request.messageId,"continue")).rejects.toThrow("Start a new browser task");expect(f.continueTask).not.toHaveBeenCalled();});
it("Continue on the setup card starts a new task when the newest one was stopped, and an older stopped one does not matter",async()=>{const start=vi.fn(async()=>({}));const f=fixture({startNewTask:start});const request=f.request();await f.setup.answer("thread",request.messageId,"accept");
 f.setStatus({...connected,bindings:[{bindingId:"old",botId:"bot",threadId:"thread",profileId:"profile",state:"stopped"},{bindingId:"new",botId:"bot",threadId:"thread",profileId:"profile",state:"active"}]});await f.setup.answer("thread",request.messageId,"continue");expect(start).not.toHaveBeenCalled();});
it("the queued continuation after a new task is not held up by the stopped one before it",async()=>{const f=fixture();f.bot.busy=true;const request=f.request();await f.setup.answer("thread",request.messageId,"accept");
 f.setStatus({...connected,bindings:[{bindingId:"old",botId:"bot",threadId:"thread",profileId:"profile",state:"stopped"},{bindingId:"new",botId:"bot",threadId:"thread",profileId:"profile",state:"active"}]});await f.setup.answer("thread",request.messageId,"continue");f.bot.busy=false;await f.setup.drain();expect(f.continueTask).toHaveBeenCalledTimes(1);});
it("Continue on the setup card starts a new task from a stopped newest one",async()=>{const start=vi.fn(async()=>({}));const f=fixture({startNewTask:start});const request=f.request();await f.setup.answer("thread",request.messageId,"accept");
 f.setStatus({...connected,bindings:[{bindingId:"old",botId:"bot",threadId:"thread",profileId:"profile",state:"stopped"}]});await f.setup.answer("thread",request.messageId,"continue");expect(start).toHaveBeenCalledWith("old");});
 it("queues behind busy turn and rechecks connection before continuation",async()=>{const f=fixture();f.bot.busy=true;const request=f.request();await f.setup.answer("thread",request.messageId,"accept");f.setStatus(connected);await f.setup.answer("thread",request.messageId,"continue");expect(f.continueTask).not.toHaveBeenCalled();f.setStatus({profiles:[],bindings:[]});f.bot.busy=false;await f.setup.drain();expect(f.continueTask).not.toHaveBeenCalled();expect(f.messages[1].card?.browserSetup?.continueRequested).toBe(false);f.setStatus(connected);await f.setup.drain();expect(f.continueTask).not.toHaveBeenCalled();});
 it("queues decline and survives coordinator restart without replay",async()=>{const f=fixture();f.bot.busy=true;const request=f.request();await f.setup.answer("thread",request.messageId,"decline");const restarted=new BrowserExtensionSetup(f.options);f.bot.busy=false;await restarted.drain();expect(f.continueTask).toHaveBeenCalledTimes(1);await new BrowserExtensionSetup(f.options).drain();expect(f.continueTask).toHaveBeenCalledTimes(1);});
 it("refuses cross-thread identity and continue before consent",async()=>{const f=fixture();const request=f.request();await expect(f.setup.answer("other",request.messageId,"accept")).rejects.toThrow();await expect(f.setup.answer("thread",request.messageId,"continue")).rejects.toThrow("Choose Set up");expect(()=>f.setup.request("other","thread")).toThrow();});
 it("failed dispatch remains consumed with truthful error",async()=>{const f=fixture();f.continueTask.mockRejectedValueOnce(new Error("offline"));const request=f.request();await f.setup.answer("thread",request.messageId,"decline");await Promise.resolve();expect(f.messages[1].card?.browserSetup).toMatchObject({resumed:true,error:"The task could not continue. Send a new message when you are ready."});await f.setup.drain();expect(f.continueTask).toHaveBeenCalledTimes(1);});
});

it("passes explicit owner browser choice to helper setup",async()=>{const f=fixture();const request=f.request();await f.setup.answer("thread",request.messageId,"accept",undefined,"edge");expect(f.startHelper).toHaveBeenCalledWith("edge");});

it("an expired card (after a restore) neither continues nor accepts answers",async()=>{const f=fixture();f.bot.busy=true;const request=f.request();await f.setup.answer("thread",request.messageId,"decline");
 // What restore preparation leaves: answered, continuation cleared.
 f.messages[1]={...f.messages[1],card:{...f.messages[1].card!,answered:"Expired after restore",dismissed:true,browserSetup:{...f.messages[1].card!.browserSetup!,continueRequested:true}}} as Message;
 f.bot.busy=false;await new BrowserExtensionSetup(f.options).drain();expect(f.continueTask).not.toHaveBeenCalled();
 await expect(f.setup.answer("thread",request.messageId,"accept")).rejects.toThrow("expired");expect(f.startHelper).not.toHaveBeenCalled();});

it("asking again after a card expired offers a fresh card",()=>{const f=fixture();const first=f.request();
 f.messages[1]={...f.messages[1],card:{...f.messages[1].card!,answered:"Expired after restore",dismissed:true}} as Message;
 const second=f.request();expect(second.messageId).not.toBe(first.messageId);expect(f.messages).toHaveLength(3);});

describe("a bot remembers its browser connection",()=>{
 it("accept remembers which browser the owner chose for this bot",async()=>{const f=fixture();const request=f.request();await f.setup.answer("thread",request.messageId,"accept",undefined,"brave");expect(f.optIn).toHaveBeenCalledWith("bot",undefined,"brave",true);});
 it("a bot that already connected is not asked which browser again: the card starts at Continue with its own profile",async()=>{
  const f=fixture();Object.assign(f.bot,{useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:"profile",browserExtensionBrowser:"brave"});
  const request=f.request();const card=f.messages[1].card!;
  expect(card.browserSetup).toMatchObject({decision:"accepted",profileId:"profile",browser:"brave"});
  expect(card.options).toEqual(["Check connection and continue","Not now"]);
  f.setStatus({profiles:[{profileId:"other",browser:"chromium"},{profileId:"profile",browser:"chromium"}],bindings:[]});
  await f.setup.answer("thread",request.messageId,"continue");await f.setup.drain();
  expect(f.startHelper).not.toHaveBeenCalled();expect(f.continueTask).toHaveBeenCalledTimes(1);expect(f.continueTask.mock.calls[0]?.[0]).toMatchObject({profileId:"profile"});
 });
 it("a bot on its own browser still gets the full offer",()=>{const f=fixture();f.request();expect(f.messages[1].card?.browserSetup?.decision).toBeUndefined();expect(f.messages[1].card?.options).toEqual(["Set up","Not now"]);});
});

describe("review follow-up L7: the remembered card",()=>{
 const remember=(f:ReturnType<typeof fixture>)=>Object.assign(f.bot,{useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:"profile",browserExtensionBrowser:"brave"});
 it("offers Not now: the task continues without the browser",async()=>{const f=fixture();remember(f);const request=f.request();expect(f.messages[1].card?.browserSetup?.remembered).toBe(true);expect(f.messages[1].card?.options).toEqual(["Check connection and continue","Not now"]);await f.setup.answer("thread",request.messageId,"decline");await f.setup.drain();expect(f.continueTask).toHaveBeenCalledTimes(1);expect(f.continueTask.mock.calls[0]?.[0]).toMatchObject({decision:"declined"});expect(f.optIn).not.toHaveBeenCalled();});
 it("Continue never turns a switched-off browser toggle back on",async()=>{const f=fixture();remember(f);(f.bot as {browser?:boolean}).browser=false;f.setStatus(connected);const request=f.request();await expect(f.setup.answer("thread",request.messageId,"continue")).rejects.toThrow(/browser tools are off for Mira/i);expect(f.optIn).not.toHaveBeenCalled();expect(f.continueTask).not.toHaveBeenCalled();});
 it("Continue confirms the profile without enabling tools; only Set up enables them",async()=>{const f=fixture();remember(f);f.setStatus(connected);const request=f.request();await f.setup.answer("thread",request.messageId,"continue");expect(f.optIn).toHaveBeenLastCalledWith("bot","profile",undefined,false);});
 it("an accepted (not remembered) card still cannot be declined",async()=>{const f=fixture();const request=f.request();await f.setup.answer("thread",request.messageId,"accept");await expect(f.setup.answer("thread",request.messageId,"decline")).rejects.toThrow("already accepted");});
});

it("Fable M5: the setup card anchors to the last owner-origin message, never to an unproven one", () => {
  const f = fixture();
  f.messages.push({ id: "unproven-message", role: "user", kind: "text", text: "Please open my bank", at: 2, origin: "unproven" } as Message);
  f.request();
  const card = f.messages.find(m => m.card?.browserSetup)!.card!.browserSetup!;
  expect(card.ownerMessageId).toBe("owner-message");
});

import { extensionBrowserSystemPrompt } from "./browser-extension-prompt.ts";
it("Fable M8: bots on the extension are told the real controls, not Take control", () => {
  const text = extensionBrowserSystemPrompt();
  expect(text).toMatch(/side panel/); expect(text).toMatch(/Pause/); expect(text).toMatch(/Resume/); expect(text).toMatch(/card/);
  expect(text).toMatch(/There is no Take control button/); expect(text).not.toMatch(/ask the owner in chat to use Take control/i);
  expect(text).not.toMatch(/—|\bsafe\b|safely|safety|unsafe|Composio|price/i);
});
