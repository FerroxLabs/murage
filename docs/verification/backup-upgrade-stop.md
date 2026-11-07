# Upgrade Stop ownership (BF-5)

This amends D5a of the BACKUP-WAIT r32 design for upgrade admission.
The existing BF-1 manual ownership boundary and BF-2 through BF-4 behavior
remain unchanged.

Before the synchronous prepareUpgrade save, Stop releases any preparation
and preserves the existing wait. A stopped preflight never calls
prepareUpgrade. The save transfers ownership to the upgrade job and handoff.
The token records that ownership without an intervening await.

After that save, Stop during space checking, successful preparation,
internal cleanup, or before arm or relaunch retires the upgrade handoff.
Preparation is cancelled, the stopped marker is retained, and failHandoff
runs through the coordinator lease. Lease refusal leaves the prepared job
and marker for startup reconciliation. Retirement never restores the old
waiting ID or calls cancelManual. Destination room survives.

The running guard stays set through release and retirement. Intentional
cleanup carries the token without cancelling itself. User Quit or Return
still cancels it, including a queued relaunch. Stop after arm prevents
relaunch but cannot undo the fact that arm already committed.

T-stop-admission BF-5 in electron/backup-schedule-host.node-test.mjs covers
preflight, commit, space, prepare, cleanup, arm and queued relaunch. The
disk-backed server/backup-wait-space-1018.test.ts matrix executes main's
Quit and Return callbacks at preflight, commit, space, prepare and cleanup,
with lease refusal controls after commit. It verifies ownership, retained
room, marker identity, preparation release and no capture on fresh startup.
Existing upgrade success tests remain the internal-cleanup success controls.

Run these with the neighboring host, startup, mode, preupgrade and return
tests. Revert only the production host change for the red proof, leaving
the tests in place, then restore the change before final verification.
