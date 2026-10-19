-- Self-service round 7 (Astra SELFSERVICE6 #2, #5). A legacy power reservation (from before 0041) has no server_id, so the provider
-- could never be asked whether its server is up and the bounded release could never apply. Its server is recovered from the original
-- intent audit, matched on both the home and the reservation id (the intent's detail has carried serverId and reservation since the
-- reservation existed). Settlement repeats this at run time for any row still missing it, so no person ever clears a job by hand.
-- late_checked_at rotates the late-receipt checks of released reservations, updated on every attempt, so none starves.
ALTER TABLE cloud_home_jobs ADD COLUMN late_checked_at INTEGER;
UPDATE cloud_home_jobs SET server_id=(
  SELECT CASE WHEN json_valid(a.detail) THEN json_extract(a.detail, '$.serverId') END FROM selfservice_audit a
  WHERE a.home_id=cloud_home_jobs.home_id AND a.outcome='intent' AND a.action=cloud_home_jobs.ref
    AND (CASE WHEN json_valid(a.detail) THEN json_extract(a.detail, '$.reservation') END)=cloud_home_jobs.id
    AND (CASE WHEN json_valid(a.detail) THEN json_extract(a.detail, '$.serverId') END) IS NOT NULL
  ORDER BY a.at LIMIT 1)
WHERE kind='power' AND server_id IS NULL;
