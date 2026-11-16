# MAIN extraction and sealing runbook (binding Mac ruling)

The Mac step is DONE. No Python, repository code, application launch or further
data discovery on Sean's Mac. MAIN's completed fixed grep was `approvals:` on
`server.log` only; there was no `server.log.1`. The received private allocation
contained `approvals-diag.txt` and `RECEIVED-AT.txt`. The extractor accepts that
exact layout as well as the historical two-log layout, but rejects mixed inputs.
The metadata file is never parsed as a diagnostic. Non-asked lines are counted
without exporting their contents. Never print any received line.

Sean's bld2 decisions authorize the six redacted files at `corpus/r1/` and
supersede the old hook exception: own hook/relay files use check+restore without
a card. Deny rules and the existing wipe list are the hard stops. MAIN's r13b
table preserves base behavior on non-owner turns and the tainted-turn rules.
The export policy records this authority; it does not derive expectations from
observed candidate verdicts.

Electron timestamps stdout/stderr chunks, not events (main.mjs 1865–1870 and
2666–2667). The authorized grep loses surrounding chunk context, stream identity,
split markers and original source line numbers. Never expand the Mac read to
recover them. `line` in this extract is explicitly an extract ordinal. Missing
or ambiguous timestamps, multiple markers, split records, boundary timestamps,
and unresolved overlap block completeness. Repeated same-file rows remain
separate. `elapsedMs` is null: a chunk timestamp is not a precise event time.
Even a fully parsed grep extract remains INCOMPLETE for historical coverage.

On build host, pre-stage the reviewed dependency-complete image and run with
`--pull=never --network none --read-only --cap-drop ALL --security-opt
no-new-privileges --user 10001:10001`, explicit read-only `/raw-diag` and writable
allocated `/output` mounts, no home/socket/credentials. Stage only these allocated
paths for UID 10001 with directories 0700 and files 0600; verify read/write access
as that UID. Inside that container:

```
python3 /opt/nolim-replay/scripts/nolim-replay/extract.py extract \
  --source /raw-diag --policy /opt/nolim-replay/scripts/nolim-replay/export-policy-v1.json \
  --out /output/diagnostic-review
```

Exit 2 and INCOMPLETE are expected for a grep-only diagnostic census, never a
release PASS. Fixed incident: 2026-11-09T12:00:00Z through 2026-11-10T02:00:00Z
exclusive, annex through 02:15 exclusive. Changing cutoffs requires a new policy
version. Suppressed previous windows are counted; final suppression is unknown.
Do not claim a historical visible-card total from these fields.

`prepare-requests` accepts only an explicitly authorized copy, not live profiles:

```
python3 /opt/nolim-replay/scripts/nolim-replay/extract.py prepare-requests \
  --diagnostics /output/diagnostic-review --local-input /local/authorized-requests.jsonl \
  --local-map /local/transform-map.json --out /output/request-review
```

The map must carry original-record hashes (local only), exact sanitized records,
literal replacements, diagnostic IDs, fidelity receipts, independent MAIN/Astra/
Fable references, a chunk/coverage reconciliation receipt and the resolved hook
policy. Equal byte lengths and syntax are necessary but not sufficient: reviewers
must establish the same shell structure, path category, origin, reader limits,
inner commands and stop identity without using candidate verdicts as the oracle.
Missing historical inputs remain CORPUS-INCOMPLETE. Do not invent request data.
Only Sean can authorize another source if existing authority does not cover it.

Six-file order is manifest.json, diagnostics.jsonl, requests.jsonl, mapping.json,
coverage.json, redaction-report.json. Manifest hashes the other five only.
External bundle digest is SHA256 of UTF-8 lines `filename<TAB>decimal-byte-size<TAB>
lowercase-content-SHA256<LF>` in that exact order. Approval references must be
preallocated or remain external. `seal-export --review /output/request-review
--approval /local/approval.json --out /output/approved` checks exact digest,
policy digest, review references, authorized destination and 30-day retention,
then copies all six bytestrings unchanged into a fresh directory. Unknown files,
symlinks, changed bytes, incomplete fidelity or missing approval are rejected.
`*-local-only` (salt, aliases, raw-source hashes) is never part of the bundle.

The bld2 instruction explicitly requires a private SHA-256 receipt for each
deleted file, its size, deletion time and sanitized bundle digest. `erase_raw`
reserves that receipt before deletion, then records completed deletion. An
existing receipt or unexpected raw filename prevents deletion. This supersedes
the older instruction excluding raw hashes from the private deletion receipt.
Corpus and results are retained for review and 30 days after publication,
then MAIN removes those exact allocated directories with a receipt. No broad
permission repair or recursive home read is permitted. No private inputs or
results belong in git or public CI artifacts.

The build host `seal-export` CLI additionally requires `--raw-diag
/work/fuigo-builds/orph/_ev/nolim-replay/1019/raw-diag` and an explicit
`--deletion-receipt` outside that directory. After byte-identical sealing it
removes only the literal diagnostic-copy/receipt filenames and the allocated raw
directory, then writes a digest-bound deletion receipt. An unexpected file,
symlink, incomplete seal, or failed deletion blocks completion. These operations
are for the transferred diagnostic copies only; no Mac code or live data is
involved. The private allocation for sealed bundles is `corpus/`, not a profile.

`seal_diagnostics` is a separate retention seal for the newly authorized census.
Its digest-bound approval has scope `diagnostic-only`; requests and mappings
must be empty, fidelity and origin completeness false, and release eligibility
false. It copies exactly six files and leaves missing reviews unresolved.
It cannot satisfy `seal-export`, release admission, COMPLETE, or baseline RED.
The bld2 run sealed in a network-none container, then immediately called
`erase_raw` on the build host; no source contents were displayed or saved in git.

`inspect-replay.py --corpus <allocated-r1> --product-ref <resolved-local-ref>
--baseline-ref origin/int1018/pin54b --out <new-private-directory>` records
read-only admission for both product pins. Fetch the authorized local bare
remote before resolving the refs. The command verifies hashes/modes, binds full
commit/tree SHAs, and writes null card totals when replay cannot run. It is an
admission receipt, not a finished replay runner. No diagnostic reason count is
converted to a historical card count or a generated request. See BLD2-HANDOFF.md.

For the runner, stage only the approved six files into a new private
`/work/fuigo-builds/orph/_ev/nolim-replay/1019/corpus/<id>` allocation, owned by
`10001:10001`, with 0700 directories and 0600 files. Allocate the empty result
run directory with the same ownership. Check those exact allocations; do not
chown the evidence tree or relax permissions broadly. `run.sh` checks both host
metadata and in-container access. Build the image from the exact RC and
prepared lockfile dependencies, with `--network none`, source/lock labels and
a digest pin; never put corpus or raw diagnostics in the image context.

Before an attempt MAIN uses the authenticated source status channel:
`node scripts/release-nolim-gate.mjs pending FerroxLabs/murage <sha>
<pending-receipt.json>`. This posts pending, paginates history and reads back
that exact newest pending record. The receipt is an external operator
attestation, not independent GitHub inspection of private evidence. The numeric
issuer allowlist is intentionally unconfigured pending MAIN's supplied identity.
No pending/status publication was performed by this build.

Manual publishing now requires version, release ID, staged assets, source
repository, exact SHA and the asset provenance receipt as positional arguments
to `release-guard.mjs publish`. `NOLIM_STATUS_TOKEN` authenticates source status
reads; `GH_TOKEN` remains the separate releases-repository credential. Missing
binding or status fails before the draft can be made public. CI records asset
hashes at the pinned platform build boundary and verifies their union before
assembly. Do not manufacture a receipt for arbitrary preexisting binaries.
