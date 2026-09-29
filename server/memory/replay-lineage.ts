// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which generated messages a memory receipt still vouches for (0.1.61 room fixes).
//
// A bot reply made with recalled memory is linked to the receipt of that
// recall (memory_disclosures.output_message_ids). When what the receipt used
// is forgotten, deleted or changed, the reply is withheld from the
// transcript bots read (disclosures.ts). The same reply lives on in other
// places, and each of them has to follow it:
// - its captured source, and every record built on it (recall, the thread
//   checkpoint, memory search): recordRestsOnWithheldMessage;
// - a copy of it posted somewhere else (a delegation or ask reply mirrored
//   into the pair room or the room that asked): Message.copyOf, followed by
//   replayExclusions.
//
// Work is bounded. A thread with at most THREAD_RECEIPT_LIMIT receipts is
// read whole, as before; a larger one is read per message. Past the node and
// receipt budgets a caller that asks for failClosed gets the message
// withheld instead of an error, so a busy room never fails a turn and never
// shows what it could not check.
import { database } from "../database.ts";
import { supersededThreadCheckpoint } from "./checkpoints.ts";

export type Disclosure = Record<string,string|number|bigint|Uint8Array|null>;

// A check that cannot finish withholds the line; say so once per reason, so
// a real fault does not pass as quiet withholding.
const warned = new Set<string>();
function noteWithheldOnError(error: unknown) {
  const reason = error instanceof Error ? error.message.split(":")[0].slice(0, 80) : "unknown";
  if (warned.has(reason) || warned.size > 32) return;
  warned.add(reason);
  console.warn(`[memory] a replay check could not finish (${reason}); the line is withheld from bots`);
}
/** Where a message was copied from: the original thread and its message ids. */
export interface MessageCopy { threadId: string; messageIds: string[] }
/** role "user": the owner's or a person's own words. Only bot output is ever
 * linked to a receipt (dispatch.ts), so those are never looked up. */
export interface ReplayMessage { id: string; role?: string; copyOf?: MessageCopy }
/** The reader's side of a replay check. Null means content checks only. */
export interface ReplayAudience { policyRevision: number; deletionEpoch: number; revoked(row: Disclosure): boolean }

/** A thread is read whole up to this many receipts, per message past it. */
export const THREAD_RECEIPT_LIMIT = 2048;
const COPY_HOPS = 4, COPY_ORIGINS = 64;
const RECEIPT_COLUMNS = `bundle_id,thread_id,policy_revision,deletion_epoch,state,
  CASE WHEN length(record_versions)<=262144 THEN record_versions END AS record_versions,
  CASE WHEN length(source_versions)<=262144 THEN source_versions END AS source_versions,
  CASE WHEN length(output_message_ids)<=262144 THEN output_message_ids END AS output_message_ids`;

export function largeReceiptThread(threadId: string): boolean {
  const row = database().prepare("SELECT count(*) AS n FROM (SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT ?)").get(threadId, THREAD_RECEIPT_LIMIT+1);
  return Number(row?.n ?? 0) > THREAD_RECEIPT_LIMIT;
}

/** The copy link a stored message carries, if any. */
export function messageCopy(threadId: string, messageId: string): MessageCopy | undefined {
  const row = database().prepare("SELECT json_extract(json,'$.copyOf') AS copy FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId);
  if (typeof row?.copy !== "string") return undefined;
  try {
    const copy = JSON.parse(row.copy) as MessageCopy;
    return typeof copy?.threadId === "string" && Array.isArray(copy.messageIds) ? { threadId: copy.threadId, messageIds: copy.messageIds.filter(id => typeof id === "string") } : undefined;
  } catch { return undefined; }
}

/** The owner forgot the message itself (its captured source is deleted or tombstoned). */
export function messageSourceForgotten(threadId: string, messageId: string): boolean {
  const db = database(), sourceId = `message:${threadId}:${messageId}`;
  const source = db.prepare("SELECT state FROM memory_sources WHERE id=?").get(sourceId);
  return source?.state === "deleted" || Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? LIMIT 1").get(sourceId));
}

/** The content half of a receipt check: every record and source the receipt
 * cites still exists at the version disclosed, and nothing of it was
 * forgotten. No reader access and no global counter is consulted. */
export function contentRevoked(row: Disclosure, threadId: string): boolean {
  try {
    const db = database();
    const records: Array<{id:string;version:number}> = JSON.parse(String(row.record_versions));
    for (const record of records) {
      const current = db.prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(record.id,record.version);
      if (!current || (current.state!=="active" && !supersededThreadCheckpoint(record.id,record.version,{threadId}))) return true;
      if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(record.id,record.version)) return true;
    }
    const sources: Array<{id:string;revision:number}> = JSON.parse(String(row.source_versions));
    for (const source of sources) {
      const current = db.prepare("SELECT state,revision FROM memory_sources WHERE id=?").get(source.id);
      if (!current || current.state!=="active" || current.revision!==source.revision || db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision)) return true;
    }
    return false;
  } catch { return true; }
}

/** The ids among `messages` a reader may no longer be shown. `audience` null:
 * content checks only (a room's owner-audience turn, recall). failClosed: a
 * message whose check runs past its budget is withheld instead of throwing. */
export function replayExclusions(threadId: string, messages: readonly ReplayMessage[], audience: ReplayAudience | null, options: {invalidBundles?: Set<string>; failClosed?: boolean} = {}): Set<string> {
  if (messages.length > 10000) throw new Error("MEMORY_REPLAY_LIMIT");
  if (!messages.length) return new Set();
  const db = database();
  const { invalidBundles, failClosed = false } = options;
  const threadReceipts = new Map<string,Disclosure[]>();
  const large = new Map<string,boolean>();
  const outputs = new Map<string,string[]>();
  const memo = new Map<string,boolean>();
  let receiptCount = 0, nodes = 0;
  const charge = (count=1) => { nodes+=count; if(nodes>10000) throw new Error("MEMORY_REPLAY_LIMIT"); };
  const accept = (rows: Disclosure[]) => {
    receiptCount+=rows.length;
    if(receiptCount>2*THREAD_RECEIPT_LIMIT)throw new Error("MEMORY_REPLAY_LIMIT");
    for(const row of rows){
      if(row.record_versions===null||row.source_versions===null||row.output_message_ids===null)throw new Error("MEMORY_REPLAY_LIMIT");
      const ids:string[]=JSON.parse(String(row.output_message_ids));charge(ids.length);
      outputs.set(String(row.bundle_id),ids);
    }
  };
  const isLarge = (id: string) => { let known = large.get(id); if (known === undefined) { known = largeReceiptThread(id); large.set(id, known); } return known; };
  const loadThread = (id:string) => {
    const cached=threadReceipts.get(id); if(cached)return cached;
    const rows=db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM memory_disclosures WHERE thread_id=? LIMIT ?`).all(id,THREAD_RECEIPT_LIMIT+1);
    if(rows.length>THREAD_RECEIPT_LIMIT)throw new Error("MEMORY_REPLAY_LIMIT");
    accept(rows);threadReceipts.set(id,rows);return rows;
  };
  /** The receipts that list `messageId` as one of their outputs. */
  const producing = (thread: string, messageId: string, whole: boolean): Disclosure[] => {
    if (whole && !isLarge(thread)) return loadThread(thread).filter(row=>outputs.get(String(row.bundle_id))!.includes(messageId));
    // An exact quoted match in the JSON array text, confirmed after parsing;
    // an array too long to read is returned too and refused by accept().
    const rows=db.prepare(`SELECT ${RECEIPT_COLUMNS} FROM memory_disclosures WHERE thread_id=? AND (length(output_message_ids)>262144 OR instr(output_message_ids,?)>0) LIMIT ?`).all(thread,JSON.stringify(messageId),THREAD_RECEIPT_LIMIT+1);
    if(rows.length>THREAD_RECEIPT_LIMIT)throw new Error("MEMORY_REPLAY_LIMIT");
    accept(rows.filter(row=>!outputs.has(String(row.bundle_id))));
    return rows.filter(row=>outputs.get(String(row.bundle_id))!.includes(messageId));
  };
  const visiting = new Set<string>();
  const invalid = (row:Disclosure,depth=0):boolean => {
    const id=String(row.bundle_id),known=memo.get(id);if(known!==undefined)return known;
    if(depth>64)throw new Error("MEMORY_REPLAY_LIMIT");
    if(visiting.has(id))throw new Error("MEMORY_REPLAY_LINEAGE_CYCLE");
    visiting.add(id);charge();
    // A receipt's own thread checkpoint, superseded since, is stale there, not
    // revoked (checkpoints.ts), wherever the receipt is read from.
    const own=String(row.thread_id);
    let bad=audience!==null && (row.state==="revoked" || row.policy_revision!==audience.policyRevision || row.deletion_epoch!==audience.deletionEpoch);
    // Only this replay's receipts are hydrated under its audience. An explicitly
    // approved shared projection does not require access to a private ancestor.
    if(!bad && own===threadId)bad=audience?audience.revoked(row):contentRevoked(row,threadId);
    if(!bad){
      const refs:Array<{id:string;version:number}>=JSON.parse(String(row.record_versions));
      const direct:Array<{id:string;revision:number}>=JSON.parse(String(row.source_versions));
      charge(refs.length+direct.length);
      const sourceIds=new Set(direct.map(source=>source.id));
      for(const source of direct){
        const current=db.prepare("SELECT state,revision FROM memory_sources WHERE id=?").get(source.id);
        if(!current||current.state!=="active"||current.revision!==source.revision){bad=true;break;}
      }
      for(const ref of refs){
        if(bad)break;
        const current=db.prepare("SELECT state FROM memory_records WHERE id=? AND version=?").get(ref.id,ref.version);
        if(!current||(current.state!=="active"&&!supersededThreadCheckpoint(ref.id,ref.version,{threadId:own}))||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(ref.id,ref.version)){bad=true;break;}
        // An owner's correction does not carry the old words, so the version
        // it replaced is history, not evidence (recordRestsOnWithheldMessage).
        const parents=db.prepare(`WITH RECURSIVE parents(id,version) AS (
          SELECT ?,? UNION SELECT d.parent_id,d.parent_version FROM memory_derivations d
          JOIN parents p ON d.child_id=p.id AND d.child_version=p.version
          LEFT JOIN memory_records child ON child.id=d.child_id AND child.version=d.child_version
          WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=d.parent_id) LIMIT 1025)
          SELECT id,version FROM parents`).all(ref.id,ref.version);
        if(parents.length>1024)throw new Error("MEMORY_REPLAY_LIMIT");charge(parents.length);
        // Content checks cannot lean on the global policy revision a correction
        // moves, so every record the ref was derived from must still be current:
        // a projection whose original the owner corrected carries the old words.
        // A correction's own history edge (the child supersedes that parent) is
        // not a dependency.
        if(!audience){
          const edges=db.prepare(`WITH RECURSIVE edges(parent_id,parent_version,child_id,child_version) AS (
            SELECT parent_id,parent_version,child_id,child_version FROM memory_derivations WHERE child_id=? AND child_version=?
            UNION SELECT d.parent_id,d.parent_version,d.child_id,d.child_version FROM memory_derivations d
            JOIN edges e ON d.child_id=e.parent_id AND d.child_version=e.parent_version
            -- not past an owner's correction: the version it replaced is history (Astra r3 #2)
            LEFT JOIN memory_records child ON child.id=e.child_id AND child.version=e.child_version
            WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=e.parent_id) LIMIT 1025)
            SELECT e.parent_id,e.parent_version,p.state,c.supersedes_id FROM edges e
            LEFT JOIN memory_records p ON p.id=e.parent_id AND p.version=e.parent_version
            LEFT JOIN memory_records c ON c.id=e.child_id AND c.version=e.child_version`).all(ref.id,ref.version);
          if(edges.length>1024)throw new Error("MEMORY_REPLAY_LIMIT");charge(edges.length);
          // A parent replaced by a record in this same chain is history, not a
          // dependency, however many corrections and projections lie between.
          const replacing=new Set(edges.map(edge=>String(edge.supersedes_id??"")));
          const current=db.prepare("SELECT supersedes_id FROM memory_records WHERE id=? AND version=?").get(ref.id,ref.version);
          if(current?.supersedes_id)replacing.add(String(current.supersedes_id));
          for(const edge of edges){
            const history=replacing.has(String(edge.parent_id))&&(edge.state==="superseded"||edge.state==="archived");
            if(!edge.state||(edge.state!=="active"&&!history)||db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='record' AND target_id=? AND (revision IS NULL OR revision=?)").get(edge.parent_id,edge.parent_version)){bad=true;break;}
          }
        }
        if(bad)break;
        for(const parent of parents){
          const evidence=db.prepare("SELECT e.source_id,e.source_revision,s.revision,s.state FROM memory_evidence e LEFT JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=? AND e.record_version=? LIMIT 1025").all(parent.id,parent.version);
          if(evidence.length>1024)throw new Error("MEMORY_REPLAY_LIMIT");charge(evidence.length);
          for(const source of evidence){
            if(source.state!=="active"||source.revision!==source.source_revision){bad=true;break;}
            sourceIds.add(String(source.source_id));
          }
          if(bad)break;
        }
      }
      for(const sourceId of sourceIds){
        if(bad)break;
        charge();
        const source=db.prepare("SELECT thread_id,message_id,state FROM memory_sources WHERE id=?").get(sourceId);
        if(!source||source.state!=="active"){bad=true;break;}
        if(!source.thread_id||!source.message_id)continue;
        for(const parent of producing(String(source.thread_id),String(source.message_id),true))if(invalid(parent,depth+1)){bad=true;break;}
        if(bad)break;
        // a copy used as evidence carries its original's lineage
        // (the reader's own check too: a harness copy is not an approved projection)
        const copy=messageCopy(String(source.thread_id),String(source.message_id));
        if(copy&&originBad(copy,1,depth+1,true)){bad=true;break;}
      }
    }
    visiting.delete(id);memo.set(id,bad);if(bad)invalidBundles?.add(id);return bad;
  };
  /** A copy's originals: forgotten, or made under a receipt that no longer
   * holds, and for the reader's own copies also one the reader may not see
   * (a harness copy is not an owner-approved projection). A lineage longer
   * or wider than the budget is not established, so it counts as bad. */
  const originBad = (copy:MessageCopy, hops:number, depth:number, asReader:boolean):boolean => {
    if(hops>COPY_HOPS||copy.messageIds.length>COPY_ORIGINS||depth>64)return true;
    for(const original of copy.messageIds){
      charge();
      if(messageSourceForgotten(copy.threadId,original))return true;
      for(const row of producing(copy.threadId,original,true)){
        if(asReader&&audience?.revoked(row))return true;
        if(invalid(row,depth+1))return true;
      }
      const further=messageCopy(copy.threadId,original);
      if(further&&originBad(further,hops+1,depth,asReader))return true;
    }
    return false;
  };
  const excluded = new Set<string>();
  /** Judge one receipt for the given messages; past the budget, fail closed. */
  const judge = (row:Disclosure, ids:readonly string[]) => {
    const pending=ids.filter(id=>!excluded.has(id));
    if(!pending.length)return;
    let bad:boolean;
    try { bad=invalid(row); }
    catch (error) { if(!failClosed)throw error; noteWithheldOnError(error); visiting.clear(); bad=true; }
    if(bad)for(const id of pending)excluded.add(id);
  };
  const receiptsOf = (thread:string, messageId:string, whole:boolean, forId:string): Disclosure[] => {
    try { return producing(thread,messageId,whole); }
    catch (error) { if(!failClosed)throw error; noteWithheldOnError(error); excluded.add(forId); return []; }
  };
  const wanted=new Set(messages.filter(message=>message.role!=="user").map(message=>message.id));
  const perMessage = () => {
    // Per message, newest first: the lines a prompt shows are checked first.
    for(const message of [...messages].reverse()){
      if(message.role==="user")continue;
      for(const row of receiptsOf(threadId,message.id,false,message.id)){
        if(excluded.has(message.id))break;
        judge(row,[message.id]);
      }
    }
  };
  // A caller that does not fail closed (a direct chat) keeps the whole-thread
  // receipt cap, however few lines it replays.
  if(!failClosed && isLarge(threadId))throw new Error("MEMORY_REPLAY_LIMIT");
  if(messages.length>8 && !isLarge(threadId)){
    let rows:Disclosure[]|undefined;
    try { rows=loadThread(threadId); }
    catch (error) {
      if(!failClosed)throw error;
      noteWithheldOnError(error);
      // The whole thread is past the read budget: check line by line instead.
      threadReceipts.clear();outputs.clear();memo.clear();visiting.clear();receiptCount=0;nodes=0;
    }
    if(rows)for(const row of rows){
      const relevant=outputs.get(String(row.bundle_id))!.filter(id=>wanted.has(id));
      if(relevant.length)judge(row,relevant);
    }
    else perMessage();
  } else {
    perMessage();
  }
  // A copy is withheld with its original.
  for(const message of messages){
    if(!message.copyOf||excluded.has(message.id))continue;
    try { if(originBad(message.copyOf,1,0,true))excluded.add(message.id); }
    catch (error) { if(!failClosed)throw error; noteWithheldOnError(error); visiting.clear(); excluded.add(message.id); }
  }
  return excluded;
}

/** Generated speakers: a bot, the engine, a tool. Never the owner's or a
 * person's own words, which are never withheld for what a bot recalled. */
function generatedSpeaker(speaker: unknown): boolean {
  return typeof speaker === "string" && speaker !== "owner" && !speaker.startsWith("person:");
}

// One verdict per message while nothing in the database changed: recall,
// dispatch checks and replay ask the same question many times in one turn.
// total_changes() moves on every write through this connection, data_version
// on every commit by another one.
const verdicts = new Map<string,boolean>();
let verdictStamp = "";
/** Moves on every write through this connection and every commit by another
 * one; undefined inside a transaction, where a verdict may rest on writes
 * that roll back. A cached verdict holds only while it is unchanged. */
export function databaseStamp(): string | undefined {
  if (database().isTransaction) return undefined;
  const row = database().prepare("SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version").get();
  return `${row?.changes}:${row?.version}`;
}
function verdictCache(): Map<string,boolean> | undefined {
  const stamp = databaseStamp();
  if (stamp === undefined) return undefined;
  if (stamp !== verdictStamp || verdicts.size > 4096) { verdicts.clear(); verdictStamp = stamp; }
  return verdicts;
}

/** A captured generated message is withheld on content: what its receipt
 * used was forgotten, deleted or changed, or it is a copy of a message that
 * is. Checks it cannot finish withhold it. */
export function capturedMessageWithheld(threadId: string, messageId: string): boolean {
  const cache = verdictCache(), key = JSON.stringify([threadId, messageId]);
  const known = cache?.get(key);
  if (known !== undefined) return known;
  let withheld: boolean;
  try {
    const copy = messageCopy(threadId, messageId);
    withheld = replayExclusions(threadId, [{ id: messageId, ...(copy ? { copyOf: copy } : {}) }], null, { failClosed: true }).size > 0;
  } catch (error) { noteWithheldOnError(error); withheld = true; }
  cache?.set(key, withheld);
  return withheld;
}

/** A record whose evidence includes a withheld generated message: recall,
 * memory search and the thread checkpoint leave it out, so a withheld reply
 * does not come back as a remembered line. `alsoWithheld` adds a reader's
 * own transcript rule (a room turn that is not the owner's). */
export function recordRestsOnWithheldMessage(recordId: string, version: number, alsoWithheld?: (threadId: string, messageId: string) => boolean): boolean {
  // The record and every record it was derived from (an approved projection
  // carries no evidence of its own): a line resting on a withheld reply
  // anywhere up that chain rests on it.
  // An owner's correction (a new version in the owner's own words that
  // supersedes the old one) does not carry the old words: that history edge
  // is not a dependency (0.1.61 third fix round, Astra P1 #3).
  const db = database();
  const chain = `WITH RECURSIVE chain(id,version) AS (
      SELECT ?,? UNION SELECT d.parent_id,d.parent_version FROM memory_derivations d JOIN chain c ON d.child_id=c.id AND d.child_version=c.version
      LEFT JOIN memory_records child ON child.id=d.child_id AND child.version=d.child_version
      WHERE NOT (COALESCE(child.assertion,'')='owner-statement' AND COALESCE(child.supersedes_id,'')=d.parent_id) LIMIT 66)`;
  // A chain longer than the budget is not established: it counts as resting
  // on a withheld reply, whether or not its first records carry evidence.
  if (Number(db.prepare(`${chain} SELECT count(*) AS n FROM chain`).get(recordId, version)?.n ?? 0) > 64) return true;
  const rows = db.prepare(`${chain} SELECT DISTINCT s.thread_id,s.message_id,s.speaker FROM chain c JOIN memory_evidence e ON e.record_id=c.id AND e.record_version=c.version
    JOIN memory_sources s ON s.id=e.source_id WHERE s.thread_id IS NOT NULL AND s.message_id IS NOT NULL LIMIT 257`).all(recordId, version);
  if (rows.length > 256) return true;
  return rows.some(row => generatedSpeaker(row.speaker) && (capturedMessageWithheld(String(row.thread_id), String(row.message_id)) || Boolean(alsoWithheld?.(String(row.thread_id), String(row.message_id)))));
}

/** A reply made under a memory receipt, or a copy of one: what a reader
 * whose words were not proven may not be quoted. */
export function messageMadeWithMemory(threadId: string, messageId: string): boolean {
  return Boolean(messageCopy(threadId, messageId)) || Boolean(database().prepare("SELECT 1 FROM memory_disclosures WHERE thread_id=? AND instr(output_message_ids,?)>0 LIMIT 1").get(threadId, JSON.stringify(messageId)));
}

/** A copy link whose original is withheld, on content (a delegation result
 * read back later). Checks it cannot finish withhold it. */
export function copyOriginWithheld(copy: MessageCopy): boolean {
  try { return replayExclusions(copy.threadId, [{ id: "copy-origin-probe", role: "user", copyOf: copy }], null, { failClosed: true }).size > 0; }
  catch { return true; }
}

/** The same rule for one captured source (checkpoint maintenance). */
export function sourceIsWithheldMessage(source: Record<string, unknown>): boolean {
  return Boolean(source.thread_id && source.message_id && generatedSpeaker(source.speaker) && capturedMessageWithheld(String(source.thread_id), String(source.message_id)));
}
