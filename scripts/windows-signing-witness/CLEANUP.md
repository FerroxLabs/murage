Cleanup executor/independent confirmer owner: MAIN; pack cleanup gate owner: win-sac-sign.

The collector records each exact resource when created, including on failing paths.
MAIN runs the `cleanup` case after success, failure, timeout or interruption and
independently confirms each entry; a passing status without observations is invalid.

1. Revoke this runNonce's signing leases and extraction capabilities; close its pipe,
   sockets, native jobs and service sessions. Confirm no reuse or live signing child.
2. Stop only owned process IDs with matching creation times, including app/real
   engine/addon/collector children and suspended launch failures. No kill by pattern.
3. Uninstall only the isolated per-user test installation using the exact recorded
   uninstaller, with its frozen bytes/trust verified. Remove the isolated app home,
   staging, temporary compiler/receipt/race/sentinel files and pack-created tasks.
   Retain captures outside the checkout. Never touch a user's existing app/data.
4. MAIN's controller/reaper verifies deletion of each disposable extraction VM,
   OS/data disk and NIC after every exit path, including controller death. Retain
   independent control-plane confirmation; never infer deletion from process exit.
5. Restore the existing service's prior running state and pack-temporary WFP/job
   resources; verify enrolled authority/tools, certificates/signing identity, SAC
   policy, account groups and existing tasks remain unchanged. Never remove the
   existing enrolled service, box tag, identities or any pre-existing resource.
6. Export the final owned-resource ledger with created == destroyed and remaining
   empty. Retain all fault/expiry/reaper logs and small evidence. Treat cleanup error
   as a failed witness and release blocker, even if the install/turn succeeded.

Recovery command: repeat the README launcher with `-Mode cleanup`, unchanged MAIN
hashes/enrollment and the original output directory. Expect
`WINDOWS_WITNESS_CLEANUP_PASS RELEASE_HOLD`. This does not waive missing cases or
convert an interrupted run into a PASS. After MAIN archives reviewed captures, MAIN
may delete only this pack's capture/output and transfer directories by exact path.
