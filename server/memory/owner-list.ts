import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { database } from "../database.ts";
import { DATA_DIR } from "../config.ts";
import { ensureScope, type MemoryRoster } from "./policy.ts";

export interface OwnerListInput {
  query?:string; scopeId?:string; botId?:string; state?:string; cursor?:string;
  view?:"search"|"important"|"recent"|"review";
}

/** Owner inspection may span the workspace; the bot panel remains restricted
 * to that bot's existing audiences even when a caller supplies a scope filter.
 */
export function ownerListScopes(input:OwnerListInput,roster:MemoryRoster):string[]|null {
  if(!input.botId)return input.scopeId?[input.scopeId]:null;
  const bot=roster.bots.find(bot=>bot.id===input.botId);
  if(!bot)throw new Error("MEMORY_SUBJECT_UNKNOWN");
  const ids=[ensureScope("bot",bot.id),...database().prepare(`SELECT id FROM memory_scopes WHERE
    (kind='conversation' AND owner_key IN (SELECT value FROM json_each(?))) OR (kind='team' AND owner_key=?)
    UNION SELECT scope_id AS id FROM memory_scope_bindings WHERE subject_type='bot' AND subject_id=? AND state='granted'`)
    .all(JSON.stringify([bot.threadId,...(bot.tasks??[]).map(task=>task.threadId)]),bot.section?.trim()||"",bot.id).map(row=>String(row.id))];
  if(input.scopeId&&!ids.includes(input.scopeId))throw new Error("MEMORY_SCOPE_DENIED");
  return input.scopeId?[input.scopeId]:[...new Set(ids)];
}

/** Query the existing derived FTS index, then page authoritative records.
 * Index readiness is explicit. Source-text fallback keeps newly imported and
 * candidate records searchable before the worker projects them.
 */
export function ownerMemoryList(input:OwnerListInput,roster:MemoryRoster){
  const db=database(),scopes=ownerListScopes(input,roster),view=input.view??"search";
  let after={at:Number.MAX_SAFE_INTEGER,id:"",version:Number.MAX_SAFE_INTEGER};
  if(input.cursor){try{
    const value=JSON.parse(Buffer.from(input.cursor,"base64url").toString());
    if(!Number.isSafeInteger(value.at)||typeof value.id!=="string"||!Number.isSafeInteger(value.version)||value.version<1)throw new Error();
    after=value;
  }catch{throw new Error("INVALID_MEMORY_CURSOR");}}
  const filters:string[]=["(? IS NULL OR r.scope_id IN (SELECT value FROM json_each(?)))"];
  const args:Array<string|number|null>=[scopes===null?null:JSON.stringify(scopes),scopes===null?null:JSON.stringify(scopes)];
  if(input.state){filters.push("r.state=?");args.push(input.state);}else filters.push("r.state!='deleted'");
  if(view==="important")filters.push("r.owner_pinned=1 AND r.state='active'");
  if(view==="recent")filters.push("r.state='active'");
  if(view==="review")filters.push("r.state='candidate'");
  filters.push("(r.created_at<? OR (r.created_at=? AND (r.id>? OR (r.id=? AND r.version<?))))");
  args.push(after.at,after.at,after.id,after.id,after.version);
  let searchMode:"indexed"|"source-text"|"browse"="browse";
  let searchNotice:string|undefined;
  let index:DatabaseSync|undefined;
  try{
    if(input.query?.trim()){
      const terms=[...new Set(input.query.match(/[\p{L}\p{N}_-]+/gu)??[])].slice(0,32);
      const path=join(DATA_DIR,"memory-index.db");
      const pending=db.prepare(`SELECT 1 FROM memory_records r WHERE ${filters.join(" AND ")} AND NOT EXISTS
        (SELECT 1 FROM memory_projection_receipts p WHERE p.record_id=r.id AND p.record_version=r.version AND p.lexical_status='indexed') LIMIT 1`).get(...args);
      if(terms.length&&!pending&&existsSync(path)&&lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink()){
        // Read-only handle: this owner UI never rebuilds or mutates the index.
        index=new DatabaseSync(path,{readOnly:true});
        // IDs remain in SQLite through an attached read-only authoritative DB;
        // do not materialize every matching record in the server or renderer.
        index.prepare("ATTACH DATABASE ? AS authority").run(`file:${join(DATA_DIR,"messages.db")}?mode=ro`);
        const expression=terms.map(term=>`"${term.replaceAll('"','""')}"`).join(" AND ");
        const rows=index.prepare(`SELECT r.* FROM authority.memory_records r WHERE ${filters.join(" AND ")}
          AND EXISTS (SELECT 1 FROM lexical WHERE lexical MATCH ? AND lexical.id=r.id AND CAST(lexical.version AS INTEGER)=r.version)
          ORDER BY r.created_at DESC,r.id,r.version DESC LIMIT 51`).all(...args,expression);
        searchMode="indexed";
        return page(rows,searchMode,scopes);
      }
      searchMode="source-text";searchNotice="The search index is catching up. Showing source-text matches.";
      filters.push("instr(lower(r.text),lower(?))>0");args.push(input.query.trim());
    }
    const rows=db.prepare(`SELECT r.* FROM memory_records r WHERE ${filters.join(" AND ")} ORDER BY r.created_at DESC,r.id,r.version DESC LIMIT 51`).all(...args);
    return {...page(rows,searchMode,scopes),...(searchNotice?{searchNotice}:{})};
  }finally{index?.close();}
}

function page(rows:Array<Record<string,unknown>>,searchMode:string,scopeIds:string[]|null){
  const tail=rows[49];
  return {rows:rows.slice(0,50),searchMode,scopeIds,...rows.length>50?{nextCursor:Buffer.from(JSON.stringify({at:Number(tail.created_at),id:String(tail.id),version:Number(tail.version)})).toString("base64url")}:{}};
}
