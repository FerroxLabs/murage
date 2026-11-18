// GENERATED from the prepared design SQL (UPDATES-CONSENT-1020-CP-v5.md v5.6.1): stmts561.sql (FL1-FL3), stmts56.sql (G, RO, O1, O1b, OQ),
// stmts55-v561.sql (the v5.5 set without K6), stmts53.sql (PV1, PV2, PV4, SU1, SU1b). Text is byte-for-byte the prepared statement minus
// EXPLAIN, leading indentation and the trailing semicolon. Do not edit by hand: the scenario checks ran on exactly this text.
// Bind numbers are the design's one bind scheme (3.3); ?19 and ?31 are unused.

/** RQ (stmts55-v561.sql) */
export const RQ = `INSERT INTO updates_requests (request_id,path,subject_id,email_key,payload_hash,nonce,at,outcome)
SELECT ?24,?25,?33,?4,?34,?17,?9,
CASE WHEN EXISTS (SELECT 1 FROM updates_exclusion_events e WHERE e.email_key=?4 AND (e.kind IN ('erase','complaint','bounce')
OR (e.kind IN ('resend_unsub','sendlane_global') AND NOT EXISTS (SELECT 1 FROM updates_exclusion_events y WHERE y.email_key=e.email_key AND y.kind='cleared' AND y.observed_at>e.observed_at))))
THEN 'refused' ELSE 'pending' END
ON CONFLICT(request_id) DO NOTHING`;

/** RJ (stmts55-v561.sql) */
export const RJ = `INSERT INTO updates_requests (request_id,path,subject_id,email_key,payload_hash,nonce,at,outcome) VALUES (?24,?25,NULL,NULL,?34,?17,?9,'invalid') ON CONFLICT(request_id) DO NOTHING`;

/** RJQ (stmts55-v561.sql) */
export const RJQ = `SELECT outcome, payload_hash=?34 AS same_payload FROM updates_requests WHERE request_id=?24`;

/** FL1 (stmts561.sql) */
export const FL1 = `INSERT INTO announcement_rate_limits (subject_key,window_started_at,attempts,updated_at)
SELECT ?26,?9,1,?9 WHERE EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome IN ('pending','refused'))
ON CONFLICT(subject_key) DO UPDATE SET window_started_at=CASE WHEN window_started_at<=?27 THEN excluded.window_started_at ELSE window_started_at END,
attempts=CASE WHEN window_started_at<=?27 THEN 1 ELSE attempts+1 END, updated_at=excluded.updated_at
WHERE window_started_at<=?27 OR attempts<?28`;

/** FL2 (stmts561.sql) */
export const FL2 = `INSERT INTO announcement_rate_limits (subject_key,window_started_at,attempts,updated_at)
SELECT ?29,?9,1,?9 WHERE changes()=1 AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome IN ('pending','refused'))
ON CONFLICT(subject_key) DO UPDATE SET window_started_at=CASE WHEN window_started_at<=?32 THEN excluded.window_started_at ELSE window_started_at END,
attempts=CASE WHEN window_started_at<=?32 THEN 1 ELSE attempts+1 END, updated_at=excluded.updated_at
WHERE window_started_at<=?32 OR attempts<?30`;

/** FL3 (stmts561.sql) */
export const FL3 = `UPDATE updates_requests SET outcome='rate_limited' WHERE nonce=?17 AND outcome IN ('pending','refused') AND changes()=0`;

/** FS0 (stmts55-v561.sql) */
export const FS0 = `INSERT INTO announcement_consents (email_key,source,consent_text,list_id,created_at)
SELECT ?4,?21,?22,NULL,?9 WHERE ?21 IS NOT NULL AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')`;

/** FS1 (stmts55-v561.sql) */
export const FS1 = `INSERT INTO updates_consent (id,kind,subject_id,email,email_key,status,generation,unproven_since,consented_at,mut_nonce,text_version,app_version,source,site_consent_id,answered_at,status_changed_at,created_at,updated_at)
SELECT ?1,'signup',?33,?3,?4,'opted_in',1,?9,?9,?17,?5,?7,?23,
CASE WHEN ?21 IS NOT NULL THEN (SELECT max(a.id) FROM announcement_consents a WHERE a.email_key=?4 AND a.created_at=?9) END,?8,?9,?9,?9
WHERE EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')
ON CONFLICT(subject_id) DO NOTHING`;

/** FS2 (stmts55-v561.sql) */
export const FS2 = `UPDATE updates_consent SET status='opted_in', email=?3, off_by=NULL, generation=generation+1, proven_at=NULL, proof_minted_at=NULL, unproven_since=?9, consented_at=?9, mut_nonce=?17,
text_version=?5, app_version=?7, answered_at=?8, status_changed_at=?9, updated_at=?9,
site_consent_id=CASE WHEN ?21 IS NOT NULL THEN (SELECT max(a.id) FROM announcement_consents a WHERE a.email_key=?4 AND a.created_at=?9) END
WHERE subject_id=?33 AND status='withdrawn' AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')`;

/** FS2b (stmts55-v561.sql, plus the v5.6.2 generation guard `AND mut_nonce IS NOT ?17`: a row FS1 or FS2 already moved in this batch
 *  is not moved again; MurageMain approved, B1 r1 Grok M1 / Astra L) */
export const FS2b = `UPDATE updates_consent SET email=?3, generation=generation+1, proven_at=NULL, proof_minted_at=NULL,
unproven_since=CASE WHEN proven_at IS NULL THEN unproven_since ELSE ?9 END, consented_at=?9, mut_nonce=?17,
text_version=?5, app_version=?7, answered_at=?8, status_changed_at=?9, updated_at=?9,
site_consent_id=CASE WHEN ?21 IS NOT NULL THEN (SELECT max(a.id) FROM announcement_consents a WHERE a.email_key=?4 AND a.created_at=?9) END
WHERE subject_id=?33 AND status='opted_in' AND mut_nonce IS NOT ?17 AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')
AND (EXISTS (SELECT 1 FROM updates_exclusion_events o WHERE o.email_key=?4 AND o.kind NOT IN ('erase','complaint','bounce')
AND (o.observed_at>=updates_consent.consented_at OR o.observed_at>=updates_consent.proof_minted_at))
OR (proven_at IS NULL AND NOT EXISTS (SELECT 1 FROM updates_obligations ob JOIN updates_tokens t ON t.token_hash=ob.token_hash
WHERE ob.consent_id=updates_consent.id AND ob.generation=updates_consent.generation AND t.used_at IS NULL AND t.expires_at>?9 AND t.key_version=?12)))`;

/** FS4 (stmts55-v561.sql) */
export const FS4 = `INSERT INTO updates_consent_events (consent_id,at,from_status,to_status,generation,text_version,actor)
SELECT id,?9,NULL,'opted_in',generation,text_version,'signup' FROM updates_consent WHERE mut_nonce=?17`;

/** RS1 (stmts55-v561.sql) */
export const RS1 = `INSERT INTO updates_consent (id,kind,subject_id,receipt_hash,email,email_key,status,generation,unproven_since,consented_at,mut_nonce,text_version,install_id,app_version,source,answered_at,status_changed_at,created_at,updated_at)
SELECT ?1,'receipt',?33,?2,?3,?4,'opted_in',1,?9,?9,?17,?5,?6,?7,'desktop',?8,?9,?9,?9 WHERE (?10 IS NULL OR ?10=?2)
AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')
AND NOT EXISTS (SELECT 1 FROM updates_retired_receipts r WHERE r.receipt_hash=?2)
ON CONFLICT(subject_id) DO NOTHING`;

/** RS2 (stmts55-v561.sql) */
export const RS2 = `UPDATE updates_consent SET status='opted_in', email=?3, off_by=NULL, generation=generation+1, proven_at=NULL, proof_minted_at=NULL, unproven_since=?9, consented_at=?9, mut_nonce=?17,
text_version=?5, app_version=?7, answered_at=?8, status_changed_at=?9, updated_at=?9
WHERE subject_id=?33 AND (?10 IS NULL OR ?10=?2) AND status='withdrawn' AND email_key=?4 AND ?8>answered_at
AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')`;

/** RS3 (stmts55-v561.sql) */
export const RS3 = `UPDATE updates_consent SET subject_id='receipt:'||?2, receipt_hash=?2, email=?3, email_key=?4, status='opted_in', off_by=NULL, generation=generation+1,
proven_at=NULL, proof_minted_at=NULL, unproven_since=?9, consented_at=?9, mut_nonce=?17, name=NULL, text_version=?5, app_version=?7, answered_at=?8, status_changed_at=?9, updated_at=?9
WHERE ?10 IS NOT NULL AND subject_id='receipt:'||?10 AND ?8>answered_at AND (?10<>?2 OR email_key<>?4 OR email IS NOT ?3)
AND (?2=?10 OR NOT EXISTS (SELECT 1 FROM updates_consent x WHERE x.receipt_hash=?2))
AND NOT EXISTS (SELECT 1 FROM updates_retired_receipts r WHERE r.receipt_hash=?2)
AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')`;

/** RS3r (stmts55-v561.sql) */
export const RS3r = `INSERT INTO updates_retired_receipts (receipt_hash,consent_id,at) SELECT ?10,id,?9 FROM updates_consent WHERE mut_nonce=?17 AND ?10 IS NOT NULL AND ?10<>?2
ON CONFLICT(receipt_hash) DO NOTHING`;

/** RS2b (stmts55-v561.sql) */
export const RS2b = `UPDATE updates_consent SET email=?3, generation=generation+1, proven_at=NULL, proof_minted_at=NULL,
unproven_since=CASE WHEN proven_at IS NULL THEN unproven_since ELSE ?9 END, consented_at=?9, mut_nonce=?17,
text_version=?5, app_version=?7, answered_at=?8, status_changed_at=?9, updated_at=?9
WHERE subject_id=?33 AND (?10 IS NULL OR ?10=?2) AND status='opted_in' AND email_key=?4 AND ?8>answered_at
AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')
AND (EXISTS (SELECT 1 FROM updates_exclusion_events o WHERE o.email_key=?4 AND o.kind NOT IN ('erase','complaint','bounce')
AND (o.observed_at>=updates_consent.consented_at OR o.observed_at>=updates_consent.proof_minted_at))
OR (proven_at IS NULL AND NOT EXISTS (SELECT 1 FROM updates_obligations ob JOIN updates_tokens t ON t.token_hash=ob.token_hash
WHERE ob.consent_id=updates_consent.id AND ob.generation=updates_consent.generation AND t.used_at IS NULL AND t.expires_at>?9 AND t.key_version=?12)))`;

/** RS4 (stmts55-v561.sql) */
export const RS4 = `INSERT INTO updates_consent_events (consent_id,at,from_status,to_status,generation,text_version,actor)
SELECT id,?9,NULL,'opted_in',generation,text_version,'receipt' FROM updates_consent WHERE mut_nonce=?17`;

/** AO1 (stmts55-v561.sql) */
export const AO1 = `INSERT INTO updates_consent (id,kind,subject_id,account_id,email,email_key,status,generation,proven_at,proof_minted_at,unproven_since,consented_at,mut_nonce,text_version,app_version,source,answered_at,status_changed_at,created_at,updated_at)
SELECT ?1,'account',?33,?2,?3,?4,'opted_in',1,
CASE WHEN ev.n=0 THEN ?9 END, CASE WHEN ev.n=0 THEN 0 END, CASE WHEN ev.n=0 THEN NULL ELSE ?9 END, ?9,
?17,?5,'site','site',?8,?9,?9,?9
FROM supabase_identities i, (SELECT count(*) AS n FROM updates_exclusion_events x WHERE x.email_key=?4) ev
WHERE i.user_id=?2 AND lower(trim(i.contact_email))=?3 AND i.email_revision=?35 AND i.email_conflict IS NULL
AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')
ON CONFLICT(subject_id) DO UPDATE SET email=excluded.email, email_key=excluded.email_key, status='opted_in', off_by=NULL,
proven_at=excluded.proven_at, proof_minted_at=excluded.proof_minted_at,
unproven_since=CASE WHEN updates_consent.status='opted_in' AND updates_consent.proven_at IS NULL AND updates_consent.email_key=excluded.email_key THEN updates_consent.unproven_since ELSE excluded.unproven_since END,
consented_at=excluded.consented_at, mut_nonce=excluded.mut_nonce, generation=generation+1, text_version=excluded.text_version,
answered_at=excluded.answered_at, status_changed_at=excluded.status_changed_at, updated_at=excluded.updated_at
WHERE status='withdrawn' OR email_key<>excluded.email_key
OR EXISTS (SELECT 1 FROM updates_exclusion_events o WHERE o.email_key=excluded.email_key AND o.kind NOT IN ('erase','complaint','bounce')
AND (o.observed_at>=updates_consent.consented_at OR o.observed_at>=updates_consent.proof_minted_at))
OR (updates_consent.proven_at IS NULL AND NOT EXISTS (SELECT 1 FROM updates_obligations ob JOIN updates_tokens t ON t.token_hash=ob.token_hash
WHERE ob.consent_id=updates_consent.id AND ob.generation=updates_consent.generation AND t.used_at IS NULL AND t.expires_at>?9 AND t.key_version=?12))`;

/** AO2 (stmts55-v561.sql) */
export const AO2 = `INSERT INTO updates_consent_events (consent_id,at,from_status,to_status,generation,text_version,actor)
SELECT id,?9,NULL,'opted_in',generation,text_version,'account' FROM updates_consent WHERE mut_nonce=?17`;

/** G (stmts56.sql) */
export const G = `INSERT INTO updates_obligations (consent_id,generation,email_key,request_id,nonce,template,outbox_id,token_hash,at)
SELECT c.id,c.generation,c.email_key,?24,?17,CASE WHEN ?20=1 THEN 'guide_prove' ELSE ?18 END,?14,?11,?9
FROM updates_consent c
WHERE c.subject_id=?33 AND c.email_key=?4 AND c.email=?3 AND c.status='opted_in' AND c.proven_at IS NULL AND ?9 < c.unproven_since + 2592000000
AND c.mut_nonce=?17
AND EXISTS (SELECT 1 FROM updates_requests q WHERE q.nonce=?17 AND q.outcome='pending')
AND (c.kind<>'account' OR EXISTS (SELECT 1 FROM supabase_identities i WHERE i.user_id=c.account_id AND i.email_conflict IS NULL AND lower(trim(i.contact_email))=c.email))
AND NOT EXISTS (SELECT 1 FROM updates_obligations o WHERE o.consent_id=c.id AND o.generation=c.generation)
AND NOT EXISTS (SELECT 1 FROM updates_exclusion_events e WHERE e.email_key=c.email_key
AND (e.kind IN ('erase','complaint','bounce') OR e.observed_at>=c.consented_at
OR (e.kind IN ('resend_unsub','sendlane_global') AND NOT EXISTS (SELECT 1 FROM updates_exclusion_events y WHERE y.email_key=e.email_key AND y.kind='cleared' AND y.observed_at>e.observed_at))))
AND NOT EXISTS (SELECT 1 FROM announcement_rate_limits r WHERE r.subject_key=?15 AND r.window_started_at>?16 AND r.attempts>=3)`;

/** GC (stmts55-v561.sql) */
export const GC = `INSERT INTO announcement_rate_limits (subject_key,window_started_at,attempts,updated_at)
SELECT ?15,?9,1,?9 WHERE EXISTS (SELECT 1 FROM updates_obligations o WHERE o.nonce=?17)
ON CONFLICT(subject_key) DO UPDATE SET window_started_at=CASE WHEN window_started_at<=?16 THEN excluded.window_started_at ELSE window_started_at END,
attempts=CASE WHEN window_started_at<=?16 THEN 1 ELSE attempts+1 END, updated_at=excluded.updated_at`;

/** GT (stmts55-v561.sql) */
export const GT = `INSERT INTO updates_tokens (token_hash,token_id,purpose,consent_id,email_key,generation,key_version,expires_at,used_at,consume_nonce,created_at)
SELECT o.token_hash,'prove:'||o.outbox_id,'prove',o.consent_id,o.email_key,o.generation,?12,min(?13, c.unproven_since + 3196800000),NULL,NULL,?9
FROM updates_obligations o JOIN updates_consent c ON c.id=o.consent_id WHERE o.nonce=?17`;

/** GO (stmts55-v561.sql) */
export const GO = `INSERT INTO updates_mail_outbox (id,consent_id,generation,template,token_hash,key_version,state,created_at)
SELECT o.outbox_id,o.consent_id,o.generation,o.template,o.token_hash,?12,'queued',?9 FROM updates_obligations o WHERE o.nonce=?17`;

/** GD (stmts55-v561.sql) */
export const GD = `UPDATE updates_mail_outbox SET state='dropped', done_at=?9
WHERE state='queued' AND consent_id=(SELECT consent_id FROM updates_obligations WHERE nonce=?17) AND id<>(SELECT outbox_id FROM updates_obligations WHERE nonce=?17)`;

/** RO (stmts56.sql) */
export const RO = `UPDATE updates_requests SET outcome=CASE
WHEN EXISTS (SELECT 1 FROM updates_obligations o WHERE o.nonce=updates_requests.nonce) THEN 'admitted'
WHEN EXISTS (SELECT 1 FROM updates_consent c WHERE c.subject_id=updates_requests.subject_id AND c.mut_nonce=updates_requests.nonce AND c.status='opted_in' AND c.proven_at IS NULL
AND NOT EXISTS (SELECT 1 FROM updates_obligations o WHERE o.consent_id=c.id AND o.generation=c.generation)
AND EXISTS (SELECT 1 FROM announcement_rate_limits r WHERE r.subject_key=?15 AND r.window_started_at>?16 AND r.attempts>=3)) THEN 'capped'
ELSE 'noop' END
WHERE nonce=?17 AND outcome='pending'`;

/** RQQ (stmts55-v561.sql) */
export const RQQ = `SELECT outcome FROM updates_requests WHERE request_id=?24`;

/** AOQ (stmts55-v561.sql) */
export const AOQ = `SELECT (SELECT count(*) FROM updates_obligations o JOIN updates_tokens t ON t.token_hash=o.token_hash
WHERE o.consent_id=c.id AND o.generation=c.generation AND t.used_at IS NULL AND t.expires_at>?9 AND t.key_version=?12)
FROM updates_consent c WHERE c.subject_id=?33 AND c.status='opted_in' AND c.proven_at IS NULL`;

/** PV1 (stmts53.sql) */
export const PV1 = `UPDATE updates_tokens SET used_at=?2, consume_nonce=?4 WHERE token_hash=?1 AND purpose='prove' AND used_at IS NULL AND expires_at>?2 AND key_version=?3
AND EXISTS (SELECT 1 FROM updates_consent c WHERE c.id=updates_tokens.consent_id AND c.generation=updates_tokens.generation AND c.email_key=updates_tokens.email_key AND c.status='opted_in')
AND NOT EXISTS (SELECT 1 FROM updates_exclusion_events e WHERE e.email_key=updates_tokens.email_key AND e.observed_at>=updates_tokens.created_at)`;

/** PV2 (stmts53.sql) */
export const PV2 = `UPDATE updates_consent SET proven_at=?2, proof_minted_at=(SELECT created_at FROM updates_tokens WHERE consume_nonce=?4), unproven_since=NULL, mut_nonce=?4, updated_at=?2
WHERE proven_at IS NULL AND id=(SELECT consent_id FROM updates_tokens WHERE consume_nonce=?4)`;

/** PV4 (stmts53.sql) */
export const PV4 = `INSERT INTO updates_reconsent_audit (email_key,old_event_id,old_kind,old_observed_at,consent_id,at)
SELECT e.email_key,e.id,e.kind,e.observed_at,c.id,?2 FROM updates_consent c JOIN updates_exclusion_events e ON e.email_key=c.email_key
WHERE c.mut_nonce=?4 AND e.kind IN ('our_unsub','list37','cleared') AND e.observed_at<c.proof_minted_at`;

/** U1 (stmts55-v561.sql) */
export const U1 = `UPDATE updates_tokens SET used_at=?2, consume_nonce=?4 WHERE token_hash=?1 AND purpose='unsub' AND used_at IS NULL`;

/** U2 (stmts55-v561.sql) */
export const U2 = `INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) SELECT email_key,'our_unsub',?2,?6,NULL,?2 FROM updates_tokens WHERE consume_nonce=?4`;

/** U3 (stmts55-v561.sql) */
export const U3 = `UPDATE updates_consent SET status='withdrawn', off_by='link', generation=generation+1, proven_at=NULL, unproven_since=NULL, mut_nonce=?4||':'||id, status_changed_at=?2, updated_at=?2
WHERE status='opted_in' AND email_key=(SELECT email_key FROM updates_tokens WHERE consume_nonce=?4)`;

/** U4 (stmts55-v561.sql) */
export const U4 = `DELETE FROM updates_tokens WHERE purpose='prove' AND email_key=(SELECT email_key FROM updates_tokens WHERE consume_nonce=?4)`;

/** U5 (stmts55-v561.sql) */
export const U5 = `UPDATE updates_mail_outbox SET state='dropped', done_at=?2 WHERE state='queued' AND consent_id IN (SELECT id FROM updates_consent WHERE mut_nonce LIKE ?4||':%')`;

/** U6 (stmts55-v561.sql) */
export const U6 = `INSERT INTO updates_consent_events (consent_id,at,from_status,to_status,generation,text_version,actor)
SELECT id,?2,'opted_in','withdrawn',generation,text_version,?6 FROM updates_consent WHERE mut_nonce LIKE ?4||':%'`;

/** UQ (stmts55-v561.sql) */
export const UQ = `SELECT CASE WHEN EXISTS (SELECT 1 FROM updates_tokens WHERE token_hash=?1 AND purpose='unsub' AND used_at IS NOT NULL) THEN 1 ELSE 0 END`;

/** SU1 (stmts53.sql) */
export const SU1 = `INSERT INTO announcement_optouts (email_key,list_id,unsubscribed_at) SELECT ?1,l,?2 FROM (SELECT ?4 AS l UNION ALL SELECT ?5) WHERE l IS NOT NULL
ON CONFLICT(email_key,list_id) DO UPDATE SET unsubscribed_at=max(unsubscribed_at,excluded.unsubscribed_at)`;

/** SU1b (stmts53.sql) */
export const SU1b = `INSERT INTO updates_exclusion_events (email_key,kind,observed_at,source,ref,at) VALUES (?1,'our_unsub',?2,'site',NULL,?2)`;

/** O1 (stmts56.sql) */
export const O1 = `WITH v AS (SELECT CASE WHEN EXISTS (
SELECT 1 FROM updates_mail_outbox m
JOIN updates_consent c ON c.id=m.consent_id AND c.generation=m.generation
JOIN updates_tokens t ON t.token_hash=m.token_hash
JOIN updates_obligations o ON o.outbox_id=m.id
WHERE m.id=?1 AND m.state='queued' AND m.key_version=?4
AND c.status='opted_in' AND c.proven_at IS NULL
AND t.used_at IS NULL AND t.key_version=?4 AND t.expires_at>?3
AND NOT EXISTS (SELECT 1 FROM updates_exclusion_events e WHERE e.email_key=o.email_key
AND (e.kind IN ('erase','complaint','bounce') OR e.observed_at>=o.at
OR (e.kind IN ('resend_unsub','sendlane_global') AND NOT EXISTS (SELECT 1 FROM updates_exclusion_events y WHERE y.email_key=e.email_key AND y.kind='cleared' AND y.observed_at>e.observed_at))))
) THEN 1 ELSE 0 END AS ok)
UPDATE updates_mail_outbox SET
state=CASE WHEN (SELECT ok FROM v)=1 THEN 'sending' ELSE 'dropped' END,
claim_nonce=CASE WHEN (SELECT ok FROM v)=1 THEN ?2 ELSE NULL END,
claimed_until=CASE WHEN (SELECT ok FROM v)=1 THEN ?3+30000 ELSE NULL END,
done_at=CASE WHEN (SELECT ok FROM v)=1 THEN NULL ELSE ?3 END
WHERE id=?1 AND state='queued'`;

/** O1b (stmts56.sql) */
export const O1b = `INSERT INTO updates_tokens (token_hash,token_id,purpose,consent_id,email_key,generation,key_version,expires_at,used_at,consume_nonce,created_at)
SELECT ?5,'unsub:'||m.id,'unsub',NULL,c.email_key,NULL,?4,?3+34560000000,NULL,NULL,?3 FROM updates_mail_outbox m JOIN updates_consent c ON c.id=m.consent_id
WHERE changes()=1 AND m.id=?1 AND m.claim_nonce=?2 ON CONFLICT(token_id) DO NOTHING`;

/** OQ (stmts56.sql) */
export const OQ = `SELECT state, coalesce(claim_nonce=?2,0) FROM updates_mail_outbox WHERE id=?1`;
