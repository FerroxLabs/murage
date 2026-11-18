# Incomplete fetched invoice approval follow-up

Job: `afix-afix2-hlf7-r3`. Base: `eca496b1b43ee68c0ec94c8a7265eb1fbafb18e0`.
Scope: the single BLOCK in `arev-afix2-hlf7-r3/REVIEW-from-last.txt`.

Every fetched invoice used in a mutation approval must contain a nonempty
`invoiceItems` array with reviewable line details: name, matching currency,
finite nonnegative amount and finite positive quantity. If taxes are present,
they must contain named, finite nonnegative rates. Missing, null, reference-only
or partial lines cannot reach review or dispatch. The existing financial
snapshot bounds and refusal copy remain in use. Recovery and returned identity
binding are unchanged.

The [provider get-invoice contract](https://marketplace.gohighlevel.com/docs/ghl/invoices/get-invoice/)
requires `invoiceItems`. Reference-only strings do not expose financial details
and are refused rather than treated as a complete approval snapshot.

## Reproduction and verification

The qualified RED swaps in the exact starting `payments.ts` (Git blob
`7e73c3fe654557de83c8afbb3de1b0cdbb43be28`) in the offline container and restores
the implementation before GREEN. `run-checks.sh` records this sequence.

Evidence: `.test-tmp/afix-afix2-hlf7-r3/`, with a persistent copy under the
job's `evidence/verification/` directory. Tests run through `it-remote.sh` with
`IT_JOB=afix-afix2-hlf7-r3`, the supplied worktree and local fallback, network
none, fakes only, one job container at a time and load below 60.

| R/M | Evidence | Result |
| --- | --- | --- |
| R1: absent or unreviewable fetched items | `red.log` | 11 assertion failures against the starting HEAD, including missing and null items reaching approval. Earlier Vitest-not-found and incorrect read-count assertion attempts are not RED evidence. |
| R1: refusal before approval/send | `green.log` | All 11 cases refuse with zero reviews and zero POSTs; all 169 payment tests pass (`green-targeted.log`). Complete financial snapshots remain covered. |
| M25: remove the required-items check | `mutants/table.json`, `mutants/M25-required-invoice-items.log` | Assertion-killed by the same regression tests. |
| Isolated fixture | `fixture/fixture-result.json`, `fixture/doctor.json`, `fixture/fixture-server.log` | Missing/null items refuse with zero reviews/writes; launcher owns temporary data/home and closes its server. |
| Types | `typecheck.log` | Full `pnpm typecheck`. |
| Release test registration | `release-workflows.log` | Existing test file remains registered. |

No new English user-facing strings. The existing refusal is reused:

> The full invoice details could not be shown for approval. Nothing was sent.

Project memory could not be loaded: `.ijfw/memory/`, the `ijfw` command and
`ijfw_memory_prelude` tool are unavailable in this environment.
