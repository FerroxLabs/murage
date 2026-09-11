# data-safety probes

Companions to `../data-safety.md` (lane SAFEWIPE1). None of these touch the
invoking account's real data directory; `deny-data-dir.sh` makes that a
kernel-enforced guarantee for anything it wraps.

- `wipe-race.mjs` — reproduces the incident's signature: a recursive delete
  of a `.murage` tree racing a process that appends into `native/` fails with
  `ENOTEMPTY`, leaving the directory and `native/` (same inodes) with only
  fresh files inside. Run: `node docs/verification/data-safety-probes/wipe-race.mjs`.
- `rmdir-semantics.mjs` — shows that an open fd, an `fs.watch` or a child's
  cwd does *not* keep a directory alive on macOS, so the race is the only
  mechanism consistent with the evidence.
- `deny-data-dir.sh <cmd>` — seatbelt wrapper denying writes under
  `~/.murage`, `~/.murage-companion`, `~/.opengrokbot` (macOS only).
- `mkhome.sh` / `checkhome.sh` — a fake home with marker files, and the
  check that every marker survived.
- `repro.sh <label> <checkout> <cmd>` — one candidate run with a fake HOME,
  the data-dir variables unset and the seatbelt on; reports markers and
  denied writes. Section 1 of `data-safety.md` lists the runs.

These are deliberately raw (`wipe-race.mjs` calls `rmSync` recursive on
purpose); `docs/` is outside the tree `data-safety.test.ts` scans.
