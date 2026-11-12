# cfix4-winscen expectation changes

Binding source: /work/build/winhide-ruling/RULING-winscen-p11c-MAIN.md, items 1–4 (over p11b). No safety expectation is loosened.

- Item 1 strengthens outer cleanup from enumeration-triggered wrapper removal to fixed-name removal first, followed by an independently bounded diff. Existing cleanup/provenance assertions remain; structural references follow the new coordinator.
- Items 2–3 strengthen the old top-level production-only Process.Kill check to recursive scanning of every specified extension, including tests/checks/mutators. Linux test harness launches are routed through the single Node launcher, which refuses that path on Windows. Fixture source strings live in JSON data so they are tested as source in isolated scanner fixtures rather than executable gate files.
- Item 2 requires Node's admission, snapshot, relaunch and cmd-chain helpers to use the same suspended job owner. The cmd-chain still checks the inherited package preload on its Node parent and its command output; native execution is now owned by the broker. No installer, HTTPS, credentials, profile, staged-package, protected-task, or receipt requirement changes.
- Item 4 adds four assertion-killed source mutations; all six prior ownership mutants and four safety mutants remain required.

Exact existing assertion/mutation references updated (same or stricter guarantee):
- `safety.node-test.mjs` and `ownership.node-test.mjs`: `Complete-RunLedger` entry reference becomes `Invoke-LauncherCleanup`; still required in outer finally and before finalization (p11c §1).
- `p11b.node-test.mjs`: outer coordinator reference plus helper removal assertion; old production-only regex becomes the recursive scanner with no name exclusions (p11c §§1,3).
- `mutate-safety.mjs`: `skip-launcher-cleanup` replaces the new coordinator call, preserving the same omission mutant (p11c §1).
- `native-timeout-fixture.c`: existing 30-second schtasks event expectations stay byte-for-byte; a separate 300-second snapshot trace exercises p11c §2.
- `desktop-task.ps1`: scenario job proof is captured before separate cleanup worker jobs, preserving the existing exactly-one scenario job receipt requirement; cleanup workers add ownership, not a receipt exception (p11c §1).
