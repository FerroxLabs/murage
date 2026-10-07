// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure database reconciliation, also used by offline deletion and restore.
import type { DatabaseSync } from "node:sqlite";
import { admissibleSentenceRanges, claimsCompatible, parseAuthoredStatement } from "./pip-claims.ts";
import { pipCounterId } from "./pip-kinds.ts";

export interface StanceEvent { verdict: "reinforce" | "contradict" | "related"; handle: { sourceId: string; revision: number; start: number; end: number } }
export interface StanceBinding { support: Record<string, string[]>; events?: Record<string, Record<string, StanceEvent>> }

/** One current stance per target, generation and occasion. Exclusion is reversible;
 * deleted or edited source revisions cease contributing immediately. */
export function reconcilePipStances(db: DatabaseSync, onlyBot?: string) {
  for (const row of db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_id='pip-stance'").all()) {
    const botId = String(row.id).slice("pip-stance:".length);
    if (onlyBot && botId !== onlyBot) continue;
    const stance = JSON.parse(String(row.intent)) as StanceBinding;
    const reflect = db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get("pip-reflect:" + botId);
    const excluded: string[] = reflect ? JSON.parse(String(reflect.intent)).excludedThreads ?? [] : [];
    let changed = false;
    // Older bindings stored only support IDs. Recover their host-admissible spans
    // and the counter's revision-bound handles before replacing either set.
    const counters = db.prepare("SELECT r.id,r.version,d.entities FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version JOIN memory_scopes s ON s.id=r.scope_id WHERE s.kind='bot' AND s.owner_key=? AND r.kind='pip-counter' AND r.state='active'").all(botId);
    const keys = new Set(Object.keys(stance.support));
    for (const counter of counters) { const e: string[] = JSON.parse(String(counter.entities)); keys.add(`${e[0]}#${Number(e.find(x => x.startsWith("gen:"))?.slice(4) ?? 0)}`); }
    for (const key of keys) {
      if (stance.events?.[key]) continue;
      const events: Record<string, StanceEvent> = ((stance.events ??= {})[key] = {});
      const split = key.lastIndexOf("#"), targetId = key.slice(0, split);
      const target = db.prepare("SELECT text FROM memory_records WHERE id=? AND state='active'").get(targetId);
      const claim = target ? parseAuthoredStatement(String(target.text)) : null;
      for (const sourceId of stance.support[key] ?? []) {
        const source = db.prepare("SELECT s.revision,v.payload FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision WHERE s.id=?").get(sourceId);
        if (!source || !claim) continue;
        const span = admissibleSentenceRanges(String(JSON.parse(String(source.payload)).text ?? "")).find(s => s.result.ok && s.result.production !== "RETRACT" && claimsCompatible(claim, s.result.claim));
        if (span) events[sourceId] = { verdict: "reinforce", handle: { sourceId, revision: Number(source.revision), start: span.start, end: span.end } };
      }
      const counter = counters.find(c => c.id === pipCounterId(targetId, Number(key.slice(split + 1))));
      if (counter) for (const h of db.prepare("SELECT * FROM memory_evidence WHERE record_id=? AND record_version=?").all(String(counter.id), Number(counter.version))) {
        const sourceId = String(h.source_id);
        events[sourceId] = { verdict: "contradict", handle: { sourceId, revision: Number(h.source_revision), start: Number(h.start_byte), end: Number(h.end_byte) } };
      }
      changed = true;
    }
    for (const [key, events] of Object.entries(stance.events ?? {})) {
      const split = key.lastIndexOf("#"), targetId = key.slice(0, split), gen = Number(key.slice(split + 1));
      const target = db.prepare("SELECT r.*,d.entities FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.id=? AND r.state='active'").get(targetId);
      if (!target || Number((JSON.parse(String(target.entities)) as string[]).find(e => e.startsWith("gen:"))?.slice(4) ?? 0) !== gen) continue;
      const eligible = Object.values(events).filter(e => {
        const h = e.handle, src = db.prepare("SELECT state,revision,thread_id FROM memory_sources WHERE id=?").get(h.sourceId);
        return src?.state === "active" && Number(src.revision) === h.revision && !db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(h.sourceId, h.revision);
      });
      const live = eligible.filter(e => !excluded.includes(String(db.prepare("SELECT thread_id FROM memory_sources WHERE id=?").get(e.handle.sourceId)?.thread_id)));
      const support = live.filter(e => e.verdict === "reinforce").map(e => e.handle.sourceId);
      if (JSON.stringify(stance.support[key] ?? []) !== JSON.stringify(support)) { stance.support[key] = support; changed = true; }
      const opposing = live.filter(e => e.verdict === "contradict"), occasions = opposing.slice(0, 64).map(e => e.handle.sourceId);
      const cid = pipCounterId(targetId, gen);
      const counter = db.prepare("SELECT r.*,d.entities,d.confidence_basis FROM memory_records r JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.id=? ORDER BY r.version DESC LIMIT 1").get(cid);
      if (!counter) continue;
      const old: string[] = JSON.parse(String(counter.entities)), kept = old.filter(e => e.startsWith("kept:") && eligible.some(event => event.handle.sourceId === e.slice(5)));
      const entities = [targetId, `gen:${gen}`, ...occasions.map(o => `occ:${o}`), ...kept, ...(opposing.length > 64 ? ["saturated"] : [])];
      if (counter.state === "active" && JSON.stringify(old) !== JSON.stringify(entities)) {
        const version = Number(counter.version) + 1, now = Date.now();
        db.prepare("UPDATE memory_records SET state='superseded',valid_to=? WHERE id=? AND version=?").run(now, cid, Number(counter.version));
        db.prepare("INSERT INTO memory_records VALUES(?,?,?,?,?,?,'active',0,?,NULL,?,?)").run(cid, version, String(counter.scope_id), "pip-counter", String(counter.text), "assistant-inference", now, cid, now);
        db.prepare("UPDATE memory_record_details SET partition='identity',attention='current',confidence_basis=?,entities=? WHERE record_id=? AND record_version=?").run(String(counter.confidence_basis), JSON.stringify(entities), cid, version);
        for (const e of opposing.slice(0, 64)) { const h = e.handle; db.prepare("INSERT OR IGNORE INTO memory_evidence VALUES(?,?,?,?,?,?)").run(cid, version, h.sourceId, h.revision, h.start, h.end); }
        changed = true;
      }
      const disputed = opposing.length > 64 || occasions.filter(o => !kept.includes(`kept:${o}`)).length >= Math.max(5, Math.ceil(0.3 * support.length));
      db.prepare("UPDATE memory_record_details SET claim_status=? WHERE record_id=? AND record_version=?").run(disputed ? "disputed" : "current", targetId, Number(target.version));
    }
    if (changed) {
      db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(stance), String(row.id));
      db.prepare("DELETE FROM memory_scope_bindings WHERE id=?").run("pip-render:" + botId);
    }
  }
}
