import { expect, it } from "vitest";
import { discordId, normalizeDiscordMessage, discordPrompt } from "./event.ts";
export const identity = { applicationId:"100000000000000001",botUserId:"100000000000000002",ownerUserId:"100000000000000003" };
export const event = (content="hello", id="100000000000000005") => ({...identity,id,dmId:"100000000000000004",channelType:1,authorId:identity.ownerUserId,authorBot:false,guildId:null,webhookId:null,type:0,content,occurredAt:1000000000,attachments:0,components:0,forwarded:false});
it("preserves snowflake precision and accepts only the exact text DM owner",()=>{
  expect(normalizeDiscordMessage(event(),identity)).toMatchObject({deliveryId:"discord:100000000000000001:100000000000000004:100000000000000005",text:"hello"});
  expect(discordId.safeParse(Number("100000000000000001")).success).toBe(false);
  for(const patch of [{applicationId:"9"},{botUserId:"9"},{authorId:"9"},{authorId:identity.botUserId},{authorBot:true},{guildId:"9"},{channelType:3},{webhookId:"9"},{type:1},{attachments:1},{components:1},{forwarded:true},{content:""}])
    expect(normalizeDiscordMessage({...event(),...patch},identity)).toBeNull();
});
it("does not turn approval-like text into authority",()=>{
  for(const text of ["yes","/approve request","deny","/pair wrong"])expect(discordPrompt(text)).toMatchObject({prompt:"",response:expect.stringContaining("Review approvals")});
  expect(discordPrompt("summarize notes").prompt).toContain("UNTRUSTED DISCORD");
});
