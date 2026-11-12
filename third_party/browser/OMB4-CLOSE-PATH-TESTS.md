# OMB4 shared close transaction

Binding design: `OMB4-CLOSE-DESIGN-r2.md`, including the round-one controlling amendments. This source candidate uses `ownership::close_session` through `close-owned`; it does not promote engine binaries or change A8's driver fix.

The test branch was merged before implementation. Its N1 tests were corrected to `requireSaved:false`: every close attempts the save, and a failed save permits bounded force. Cookie and storage persistence assertions remain. TS now tests the CLI boundary; Rust tests the orchestration. The healthy protocol fixture retires its daemon after replying, so it must pass the final census as well as the save assertion. The explicit `ownership-test-fixtures` Cargo feature supplies this protocol fixture and a save-attempt counter; neither is compiled into a normal vendor build.

## Behavioral baseline

On the merged baseline with the agreed N1 contract: 6 TS assertion failures and 8 passing guards; 5 Rust assertion failures. No compilation error is counted as RED. The expanded CloseIo suite has an executable adapter preserving the baseline stop-first, daemon-exit-is-success and file-selected Windows-target decisions: 14 assertion failures and 6 passing guards. Adapter results are separate from execution of the original baseline source.

Two additional deadline/job-gone regressions were assertion-RED before their corrections: no force operation after expiry, and lost save status for the evidenced job-gone path. Frozen endpoint, SID and observation directory replacements are also exercised independently.

The real Linux-container Chromium regression changes a cookie and localStorage after launch, then tests both `close --all` and `close-owned`. It asserts the changed values in restore state and exactly one save attempt per transaction. It passes on the shared transaction and assertion-fails with the force-first baseline behavior restored. This is container Chromium evidence, not a packaged-app or native desktop claim.

## Design coverage

| Design test | Executable witness |
| --- | --- |
| 1 | `ownership_n1_close_all_graceful_before_force`; real protocol CLI callers for close-all, dashboard, close-owned and launch-group; dashboard `/api/kill`; restart entry used by both ensure-daemon branches; signal adapter |
| 2 | `ownership_n1_real_changed_cookies_saved_close_all_and_owned`, plus healthy protocol dirty-state assertions |
| 3 | `ownership_n1_graceful_failure_then_force`, `ownership_n1_save_failure_still_forces` |
| 4 | `ownership_n1_graceful_launch_mismatch_never_forces` on both platform dispatches |
| 5 | `ownership_n2_missing_owner_with_launch_id_refuses`, including environment authority |
| 6 | `ownership_n2_reused_daemon_runs_census` |
| 7 | `ownership_n2_daemon_exit_without_census_not_closed` |
| 8 | `ownership_n3_owner_replaced_before_force_refuses_without_open` |
| 9 | `ownership_n3_force_opens_derived_name_only`, with swap after corroboration |
| 10 | `ownership_n3_job_gone_requires_evidence`, including zero-open and evidenced matching controls |
| 11 | `ownership_w42_reply_wrong_launch_otherwise_success`, separate S2/S3 matching controls |
| 12 | `ownership_l1_legacy_no_owner_never_signals`, `ownership_l2_null_and_invalid_evidence`, absent-endpoint requirement |
| 13 | TS direct and integrated missing-evidence cases; CLI runner must not be called |
| 14 | Windows CLI argv and otherwise-successful wrong-launch reply |
| 15 | TS wrong-stop-launch proof through CLI, matching-success control and unrelated live sentinel |
| 16 | Windows integrated replacement before CLI operation; both open and terminate arrays remain empty |
| 17 | Independent TS `closed:false` and Linux `treeExhausted:false` cases |
| 18 | `ownership_n2_detached_orphan_without_proof` |
| 19 | `ownership_expected_inputs_frozen` |
| 20 | `ownership_n1_confirmation_bounded`, both platforms; successful remaining-daemon retirement control |

## Mutation evidence

All 17 independently run variants are assertion-killed: M1; M2; M3 Rust S2, Rust S3 and TS; M4 Rust and TS; M5 omitted S5 and empty census without prior proof; M6 S0 evidence bypass plus job-gone acceptance; M7; M8 closed and tree exhaustion; M9; post-construction target rereads (test 19); omitted Unix retirement and Windows active-process confirmation (test 20). Each source is restored and SHA-256 compared after its mutation. Compilation failures do not count. M1 additionally fails the real Chromium persistence witness.

Evidence and runner scripts are retained in the builder workspace `.omb4-build/evidence/`. `DONE` records the exact final SHA, gate counts and full-suite NEW count. The full gate uses `vt-shard.sh` and the prescribed c12aaad93 comparison; focused runs are not substituted for that result.

## Remaining native proof

The separate `omb4proof` lane owns native Win32 derived-name job operations, replacement-job survival and last-handle/KILL_ON_JOB_CLOSE behavior; macOS survivor census and detached-helper evidence; all-platform packaged-app cookie save; and the fully wedged-runtime signal witness. Portable job fakes and Linux containers cannot establish those OS-specific facts.
