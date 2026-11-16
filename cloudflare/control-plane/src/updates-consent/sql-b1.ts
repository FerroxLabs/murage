// Updates consent B1: the statements design v5.6.1 describes as "unchanged" in 3.3 and 3.6 but whose text is in no prepared file
// (handoff difference 3). Written from the 3.3 and 3.6 prose; each names its binds. The prepared ones stay in ./sql-design.

/** RS3c, the read clear of an address change on a receipt record (design v5.6.2 addendum "address change clears receipt reads"; B1 r3
 *  Astra M). Its WHERE is RS3's with the RQ gate widened from `pending` to `pending` or `refused`: a first delivery that would move the
 *  record if the target were allowed clears the record's proof whether the target is allowed or refused, so /status and /export by the
 *  old and the new receipt read the same in both cases. It writes no email, generation, nonce, event, token or outbox row, so G stays
 *  the only statement that mints, and a replay (no nonce of its own) clears nothing. proven_at goes with proof_minted_at (the schema
 *  CHECK ties them) and an opted-in row gets unproven_since, as RS3 would give it. Runs right after RQ, before RS1 to RS2b. */
export const RS3c = `UPDATE updates_consent SET proven_at=NULL, proof_minted_at=NULL,
unproven_since=CASE WHEN status='opted_in' THEN coalesce(unproven_since,?9) END, updated_at=?9
WHERE ?10 IS NOT NULL AND subject_id='receipt:'||?10 AND proof_minted_at IS NOT NULL AND ?8>answered_at AND (?10<>?2 OR email_key<>?4 OR email IS NOT ?3)
AND (?2=?10 OR NOT EXISTS (SELECT 1 FROM updates_consent x WHERE x.receipt_hash=?2))
AND NOT EXISTS (SELECT 1 FROM updates_retired_receipts r WHERE r.receipt_hash=?2)
AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome IN ('pending','refused'))`;

/** PV3, the consent event of a proof. ?2 now, ?4 the consume nonce PV1 set (PV2 wrote it to the row). */
export const PV3 = `INSERT INTO updates_consent_events (consent_id,at,from_status,to_status,generation,text_version,actor)
SELECT id,?2,'opted_in','opted_in',generation,text_version,'prove' FROM updates_consent WHERE mut_nonce=?4 AND proven_at=?2`;

/** W1, withdraw by subject (receipt, or the account for AF): own row only, generation moved, no exclusion event (3.3 W).
 *  ?1 subject_id, ?2 now, ?3 a fresh nonce. A repeated withdraw moves the generation again (test 9). */
export const W1 = `UPDATE updates_consent SET status='withdrawn', off_by='owner', generation=generation+1, proven_at=NULL, unproven_since=NULL,
mut_nonce=?3, status_changed_at=?2, updated_at=?2 WHERE subject_id=?1`;
/** W2, every prove token of the row. */
export const W2 = `DELETE FROM updates_tokens WHERE purpose='prove' AND consent_id=(SELECT id FROM updates_consent WHERE mut_nonce=?3)`;
/** W3, its queued mail. */
export const W3 = `UPDATE updates_mail_outbox SET state='dropped', done_at=?2 WHERE state='queued' AND consent_id=(SELECT id FROM updates_consent WHERE mut_nonce=?3)`;
/** W4, the consent event. ?4 actor ('owner' for /withdraw, 'account' for AF). */
export const W4 = `INSERT INTO updates_consent_events (consent_id,at,from_status,to_status,generation,text_version,actor)
SELECT id,?2,NULL,'withdrawn',generation,text_version,?4 FROM updates_consent WHERE mut_nonce=?3`;

/** SU2 to SU5, the site unsubscribe after SU1 and SU1b (3.3 SU): as U3 to U6, keyed by the address. ?1 email_key, ?2 now, ?3 a fresh nonce. */
export const SU2 = `UPDATE updates_consent SET status='withdrawn', off_by='site', generation=generation+1, proven_at=NULL, unproven_since=NULL,
mut_nonce=?3||':'||id, status_changed_at=?2, updated_at=?2 WHERE status='opted_in' AND email_key=?1`;
export const SU3 = `DELETE FROM updates_tokens WHERE purpose='prove' AND email_key=?1`;
export const SU4 = `UPDATE updates_mail_outbox SET state='dropped', done_at=?2 WHERE state='queued' AND consent_id IN (SELECT id FROM updates_consent WHERE email_key=?1)`;
export const SU5 = `INSERT INTO updates_consent_events (consent_id,at,from_status,to_status,generation,text_version,actor)
SELECT id,?2,'opted_in','withdrawn',generation,text_version,'site' FROM updates_consent WHERE mut_nonce LIKE ?3||':%'`;

/** O2 settles a claimed row. ?1 outbox id, ?2 the claim nonce, ?3 'sent' or 'uncertain', ?4 now. */
export const O2 = `UPDATE updates_mail_outbox SET state=?3, done_at=?4 WHERE id=?1 AND claim_nonce=?2 AND state='sending'`;
/** O3 moves a `sending` row past `claimed_until` to `uncertain`; it is never sent again. ?1 now. */
export const O3 = `UPDATE updates_mail_outbox SET state='uncertain', done_at=?1 WHERE state='sending' AND claimed_until<?1`;
/** The queued rows the cron tries, oldest first. ?1 limit. */
export const OPICK = `SELECT id FROM updates_mail_outbox WHERE state='queued' ORDER BY created_at LIMIT ?1`;
/** What the sender needs after a claim: template, address, and the token ids to rebuild (3.4). ?1 outbox id, ?2 claim nonce. */
export const OMAIL = `SELECT m.template AS template, c.email AS email FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id
WHERE m.id=?1 AND m.claim_nonce=?2 AND m.state='sending'`;

/** The status read by receipt (4.1). ?1 subject_id. Only a row whose mailbox was proven is shown (`proof_minted_at` is set by PV and
 *  cleared by every re-submit, never by a withdraw): before proof the answer is the unknown-receipt one, so an address the RQ refuses and an
 *  allowed one answer the same (B1 r2 Astra M, the blocked-address oracle; design v5.6.2 addendum "receipt reads before proof"). */
export const STATUS = `SELECT status, proven_at IS NOT NULL AS proven, off_by FROM updates_consent WHERE subject_id=?1 AND proof_minted_at IS NOT NULL`;
/** The export reads by receipt (3.6): the row's consent fields, then its events, both only after mailbox proof (as STATUS). ?1 subject_id. */
export const EXPORT_CONSENT = `SELECT id, status, generation, text_version, answered_at, proven_at, off_by, source, app_version, created_at, status_changed_at
FROM updates_consent WHERE subject_id=?1 AND proof_minted_at IS NOT NULL`;
export const EXPORT_EVENTS_PROVEN = `SELECT e.at, e.from_status, e.to_status, e.generation, e.text_version, e.actor FROM updates_consent_events e
JOIN updates_consent c ON c.id=e.consent_id WHERE c.subject_id=?1 AND c.proof_minted_at IS NOT NULL ORDER BY e.id`;
/** The members history read (signed in, by account; not gated on proof). ?1 subject_id. */
export const EXPORT_EVENTS = `SELECT e.at, e.from_status, e.to_status, e.generation, e.text_version, e.actor FROM updates_consent_events e
JOIN updates_consent c ON c.id=e.consent_id WHERE c.subject_id=?1 ORDER BY e.id`;
