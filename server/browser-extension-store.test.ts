// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { Store } from "./store.ts";
const fresh = () => new Store(() => ({ instanceId: "fixture", model: "fixture-model" }));
function records(patches: Record<string, unknown>[]) {
  const store = fresh();
  const bots = patches.map((patch, index) => ({ ...store.createBot({name:`Fixture ${index}`}, {seedMessages:false}), ...patch }));
  writeFileSync(join(DATA_DIR,"bots.json"),JSON.stringify(bots));
  return bots.map(bot=>bot.id);
}
const disk = () => JSON.parse(readFileSync(join(DATA_DIR,"bots.json"),"utf8"));
describe("extension browser assignment persistence",()=>{
  it("preserves two extension opt-ins and one legacy opt-in over repeated reloads",()=>{
    const ids=records([{useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:"profile_A"},{useMyChrome:true},{useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:"profile_A"},{useMyChrome:true}]);
    for(let count=0;count<2;count++){const loaded=fresh();expect(ids.map(id=>loaded.bot(id)?.useMyChrome)).toEqual([true,true,true,undefined]);expect(loaded.bot(ids[0])?.browserExtensionProfileId).toBe("profile_A");}
    expect(disk().map((bot:{useMyChrome?:true})=>bot.useMyChrome)).toEqual([true,true,true,undefined]);
  });
  it("leaves old single legacy route unchanged and defaults new bots to isolated",()=>{
    const ids=records([{useMyChrome:true},{}]);const loaded=fresh();expect(loaded.bot(ids[0])?.useMyChrome).toBe(true);expect(loaded.bot(ids[0])?.browserTransport).toBeUndefined();expect(loaded.bot(ids[1])?.useMyChrome).toBeUndefined();
  });
  it("normalizes invalid extension fields without creating inspect fallback",()=>{
    const ids=records([{useMyChrome:true,browserTransport:"evil"},{useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:"../profile"},{useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:42},{useMyChrome:true,browserExtensionProfileId:"profile_A"},{useMyChrome:"true",browserTransport:"extension"},{useMyChrome:true}]);
    const loaded=fresh();expect(ids.map(id=>loaded.bot(id)?.useMyChrome)).toEqual([undefined,undefined,undefined,undefined,undefined,true]);expect(loaded.bot(ids[0])?.browserTransport).toBeUndefined();expect(loaded.bot(ids[1])?.browserTransport).toBe("extension");expect(loaded.bot(ids[1])?.browserExtensionProfileId).toBeUndefined();expect(disk().slice(0,5).every((bot:{useMyChrome?:true})=>bot.useMyChrome===undefined)).toBe(true);
  });
  it("persists normal patchBot extension assignment across reload",()=>{
    const [id]=records([{}]);const store=fresh();store.patchBot(id,{useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:"profile-7"});expect(fresh().bot(id)).toMatchObject({useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:"profile-7"});
  });
});
