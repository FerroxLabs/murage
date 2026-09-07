# Offline installation recovery — development verification

This is a development-only recovery surface. A dedicated desktop failure
window is wired; safe activation, complete semantic validation and full
packaged/native platform acceptance are still pending.
Do not use a live customer installation to verify these commands.

Use an explicitly created disposable installation and absolute paths. The
offline owner refuses a running harness; stopping a process by name is not
an acceptable substitute for stopping the exact owned fixture.

The source command is `pnpm installation:murage`. The independent packaged
entry is `node dist-server/installation-recovery.js` (Node 24 required).
Both accept the same operations:

```
backup --data-dir <stopped-fixture> --output <new-private-backup.zip>
inspect --archive <backup.zip>
plan-restore --archive <backup.zip>
restore --data-dir <stopped-fixture> --archive <backup.zip> --sha256 <hash-from-plan>
rollback --data-dir <fixture>
```

Archive output must be a new path. Inspection/planning use private scratch
and do not change an installation. Restore binds the supplied archive hash,
preserves the previous directory as a sibling and returns its path and a
recovery receipt. All restored agents remain blocked behind recovery review;
there is deliberately no activation command yet. Do not remove the marker
manually to bypass that unfinished safety gate.

After an interrupted restore, preserve the external journal and retained
directories. `rollback` can recover the original and retains the prepared
candidate rather than deleting it. Successful rollback returns a receipt and
the retained candidate location. Never delete those paths merely because a
command exited nonzero. Unknown/substituted original directories fail closed.

Backups contain private conversations, attachments and working content even
though structured credential fields are omitted. They are not public-safe
diagnostic archives. Native-engine state and arbitrary external projects are
not copied.

Automated disposable verification:

```
pnpm exec vitest run server/installation-restore.test.ts server/installation-restore-preparation.test.ts server/installation-recovery-command.test.ts server/installation-archive.test.ts server/installation-state-snapshot.test.ts server/installation-database-snapshot.test.ts server/data-dir-ownership.e2e.test.ts
pnpm test:packaged-server
```

These tests include actual process exits and fresh-process recovery; they do
not establish Windows power-loss durability or a complete GUI journey.

On a machine with a native display, run 'pnpm test:desktop-recovery' for the
actual recovery window/preload/IPC and delegated utility backup/restore/undo
fixture. It builds its worker first and creates an isolated temporary
installation and Electron profile. File/confirmation dialog responses are
injected; no provider is started. The parent cleans the profile after child
exit. Screenshots and a scoped result remain in
.planning/desktop-recovery-native/. This is not a signed-app acceptance test.

Database preflight checks supported columns/keys, rejects unknown executable
schema, and validates message identities, branch links and active heads.
Legacy transcripts use the same graph checks. A single thread exceeding one
million messages or128MiB of message/parent ID bytes is explicitly refused;
no recursive traversal is used. Full cross-component receipt validation and
large-installation performance acceptance remain open.

Routine confirmations, webhook delivery keys and delegation receipts are
validated before backup and again before external restore. Malformed or
duplicate acknowledgements refuse the operation; valid historical receipts
are retained even if their original live definitions were deleted. Record
errors identify a `component` filename in CLI JSON without printing contents.

Each restoration gets a fresh Murage connection profile. Encrypted credentials,
companion preferences/device bindings and browser cookies are not borrowed
from the previous installation. Old profiles remain retained for undo;
Fuigo's own global/project configuration is not copied or isolated by this
mechanism. Backups omit connection-profile and headless companion state.
Never manually remove the review marker to bypass unfinished activation.
