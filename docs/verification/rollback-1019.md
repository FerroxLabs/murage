# Preparing a 1.0.19 installation for 1.0.18

With Murage closed, run the shipped installation recovery command:

```
memory-downgrade --data-dir /path/to/installation --to 13
```

The desktop Help menu's “Prepare to reinstall Murage 1.0.18…” performs this step
under the installation lease and quits. Install 1.0.18 after it finishes. Complete
or decline any waiting work the command identifies before retrying. The separate
1.0.2 menu item retains the deeper `--to 10` step.

The production step cancels pending 1.0.19 approval records, removes their guards
and tables, and removes the newer optional memory objects before checkpointing.
Memory schema versions remain unchanged.

The frozen 1.0.18 source qualification uses the audit's release-source reference:

```
mkdir -p .v118-ref
git archive 6e4dda8afd | tar -x -C .v118-ref
```

Run `server/decision/rollback-118-frozen.test.ts` in an isolated test container.
It opens through the old database code, inserts and answers a legacy card, then
uses the old inspector and snapshot implementation to make a backup. This is a
source compatibility check; it does not claim a packaged desktop binary smoke.
