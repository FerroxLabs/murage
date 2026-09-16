import { expect, it, vi } from "vitest";
import { GatewayIntentBits, Partials } from "discord.js";
import { DiscordGatewayTransport, discordClientOptions, discordPreview, type DiscordSDKFactory } from "./transport.ts";
const identity={applicationId:"11",botUserId:"12"};
function fixture(){
  const listeners=new Map<string,(...args:any[])=>void>();
  const post=vi.fn(async(_path:string,_options:unknown):Promise<unknown>=>({channel_id:"14",id:"15"}));
  const sdk={on:(name:string,cb:(...args:any[])=>void)=>listeners.set(name,cb),login:vi.fn(async()=>{listeners.get("clientReady")?.();}),destroy:vi.fn(async()=>{}),user:{id:"12"},application:{id:"11"},
    rest:{patch:vi.fn(async()=>({channel_id:"14",id:"15"})),get:vi.fn(async(path:string)=>path==="/users/@me"?{id:"12",bot:true}:{id:"11"}),post}};
  const factory:DiscordSDKFactory=async()=>sdk;
  return {sdk,listeners,post,transport:new DiscordGatewayTransport({botToken:"fake-only",factory})};
}
it("pins DM options, suppresses HTTP retries and truncates previews truthfully",()=>{
  const options=discordClientOptions();expect(options.intents).toEqual([GatewayIntentBits.DirectMessages]);expect(options.partials).toEqual([Partials.Channel]);
  expect(options.rest.retries).toBe(0);expect(options.rest.rejectOnRateLimit()).toBe(true);expect(options.rest.timeout).toBe(10000);
  const output=discordPreview("😀".repeat(2000));expect(output.length).toBeLessThanOrEqual(2000);expect(output).toContain("Full response in Murage");expect(output).not.toMatch(/[\uD800-\uDBFF]\n/);
});
it("verifies REST/READY identity and fences stopped Gateway callbacks",async()=>{
  const f=fixture(),receive=vi.fn(),health=vi.fn();expect(await f.transport.verifyBot()).toEqual(identity);await f.transport.start(receive,health);
  expect(health).toHaveBeenCalledWith("connected");
  const message={id:"15",channelId:"14",channel:{type:1},author:{id:"13",bot:false},type:0,content:"hello",createdTimestamp:1000000000,attachments:{size:0},components:[]};
  f.listeners.get("messageCreate")!(message);expect(receive).toHaveBeenCalledWith(expect.objectContaining({...identity,dmId:"14",authorId:"13",forwarded:false}));
  f.listeners.get("shardDisconnect")!({code:4004});expect(health).toHaveBeenCalledWith("blocked");
  await f.transport.stop();f.listeners.get("messageCreate")!(message);expect(receive).toHaveBeenCalledTimes(1);expect(f.sdk.destroy).toHaveBeenCalledTimes(1);
});
it("sends once to exact recipient without mentions and classifies uncertainty",async()=>{
  const f=fixture(),signal=new AbortController().signal;
  expect(await f.transport.sendText({dmId:"14",text:"hello",signal})).toEqual({channel:"14",messageId:"15"});
  expect(f.post.mock.calls[0]).toEqual(["/channels/14/messages",{signal,body:{content:"hello",allowed_mentions:{parse:[],replied_user:false},tts:false,flags:4}}]);
  f.post.mockRejectedValue({name:"RateLimitError",timeToReset:1000,retryAfter:9000,sublimitTimeout:2000});
  await expect(f.transport.sendText({dmId:"14",text:"hi",signal})).rejects.toMatchObject({code:"rate-limit",uncertain:false,retryAfterSeconds:9});
  f.post.mockRejectedValue(new Error("private token-like diagnostic"));await expect(f.transport.sendText({dmId:"14",text:"hi",signal})).rejects.toMatchObject({message:"unavailable",uncertain:true});
  expect(f.post).toHaveBeenCalledTimes(3);
});
it("rejects invalid success/auth/forbidden and pre-dispatch cancellation",async()=>{
  const f=fixture(),controller=new AbortController();f.post.mockResolvedValue({channel_id:"99",id:"15"});
  await expect(f.transport.sendText({dmId:"14",text:"hi",signal:controller.signal})).rejects.toMatchObject({uncertain:true});
  for(const [status,code] of [[401,"auth"],[403,"forbidden"],[400,"invalid-request"]]){f.post.mockRejectedValue({status});await expect(f.transport.sendText({dmId:"14",text:"hi",signal:controller.signal})).rejects.toMatchObject({code,uncertain:false});}
  controller.abort();await expect(f.transport.sendText({dmId:"14",text:"hi",signal:controller.signal})).rejects.toMatchObject({code:"offline",uncertain:false});expect(f.post).toHaveBeenCalledTimes(4);
});

const approveId = `murage:${"a".repeat(48)}:a`, denyId = approveId.slice(0, -1) + "d";
it("sends exact permission summaries with native buttons and clears the original message", async () => {
  const f=fixture(), signal=new AbortController().signal, text="Run @everyone <@13> exactly";
  await f.transport.sendPermission({dmId:"14",text,approveId,denyId,signal});
  expect(f.post.mock.calls[0][1]).toMatchObject({body:{content:text,allowed_mentions:{parse:[]},components:[{components:[{label:"Approve once",custom_id:approveId},{label:"Deny",custom_id:denyId}]}]}});
  await expect(f.transport.sendPermission({dmId:"14",text:"x".repeat(2001),approveId,denyId,signal})).rejects.toMatchObject({code:"invalid-request",uncertain:false});
  expect(f.post).toHaveBeenCalledTimes(1);
  await f.transport.settlePermission({dmId:"14",messageId:"15",text:"Denied",signal});
  expect(f.sdk.rest.patch).toHaveBeenCalledWith("/channels/14/messages/15",expect.objectContaining({body:{content:"Denied",components:[],allowed_mentions:{parse:[],replied_user:false}}}));
});
it("acks buttons before delivery and rejects other providers, groups, authors, failures and stopped events", async () => {
  const f=fixture(), receive=vi.fn(), health=vi.fn(), ack=vi.fn(async()=>{});
  f.transport.onPermissionAction(receive);await f.transport.verifyBot();await f.transport.start(vi.fn(),health);
  const event={isButton:()=>true,guildId:null,channel:{type:1},applicationId:"11",message:{id:"15",author:{id:"12"}},user:{id:"13",bot:false},channelId:"14",customId:approveId,deferUpdate:ack};
  const emit=(patch={})=>f.listeners.get("interactionCreate")!({...event,...patch});
  emit();await vi.waitFor(()=>expect(receive).toHaveBeenCalledTimes(1));
  expect(ack).toHaveBeenCalledTimes(1);await receive.mock.calls[0][0].ack();expect(ack).toHaveBeenCalledTimes(1);
  expect(receive.mock.calls[0][0]).toMatchObject({provider:"discord",applicationId:"11",userId:"13",channelId:"14",messageId:"15",actionId:approveId});
  for(const patch of [{guildId:"99"},{applicationId:"99"},{message:{id:"15",author:{id:"99"}}},{customId:"approve"},{channel:{type:3}}]) emit(patch);
  ack.mockRejectedValueOnce(new Error("secret"));emit();await vi.waitFor(()=>expect(health).toHaveBeenCalledWith("error"));
  expect(receive).toHaveBeenCalledTimes(1);await f.transport.stop();emit();expect(ack).toHaveBeenCalledTimes(2);
});
