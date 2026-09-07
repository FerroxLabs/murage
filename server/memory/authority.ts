import { randomUUID, createHash } from "node:crypto";
import { database, transaction } from "../database.ts";
import { redactSecretsInText } from "../redact.ts";
import type { MemoryEvidenceHandle } from "../../shared/memory.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";

const ownerTickets = new WeakSet<object>();
/** Mint only after the HTTP desktop-authority check; not exposed as an agent tool. */
export function ownerMemoryTicket() { const ticket = Object.freeze({}); ownerTickets.add(ticket); return ticket; }
export function requireMemoryOwner(ticket: object) { if (!ownerTickets.has(ticket)) throw new Error("MEMORY_OWNER_REQUIRED"); }

export function saveMemoryCandidate(text: string, evidence: MemoryEvidenceHandle[], key: string, access: MemoryAccess) {
  assertMemoryAccess(access);
  if (!text.trim() || text.length > 4096 || !evidence.length || evidence.length > 20 || !/^[\w-]{1,160}$/.test(key)) throw new Error("INVALID_MEMORY_CANDIDATE");
  return transaction(db => {
    const scopes = new Set<string>();
    for (const handle of evidence) {
      const source = db.prepare("SELECT s.scope_id,s.state,s.revision,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=? WHERE s.id=?").get(handle.revision,handle.sourceId);
      if (!source || source.state !== "active" || source.revision !== handle.revision) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
      assertMemoryAccess(access,String(source.scope_id)); scopes.add(String(source.scope_id));
      const payload = JSON.parse(String(source.payload));
      if (!Number.isSafeInteger(handle.startByte) || !Number.isSafeInteger(handle.endByte) || handle.startByte < 0 || handle.endByte <= handle.startByte || handle.endByte > Buffer.byteLength(payload.text ?? "")) throw new Error("INVALID_MEMORY_SPAN");
      if (db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(handle.sourceId,handle.revision)) throw new Error("MEMORY_EVIDENCE_UNAVAILABLE");
    }
    // Cross-scope synthesis must not implicitly expand its audience.
    if (scopes.size !== 1) throw new Error("MEMORY_PROMOTION_REQUIRED");
    const id = createHash("sha256").update(JSON.stringify([access.threadId,key])).digest("hex"), scope = [...scopes][0];
    const existing = db.prepare("SELECT text,state,scope_id FROM memory_records WHERE id=? AND version=1").get(id);
    const safeText = redactSecretsInText(text);
    if (existing) {
      const saved=db.prepare("SELECT source_id,source_revision,start_byte,end_byte FROM memory_evidence WHERE record_id=? AND record_version=1").all(id);
      const canonical=(rows:unknown[][])=>JSON.stringify(rows.map(row=>JSON.stringify(row)).sort());
      if(existing.text!==safeText || existing.state!=="candidate" || existing.scope_id!==scope ||
        canonical(saved.map(h=>[h.source_id,h.source_revision,h.start_byte,h.end_byte]))!==canonical(evidence.map(h=>[h.sourceId,h.revision,h.startByte,h.endByte])))throw new Error("MEMORY_IDEMPOTENCY_CONFLICT");
      return id;
    }
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'assistant-inference','candidate',0,?,NULL,NULL,?)").run(id,scope,safeText,Date.now(),Date.now());
    for (const h of evidence) db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,?,?,?)").run(id,h.sourceId,h.revision,h.startByte,h.endByte);
    return id;
  });
}

export function approveMemory(ticket: object, id: string, version: number, options: {pin?: boolean; scopeId?: string} = {}) {
  requireMemoryOwner(ticket);
  return transaction(db => {
    const record = db.prepare("SELECT * FROM memory_records WHERE id=? AND version=? AND state='candidate'").get(id,version);
    if (!record) throw new Error("MEMORY_VERSION_CONFLICT");
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    if (options.scopeId && options.scopeId !== record.scope_id) {
      if (!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(options.scopeId)) throw new Error("MEMORY_SCOPE_UNKNOWN");
      const copy = randomUUID();
      db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'owner-statement','active',?,?,NULL,NULL,?)").run(copy,options.scopeId,record.kind,record.text,options.pin?1:0,Date.now(),Date.now());
      db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(id,version,copy);
      return copy;
    }
    db.prepare("UPDATE memory_records SET state='active',owner_pinned=? WHERE id=? AND version=?").run(options.pin?1:0,id,version);
    return id;
  });
}

export function correctMemory(ticket: object, id: string, version: number, text: string) {
  requireMemoryOwner(ticket);
  if (!text.trim() || text.length > 4096) throw new Error("INVALID_MEMORY_TEXT");
  return transaction(db => {
    const row = db.prepare("SELECT * FROM memory_records WHERE id=? ORDER BY version DESC LIMIT 1").get(id);
    if (!row || row.version !== version || row.state === "deleted") throw new Error("MEMORY_VERSION_CONFLICT");
    db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(Date.now(),id,version);
    db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,'owner-statement','active',?,?,NULL,?,?)")
      .run(id,version+1,row.scope_id,row.kind,redactSecretsInText(text),row.owner_pinned,Date.now(),id,Date.now());
    db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,?)").run(id,version,id,version+1);
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'").run();
    return version+1;
  });
}

export function pinMemory(ticket: object, id: string, version: number, pinned: boolean) {
  requireMemoryOwner(ticket);
  transaction(db => {
    const result = db.prepare("UPDATE memory_records SET owner_pinned=? WHERE id=? AND version=? AND state='active'").run(pinned?1:0,id,version);
    if (!result.changes) throw new Error("MEMORY_VERSION_CONFLICT");
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
  });
}

export function bindMemoryScope(ticket: object, scopeId: string, subjectType: "bot" | "room", subjectId: string) {
  requireMemoryOwner(ticket);
  transaction(db => {
    if (!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(scopeId)) throw new Error("MEMORY_SCOPE_UNKNOWN");
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,?,?,?,'granted','{}')").run(randomUUID(),scopeId,subjectType,subjectId,Number(database().prepare("SELECT policy_revision FROM memory_meta").get()?.policy_revision));
  });
}

/** Rename identity only as part of an owner-reviewed roster rename operation. */
export function renameMemoryTeam(ticket: object, oldName: string, newName: string) {
  requireMemoryOwner(ticket);
  const from = oldName.trim(), to = newName.trim();
  if (from === to) return;
  transaction(db => {
    if (db.prepare("SELECT 1 FROM memory_scopes WHERE kind='team' AND owner_key=?").get(to)) throw new Error("MEMORY_TEAM_EXISTS");
    const changed = db.prepare("UPDATE memory_scopes SET owner_key=?,revision=revision+1 WHERE kind='team' AND owner_key=?").run(to,from);
    if (!changed.changes) throw new Error("MEMORY_TEAM_UNKNOWN");
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    db.prepare("UPDATE memory_disclosures SET state='revoked' WHERE state!='revoked'").run();
  });
}
