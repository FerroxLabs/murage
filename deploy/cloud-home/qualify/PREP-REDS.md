# J5b r7 prep: RED record (base: home f734801fee, CP fe8af44a3a for the C tests)

Run with the jf2.sh pattern: one `--rm --network none` container, uid 2001, shared read-only node_modules. Python and Node run on home f734801fee. The CP tests run on a tree extracted with `git archive fe8af44a3a` (the CP line is not an ancestor of the home line) plus the 0158 draft migration, with the CP's own vitest. Updated from r6 to DESIGN-J5b-r7.md section 10 (all 9 delta items) and MurageMain's r7 rulings 7 and 8. Astra then disagreed with r7 (0 High, 5 Medium) and an r8 design is running: P25, T16, T4b and D5 are left as TODO-r8 and are not counted.

## Results at base

| Id | File | State | Reason (or why it is not counted) |
|---|---|---|---|
| P4b intake_runs_during_blocked_cp_call | deploy/cloud-home/murage-control_test.py | RED | no ACK file, no journal: no intake thread |
| P5b memory_only_retry_same_key (3 heartbeats) | same | RED | body 1 carries no K (base never offers an app item). The MU-82 half (body 2 carries no extended event) is base behavior and is PIN, not reached at base because body 1 fails first |
| P6b offered_ids_acked_first (700 retained, 512 in total) | same | RED | no ACK file |
| P7c reassigned_key_sent_only_after_durable_add | same | RED | G is never delivered at T+1 |
| P17 advertisement_before_first_intake | same | RED | the ACK file does not exist at the first probe |
| P18 dirty_bound_crash_resend_within_cp_window (30 and 31 dirty) | same | RED | 30 keys never accepted |
| P19 control_failure_slot_replaces | same | RED | no journal, no failure items |
| P20 partial_append_repaired_in_process | same | RED | nothing appended or ACKed |
| P21 overflow_record_cut (un-skipped; MU-64 only; barrier wait bounded, non-fatal) | same | RED | no ACK file after the restart |
| P21b overflow_append_fails_nothing_retired | same | RED | 63 entries never pend (no journal) |
| P22 flipped_byte_ends_the_valid_prefix | same | RED | no journal load |
| P23 strict_parser_on_fixture_bodies | same | RED | app_report keeps no homeEvents field |
| P24 sent_records_prefix_closed | same | RED | K never accepted |
| P25 ack_max_fits_real_writer | same | TODO-r8, skipped | Astra: 300 dirty acceptances against DIRTY_MAX 32 cannot be reached (the test uses the reachable 32) |
| P26 R-loss-1 control half (5 tests: all conditions, kind, millisecond, durable at control, no crash) | same | RED x5 | E1 never accepted (no channel at base). They PIN the bound once the channel exists; at base they cannot pass |
| P27 hold raises a failure item | same | RED | silent hold: base ignores outboxDegraded |
| P27 guard no hold, no alert | same | GREEN (guard) | no failure item without a hold |
| G-VEC record vectors (Python, was P24 in r6) | same | GREEN (guard) | CRC32 vectors incl. `done` tombstones read the same in both languages |
| T4b (2 tests) | server/cloud-home/home-events-channel.test.ts | TODO-r8, skipped | Astra: expects an overflow after a retirement |
| T5 drains degraded items (2) | same | RED x2 | drainHomeEvents is not provided |
| T7 counter by mode (2: behavior, index.ts pins) | same | RED x2 | no homeEvents with the advertisement; index.ts lacks the spread and the second noteRestoreAborted |
| T9, T10, T11, T12, T13 | same | RED x5 | no homeEvents served; T11 has no outbox fsync barrier |
| T14 retired_key_never_reused | same | RED | A is never served |
| T14c outbox compaction (128 tombstones per type) | same | RED | base leaves 300 tombstones |
| T15 retire_only_through_durable_done | same | RED | K is never served |
| T16 ACK reader maximum (5 tests) | same | TODO-r8, skipped | Astra: calls an export missing at base |
| T17 R-loss-1 app half (5 tests) | same | RED x5 | E1 never served. PIN of the bound once the channel exists |
| T18 hold is never silent (2: flag, healthy guard) | same | RED x2 | no homeEvents, no outboxDegraded |
| G-VEC (Node, 2 tests) | same | GREEN x2 (guards) | vectors and ACK fixtures |
| C3 clock step and prune by seq | cloudflare/control-plane/test/home-event-alerts-r6.test.ts | RED | replay after the 91 day sweep opens a new alert |
| C5 duplicate_key_leaves_open_detail (un-skipped) | same | RED | base UPDATE sets A2's detail to 200 (reads "event time 200", not 150) |
| C6 atomic new event, fault (b) then (a) | same | RED | the replay of B opens a new alert. Fault (b) half PASSES at base (finding below) |
| C7 R-loss-1 wire: same kind and ms suppressed | same | RED | base keeps no key and opens a second alert |
| C7 PIN different millisecond, PIN different kind | same | PIN x2 (GREEN) | delivered at base by design |
| C8 hold alert has an owner | same | RED | home.event_spool_failed is in the digest tier with no action text |
| D1 to D9, D4b (rig) | deploy/cloud-home/qualify/home-events-deployed.sh | written, `bash -n` only, NOT RUN | no VM exists; D5 is TODO-r8 |

Counts: RED 43 = 19 Python (P4b P5b P6b P7c P17 P18 P19 P20 P21 P21b P22 P23 P24, P26 x5, P27) + 19 Node (T5 x2, T7 x2, T9 T10 T11 T12 T13, T14, T14c, T15, T17 x5, T18 x2) + 5 CP (C3 C5 C6 C7a C8). PIN 2 (C7 different kind, different millisecond). GREEN guards 5 (G-VEC Python, G-VEC Node x2, P27 no-hold guard) . TODO-r8 skipped, not counted: P25, T16 (5), T4b (2), D5. build host containers used: 2 at most, all `--rm`, none left.

## Findings (GREEN at base where RED or PIN was expected, and r7 gaps)

1. C6 fault (b) passes at base: base already runs its detail UPDATE correctly; the half only kills MU-58b. C6 as a whole is RED from fault (a)'s replay. Not weakened.
2. P5b MU-82 (body 2 carries no extended event) is a PIN of base behavior (base pops the advertisement per heartbeat) and is behind the RED of body 1.
3. P25 as written in r7 cannot be reached: 300 accepted-with-non-durable-add ids exceed DIRTY_MAX 32. The test uses 32. Left TODO-r8.
4. Ruling 8 (alert with an owner) has no home in r7: D-2 says no CP signal is claimed for outbox failures. The tests encode the INTERPRETATION that control sends a home.event_spool_failed item while the app serves outboxDegraded > 0 over several probes (P27), and that this kind is a page-tier alert whose action text names the owner (C8, since cloud_alerts has no owner column). MurageMain to confirm.
5. P26, T17: R-loss-1 PIN tests cannot pass at base because base has no channel; they describe the exact bound once it exists.
6. Tests named by r7 from the r5 set (P2, P8, P13, P15, C2, T4b changes beyond TODO) are outside this prep set and not touched.

## Seams the builders must provide (r7)

- app_report: `report["homeEvents"] = {"items": [...], "outboxDegraded": N}` (strict parse: v 1, at most 32 items, keys id/type/at, 16 hex ids, outboxDegraded 0..32); module-level names INTAKE_S, APP_PROBE_URL; constants MAX_EVENTS, DIRTY_MAX = 32.
- Files: ACK `PUBLIC/home-events-ack.json` (v, control, acked, accepted; disjoint; at most 512 ids in total; 16 hex; at most 16,384 bytes); journal `CONTROL_STATE/home-events.journal` (CCCCCCCC + JSON lines; ops add, sent, drop); outbox `home-events.outbox` (ops add, and done = {"r":"done","id","type","at"} which is the tombstone; compaction past 256 lines keeps live adds and the newest 128 tombstones per type).
- Node: env MURAGE_HOME_EVENTS_OUTBOX, MURAGE_HOME_EVENTS_ACK_FILE, MURAGE_HOME_EVENTS_ACK_UID (test only), MURAGE_HOME_EVENTS_HOLD_ACK (test only: path; when present the app skips ACK reads once extended mode is set); exports reportHomeEvent(type, at, id), noteRestoreAborted(job), noteRestoreStuck(dir, marker, stuck), homeEventsHealthFields(env), loadHomeEventsOutbox(), drainHomeEvents(ms).
- Control behavior the tests encode: prefix-closed `sent` records, body capacity min(MAX_EVENTS, DIRTY_MAX - dirty), overflow only through a durable record, rule S (a reassigned key is sent after its add is durable), failure item while outboxDegraded stays above 0.
- App behavior the tests encode: retire only through a durable done (retiring items counted in outboxDegraded), retire gate, outboxHealthy false at boot, degraded add retried at each render, tombstoned id never re-added, smallest unused `at` per type.
- Rig (r7 section 9): barrier dirs /run/murage-control/j5b, /run/j5b-home, /var/lib/murage-home/j5b; NOTE and STALL barriers; j5b-wait; hold-intake; hold-ack; j5b-cp-ready; tmpfiles j5b.conf; j5b-journal-edit; purpose tag j5b-r7-deployed-tests. Mutants: qualify/j5b-mutants.md (MU-72 to MU-82, MU-58b, MU-H1; MU-15, MU-38, MU-47 redefined).

## Not built, not run

The rig and qualify/j5b-vm.sh are written and syntax checked only. No VM exists and none was created. The 20f95f742a control is at /work/fuigo-builds/j5b-r6-prep/artifacts/murage-control-20f95f742a (sha256 c117abfabc1b6e556d2f8bb1e448ed8f4c3785181f6a92365bc5ae0c3e7750bd).
