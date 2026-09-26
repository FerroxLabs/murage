// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a backup left out, for the pages that list it (0.1.60 audit A-01).
import { readFileSync } from "node:fs";
import type { StateSnapshotManifest } from "./installation-state-snapshot.ts";

/** Bot names by id from a staged roster, to say whose folder an item was in. */
export function botNames(file:string):Record<string,string>{
  try{
    const roster=JSON.parse(readFileSync(file,"utf8"));if(!Array.isArray(roster))return{};
    return Object.fromEntries(roster.filter(bot=>bot&&typeof bot.id==="string"&&typeof bot.name==="string"&&bot.name.trim()).map(bot=>[bot.id,bot.name.replace(/[\x00-\x1f\x7f]/g,"?").trim().slice(0,80)]));
  }catch{return{};}
}
/** What a backup left out, for the page that reports it: at most 50 items,
 * each a path inside the data folder with its reason, and the names of the
 * bots whose folders they were in. */
export function skippedSummary(recovery:Pick<StateSnapshotManifest,"skipped"|"skippedCount">,bots:Record<string,string>={}){
  const count=recovery.skippedCount??0;if(!count)return{};
  const items=(recovery.skipped??[]).slice(0,50);
  const ids=new Set(items.map(item=>/^workspaces\/([^/]+)\//.exec(item.path)?.[1]).filter((id):id is string=>!!id&&Object.hasOwn(bots,id)));
  return{skipped:{count,items,bots:Object.fromEntries([...ids].map(id=>[id,bots[id]]))}};
}

