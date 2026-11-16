# Windows Signal park time and process budgets

`WINDOWS_PARK_DEADLINE_MS` in `park-fs.ts` is 120 seconds. Both `ParkFs` and
the public downgrade wrapper use it; other platforms retain 25 seconds.
A PowerShell security read takes approximately 0.25–0.9 seconds on the measured
Windows machines. The deadline bounds liveness, and expiration refuses work.
It never relaxes owner, DACL, reparse, identity, fingerprint or durability checks.

A publishing boundary collects only parents never verified during this
operation or whose lstat key changed since their last verified read. An
unchanged verified parent needs no new native read. Child operations never
refresh a parent's cached key. Changed parents lose their cached ACL evidence;
any later native batch includes them and runs the full ACL verdict. Identity
checks still apply during staging. A foreign DACL change without an lstat key
change is outside this parent-cache detection rule. Moved components retain
their fresh recursive pre-publication read.

Across an ACL batch and its cache return, a directory pins only normalized
unsigned device/inode identity and directory/no-link shape, plus the native
reparse, owner and owner-only DACL verdict. Child creation and ACL protection
can change directory ctime, mtime and size without replacing it; those fields
must not cause a `changed` refusal across the read. The full metadata key still
invalidates cached ACL evidence between operations, and files retain their full
identity/size/mtime/ctime checks. When prior verified evidence is retained, a
fresh incompatible verdict for that directory refuses as `changed`. Metadata
invalidation removes that prior evidence, so a subsequently unsafe native
verdict refuses as `unsafe`, as does initially unsafe evidence. Recursive tree
inventory and publication barriers remain required.

The downgrade entry point batches the initial ancestor, live-component and
control security projection. It does not enumerate unrelated installation
stores or opaque/excluded bundle payloads. Exact parent requests and recursive
roots share the same Windows path canonicalization and complete-row checks.

New directories are staged as empty entries beneath an already verified private
ancestor. A metadata operation collects its new directories and empty temporary
file, applies explicit protection in one PowerShell process, and only then
validates those entries or writes any content. The known empty bundle destination
can join the adoption control write's batch; queueing it does not create it before
the adoption fence. Directory grants inherit current-user and SYSTEM access.
Every new directory and file receives explicit protected grants before content
is written, including when its parent's grants do not inherit. A singleton uses
one icacls child with the cached SID. Multiple-entry protection requires a complete
success marker; failures leave empty temporaries and cannot publish metadata.
Existing paths are inspected, never repaired by this creation adapter.

Successful current-user SID reads are cached for the process. Native runner
adapters share an identity scope; injected runners have independent scopes and
failed identity reads are retried rather than cached.

Pass `debug: parkFsDebug()` to a park operation to inspect `childProcesses`,
`powerShellSpawns`, `securityReads`, `publishParentReads` and `protectionBatches`.
The first two count actual child attempts, including read retries, SID lookup
and ACL restriction. `securityReads` counts logical read batches.

`park-windows-budget.test.ts` exercises actual temporary filesystem operations
through the Windows native-runner adapter, including 200-file component moves,
complete downgrade parks, and 64 sequential park-state seeds. The complete
unchanged-parent-key scenario allows at most 12 total children for one file,
15 for 200 files, four PowerShell children per park, and zero publish parent
reads. Its directory stat seam explicitly models unchanged keys; independent
parent-race tests use changed keys and require full refusal checks. Changed
keys and native timeouts require additional reads; process counts never authorize
skipping them. These container witnesses do not replace native Windows qualification.

Run the focused checks in an isolated test container:

```sh
node_modules/.bin/vitest run server/channels/signal/park-windows-*.test.ts \
  server/channels/signal/park-fs.test.ts server/sentinel/paths.test.ts --maxWorkers=6
```

Follow [the verification README](README.md) for the isolated server fixture.
