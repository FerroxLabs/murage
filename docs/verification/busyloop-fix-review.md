# Busyloop fix review

The hourly reset regression is fixed by passing the failed ACP result's `error`,
`message`, and `_meta` as separate retry-time sources, followed by the complete
result. This preserves the parser's existing bounded traversal and source order
while retaining the cap fields added by busyloop.

`server/drivers/acp/fuigo.test.ts` now covers hourly results carrying a reset in
message JSON, metadata, error JSON, and the whole result. The message and metadata
cases failed before the fix because `gatewayResetsAt` was undefined. Each case
checks the real driver event and the resulting `LimitTurns` state.

`src/components/gateway-busy-recovery.dom.test.ts` mounts ChatView and the existing
ModelPicker in an isolated DOM. It checks replay of the exact kept message,
opening the actual picker dialog without changing selection, navigation to About
at Diagnostics, native report export, missing native bridge, rejected export,
and retry exclusion for busy or superseded turns. Disabling the three ChatView
handlers made five interaction tests fail; the two retry exclusion controls
continued to pass. This is mutation RED evidence for the missing coverage, not a
claim that those actions were broken before this review.

The new test is registered in `ci/gate-tests.txt`. No existing guard or test is
weakened.

Two review requirements remain open:

- **Customer refusal provenance.** The lane contains the reported Flux response
  body, synthetic ACP relay fixtures, and isolated API evidence. It does not
  contain the customer's Fuigo refusal event or a trace of that binary processing
  the response. The fixture comments now say this explicitly. None of these
  artifacts proves engine-side stripping. To close the finding, retain a redacted
  actual ACP event with the binary version and capture provenance, then replay
  it through the driver and `LimitTurns`. If the engine loses both the state and
  allowance wording, record its exact emitted event and the upstream-to-ACP
  loss; do not infer a monthly cap from a bare 429. A meaningful customer-event
  RED/GREEN test cannot be written from an absent capture.
- **Accepted copy review.** The 32 recovery strings and the changed
  `same-as-english.json` still need review by a reviewer on
  `src/locales/copy-lint/reviewers.json`. The focused `busyloop: all 32 recovery
  strings and their English fallback file have accepted review records` test in
  `src/locales/copy-final.test.ts` fails until valid accepted records exist. Empty
  proposal verdicts and baseline failure comparisons do not constitute approval.
  The author has not filled in verdicts on an independent reviewer's behalf,
  changed the approved-reviewer list, or added a gate exception.

Validation through the prescribed container helper:

- 885 tests passed across 12 touched/neighbour files, including all 81 release
  workflow checks, 155 Fuigo tests, 486 shared ACP tests, and the isolated HTTP
  recovery test. The HTTP test retained its transcript and server log outside
  version control.
- All three TypeScript projects passed.
- The copy lint/review run passed 294 tests and failed four: the focused busyloop
  acceptance test plus the existing ledger validity, rebuild, and pinned-file
  checks. These failures remain blocking; no baseline comparison waives them.
