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
  it("leaves ambiguous records unchanged while recognizing an otherwise valid legacy direct choice",()=>{
    const rows=[{useMyChrome:true,browserTransport:'evil'},{useMyChrome:true,browserTransport:'extension',browserExtensionProfileId:'../profile'},{useMyChrome:true,browserTransport:'extension',browserExtensionProfileId:42},{useMyChrome:true,browserExtensionProfileId:'profile_A'},{useMyChrome:'true',browserTransport:'extension'},{useMyChrome:true}];
    const ids=records(rows),loaded=fresh();for(const index of [0,1,2])expect(loaded.bot(ids[index])).toMatchObject(rows[index]);expect(loaded.bot(ids[3])?.browserMode).toBe('chrome-direct');expect(loaded.bot(ids[5])?.browserMode).toBe('builtin');
    // EP section 5 preserves the old sanitizer's authority rules; the
    // integration ruling requires exact boolean true even in hand-edited data.
    expect(loaded.bot(ids[4])?.browserMode).toBe('builtin');
    expect(loaded.bot(ids[4])).not.toHaveProperty('useMyChrome');
    expect(fresh().bot(ids[4])).not.toHaveProperty('useMyChrome');
    expect(disk().find((bot:{id:string})=>bot.id===ids[4])).not.toHaveProperty('useMyChrome');
  });
  it("persists a committed browser selection across reload",()=>{
    const [id]=records([{}]);const store=fresh();store.commitBrowserChoice(id,{browserMode:"chrome-extension",useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:"profile-7",selectionRevision:1,browserSelectionRevision:1},store.chromeDirectReservation);expect(fresh().bot(id)).toMatchObject({useMyChrome:true,browserTransport:"extension",browserExtensionProfileId:"profile-7"});
  });
});
