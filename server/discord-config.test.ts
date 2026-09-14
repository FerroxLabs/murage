import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DATA_DIR, loadConfig, parseConfigPatch, saveConfig, stripWorkspaceCredentialEnv, syncCredentialEnv } from "./config.ts";
import { requiresDesktopAuthority } from "./desktop-policy.ts";
import { createRoutineEvent, channelOriginSchema } from "../shared/routine-event.ts";
afterEach(()=>{rmSync(join(DATA_DIR,"config.json"),{force:true});vi.unstubAllEnvs();});
it("preserves Discord owner identity while hydrating and clearing encrypted-token env",()=>{
  mkdirSync(DATA_DIR,{recursive:true});vi.stubEnv("MURAGE_DISCORD_BOT_TOKEN",undefined);
  saveConfig(parseConfigPatch({discord:{applicationId:"11",ownerUserId:"13",botToken:""}}));
  syncCredentialEnv({discord:{botToken:"fake-discord-private"}});
  expect(loadConfig().discord).toMatchObject({applicationId:"11",ownerUserId:"13",botToken:"fake-discord-private"});
  expect(readFileSync(join(DATA_DIR,"config.json"),"utf8")).not.toContain("fake-discord-private");
  syncCredentialEnv({discord:{botToken:""}});expect(loadConfig().discord?.botToken).toBe("");
  const env={MURAGE_DISCORD_BOT_TOKEN:"secret",SAFE_FIELD:"keep"};stripWorkspaceCredentialEnv(env);expect(env).toEqual({SAFE_FIELD:"keep"});
});
it("rejects malformed IDs/fields and requires private authority for all Discord routes",()=>{
  const invalid: Array<Record<string,string|number>> = [{ownerUserId:"../owner"},{applicationId:123},{webhookUrl:"https://example.invalid"},{botToken:"x".repeat(513)}];
  for(const discord of invalid)expect(()=>parseConfigPatch({discord})).toThrow();
  for(const method of ["GET","POST","PATCH","PUT","DELETE"])for(const path of ["/api/discord/status","/api/discord/pair","/api/discord/resume","/api/discord/revoke"])expect(requiresDesktopAuthority(method,path)).toBe(true);
  expect(requiresDesktopAuthority("GET","/api/discord-other")).toBe(false);
});
it("adds Discord provenance without replacing Slack or Telegram",()=>{
  for(const platform of ["slack","discord"] as const){const channelOrigin={platform,connectionId:"connection"};expect(channelOriginSchema.safeParse(channelOrigin).success).toBe(true);expect(createRoutineEvent({runId:"run",definitionId:"definition",receivedAt:1,source:"channel",channelOrigin}).origin).toEqual({kind:"channel",channel:platform,connectionId:"connection"});}
  expect(createRoutineEvent({runId:"run",definitionId:"definition",receivedAt:1,source:"channel",telegramConnectionId:"telegram"}).origin).toEqual({kind:"channel",channel:"telegram",connectionId:"telegram"});
});
