# Reused Linux S2 qualification

This fix round imports the production identity gate and immutable receipts from
reviewed commit `0472767047ad73e02bdd9376850b29e14391b2b6`. The retained review is
PASS with no Critical/High findings. It admits only Linux x64 Claude 2.1.310 with
native SHA-256 `b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56`.
Other platforms, architectures, versions, artifacts and launchers remain S1.

The external `s2-real` evidence artifact records three consecutive 9/9 real-CLI
rounds. Evidence and exact qualified source snapshots are retained outside the
repository; its source-reuse.json proves that the Claude
driver, barrier, stdin and relay match the qualified source. The qualification
module differs only by its reviewed admission entry. No provider call was made
in this fix round. Local admission and mutation verification uses fakes only.

The review's limitations remain explicit. Supplemental teardown assertions run
final disposal before checking resource death, so those receipts do not prove
that Stop alone removed every descendant before disposal. Latency samples used
NODE_ENV=test and exclude the production per-dispatch artifact hash. They are
not production-path latency measurements or a general performance SLA. Neither
limitation is silently counted as a newly executed qualification. Windows and
macOS remain unqualified. The historical A4 and empty-allowlist notes predate
this reviewed Linux receipt and are superseded only for that exact identity.
