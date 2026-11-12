# Notification integration handoff

Coordinated through /work/fuigo-builds/swarm-b/bld-notifyos/CONNECTOR-RECONNECT-HANDOFF.md after reading the existing branch's DONE at c82b29501. That job has no live worktree and records its own qualification as OPEN.

The scoped connector-reconnect kind has a durable incident UUID in deliveryId/requestId. It remains Open-only. Existing approval routing is unchanged. OS notices have a disk receipt ledger; tray, badge, bubble and dock read one persistent Open-only row per incident through the existing attention data path. The checked-in main reports pillAvailable=false, so this lane does not claim a working pill implementation or installed native OS qualification.

Phone delivery uses the existing paired-phone outbox with per-binding dedupe. A connector:<UUID> message target rides the existing native deep-link contract. The renderer opens the authenticated incident view and the owner confirms the account label before the broker sign-in starts. Both incident reads and writes require desktop or paired-owner proof, plus thread visibility on the paired surface. The general connector-settings routes stay desktop-only.

Pending independent work: copy review for the 32 new catalog strings; installed OS qualification with notifyos; upstream Composio account-status fidelity and grant refresh remain the external credential owner's responsibility. These tests use fake services and never contact the real broker or Buffer.
