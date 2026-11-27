// 1.0.23 q1023-denyrule (BUILD-PLAN R1): the read-time deny rule, in ONE place.
//
// Up to 1.0.22 the marker wrote one mark per object per revoke (memory_deny_memory, memory_deny_line). From 1.0.23 it writes a mark only
// where the object's place does not already say it (revoke-marker.ts lineNode, sourceNode, recordNode), and every reader asks here for
// the rest, under the SAME revoke ids:
//   - a source is withheld through its ANCHOR LINE (memory_sources.thread_id, message_id -> memory_line_lineage): an explicit point row at
//     that line (never a reply's hide mark, which is no revoke of the line's thread: revoke-commit.ts hideReplyLine), or, for a generated
//     line (one with a turn_lsn), a range row of its thread with from_lsn < lsn AND turn_lsn < until_turn_lsn (deny-read.ts lookupPage's
//     own line test);
//   - a record version is withheld through its EVIDENCE: any memory_evidence source of that version has an explicit object row (whole or at
//     the cited revision) or is withheld through its anchor line.
// Key seeks only: the source's primary key, the thread number, the (thread_no, message_id) index, the point rows of one line, the range
// rows of one thread below one lsn, the evidence rows of one record version. Nothing is written. A source with no thread, no message or no
// lineage row has no anchor and is judged by its explicit rows alone, as the marker wrote them (sourceNode: no anchor = an explicit row).
//
// Every reader builds its SQL from these fragments (deny-read.ts, readable.ts, import.ts, revoke-commit.ts, selfheal-1021.ts), so the
// paths cannot drift. Inner aliases start with `dz` so a fragment can sit inside any reader's statement.
import { AUDIENCE_COALESCED } from "./lineage-types.ts";

/** Explicit line rows (1.0.22: memory_deny_line). */
export const DENY_POINT = "memory_deny_point";
/** Explicit object rows (1.0.22: memory_deny_memory). */
export const DENY_OBJECT = "memory_deny_object";
/** Most raw rows one arm of a rule read returns; past it the caller's answer is "unknown" (-1), as the explicit-row reads do past 256. */
export const RULE_READ_LIMIT = 256;

const ANCHOR = "memory_sources dzs CROSS JOIN memory_thread_no dzt ON dzt.thread_id=dzs.thread_id CROSS JOIN memory_line_lineage dzl INDEXED BY memory_line_lineage_msg ON dzl.thread_no=dzt.no AND dzl.message_id=dzs.message_id";
/** One arm of a rule read. `capped` (every reader's verdict): at most RULE_READ_LIMIT + 1 rows, past which the answer is unknown.
 * Not capped (the write-time inheritance, revoke-commit.ts refRevokes): every revoke id, as its read of the explicit rows returns them,
 * so a child inherits each revoke its parent rests on and none is lost when another of them is undone. */
const armOf = (sql: string, capped: boolean) => capped ? `SELECT revoke_id FROM (${sql} LIMIT ${RULE_READ_LIMIT + 1})` : `SELECT revoke_id FROM (${sql})`;

/** The revoke ids (column revoke_id, one row per mark) that withhold source `source` (an SQL expression) through its anchor line. */
export function anchorRevokesSql(source: string, capped = true): string {
  const arm = (sql: string) => armOf(sql, capped);
  return `${arm(`SELECT dzp.revoke_id FROM ${ANCHOR} CROSS JOIN ${DENY_POINT} dzp ON dzp.thread_id=dzs.thread_id AND dzp.lsn=dzl.lsn WHERE dzs.id=${source} AND dzp.reason<>'hide-reply'`)}
    UNION ALL ${arm(`SELECT dzg.revoke_id FROM ${ANCHOR} CROSS JOIN memory_deny_range dzg ON dzg.thread_id=dzs.thread_id AND dzg.from_lsn<dzl.lsn AND dzl.turn_lsn<dzg.until_turn_lsn WHERE dzs.id=${source} AND dzl.turn_lsn IS NOT NULL`)}`;
}
/** The revoke ids that withhold record `id` at `version` (SQL expressions; version null = every version) through an evidence source: the
 * source's explicit object rows (whole, or at the revision the evidence cites) and its anchor line. One row per source and mark. */
export function evidenceRevokesSql(id: string, version: string | null, capped = true): string {
  const arm = (sql: string) => armOf(sql, capped);
  const ev = `(SELECT DISTINCT source_id AS s,source_revision AS r FROM memory_evidence WHERE record_id=${id}${version === null ? "" : ` AND record_version=${version}`}) dze`;
  const anchor = ANCHOR.replace("memory_sources dzs", `${ev} CROSS JOIN memory_sources dzs ON dzs.id=dze.s`);
  return `${arm(`SELECT dzo.revoke_id FROM ${ev} CROSS JOIN ${DENY_OBJECT} dzo ON dzo.kind='source' AND dzo.id=dze.s AND dzo.version IN (0,dze.r)`)}
    UNION ALL ${arm(`SELECT dzp.revoke_id FROM ${anchor} CROSS JOIN ${DENY_POINT} dzp ON dzp.thread_id=dzs.thread_id AND dzp.lsn=dzl.lsn WHERE dzp.reason<>'hide-reply'`)}
    UNION ALL ${arm(`SELECT dzg.revoke_id FROM ${anchor} CROSS JOIN memory_deny_range dzg ON dzg.thread_id=dzs.thread_id AND dzg.from_lsn<dzl.lsn AND dzl.turn_lsn<dzg.until_turn_lsn WHERE dzl.turn_lsn IS NOT NULL`)}`;
}
/** The reader class of a mark: a content reader (the owner's chat, memory recall) skips audience-only revokes and the coalesced audience
 * row (deny-read.ts NOT_AUDIENCE_ONLY, AUDIENCE_COALESCED), for the rule's rows as for the explicit ones. */
export const CONTENT_CLASS = `revoke_id NOT IN (SELECT revoke_id FROM memory_revoke_audience) AND revoke_id<>${AUDIENCE_COALESCED}`;
/** A scalar over rule rows `ids`: 1 = withheld for the class, 0 = not, -1 = more rows than one read takes (unknown: never shown). */
export function impliedSql(ids: string, content: boolean): string {
  return `(WITH dzc AS MATERIALIZED (${ids}) SELECT CASE WHEN max(${content ? CONTENT_CLASS : "1"}) THEN 1 WHEN count(*)>${RULE_READ_LIMIT} THEN -1 ELSE 0 END FROM dzc)`;
}
/** 1, 0 or -1: source `source` is withheld through its anchor line. */
export const sourceImpliedSql = (source: string, content: boolean): string => impliedSql(anchorRevokesSql(source), content);
/** 1, 0 or -1: record `id` at `version` (null: any version) is withheld through an evidence source. */
export const recordImpliedSql = (id: string, version: string | null, content: boolean): string => impliedSql(evidenceRevokesSql(id, version), content);
