# No limits tool identity r1.3

`shared/no-limits-decision.ts:finalDecision` is the permission gate. Producers
return clean, cut, or effect observations. Only a nonempty collection of clean
observations permits execution. Effects take precedence over cut in oracle order
(root, home, system, disk, fork, word). Neither a second successful read nor an
existing grant clears a failed observation. Production collects the argument
scan, protocol completeness, environment, legacy always-ask and code readings.
Driver shortcuts on No limits turns go to the broker.

## Conservative Python reader

This reader never evaluates code. Its modeled tokens are ASCII identifiers,
ordinary/raw/ASCII-bytes/f strings with the supported Python escapes, numeric tokens,
LF statement separators, space-only indentation, comments, and the punctuation consumed by Parser.
Identifiers outside ASCII, unrecognized punctuation, malformed strings or
brackets, bare CR (including CRLF), NUL, and parse rejection keep a cut. CR is
normalized only for additive recovery of effects. Shift and <=/>= tokens are
retained in the effect tree but do not qualify for a clean read.

The expression model covers names, attributes, subscriptions, calls with
positional and named arguments, adjacent strings, f-string interpolation without
conversion/format specs, lists/tuples, and the operators in Parser.expr. The
statement subset covers separated imports, valid assignment/delete targets,
plain function parameters and if/elif/else/for/while suites. The effect walker
also retains children of rejected constructs. Async, classes, match/case, with,
try/except/finally, lambda, yield, global/nonlocal, argument unpacking, and
parameter defaults/annotations do not qualify for a clean read. Constructs that fail consumption keep cut;
the lexical fallback only adds effects and can never authorize execution.
Numbers are limited to 4,300 characters after removing separators. All literals
are limited to 16,384 source characters. Exact integers resolve through BigInt;
float/imaginary tokens can occur inertly, but resolving one as a value cuts.
Text remains bounded at one million Unicode code points (inclusive).

One ReaderBudget is shared by the payload queue, JSON leaves, Python binding,
name, fallback, effect and resolution walks, and JavaScript reads. Python context and
operator/keyword nodes omitted by the inert tree are charged explicitly, and
alias/argument binding records are charged conservatively. Binding target
walks do not allocate a fresh budget. At exhaustion, cut cannot become run.

## Reproduction

Use the job's it-remote wrapper with its local generic fallback and the shared
read-only dependency mount. Every test container runs with `--network none`.
Never run payloads: the fuzzer only calls the oracle and inert TypeScript reader.

- `bash scripts/prepare-toolid-r13-red.sh` prepares the immutable baseline;
  `scripts/red-toolid-r13.mjs` runs each review row in the container with a
  bounded subprocess lifetime.
- `scripts/oracle-toolid-r13.py` checks the appended review rows against the
  unchanged oracle (failure metadata is injected by the checker).
- `scripts/inventory-toolid-r13.mjs` parses every source under server and shared,
  including tests, and records approval/run constructions and gate callers.
- `scripts/mutants-toolid-r13.mjs` checks a direct producer approval and an
  unreadable-to-run mutation in private copies.
- `scripts/fuzz-toolid-r13-run.sh` runs two seeds totaling two million generated
  inputs, then 100,000 benign inputs. The separate summary gate rejects missing
  or incomplete benign measurements, any unsafe result, a rate at or above 1%,
  mismatched reader hashes, or missing comparisons. Each input reaches both judge.py and the
  TypeScript reader/gate. Any unsafe witness is delta-debugged and appended to
  `server/testing/fixtures/no-limits-r13-fuzz.jsonl`; a discovery run fails.
- `server/no-limits-r13.test.ts` instantiates review rows, including compact
  repetition recipes for the 16 MB note and resource edges.

The original 141-row corpus and oracle are immutable. H12py currently conflicts
with r1.3: it expects run for `def f(\n`, while r1.3 requires parse rejection to
cut. The implementation keeps cut and leaves that test visibly failing pending
MAIN's reconciliation. It does not special-case the row or alter expectations.

Older routine and app-action assertions also conflict with r1.3: reader cuts
used to be waived or retain their previous guard source, and routine deletions
used to run or retain the stop-line source. The new cut/word observation now
produces an always-ask card. Their expectations remain untouched along with
H12py; the final test report names each mismatch.

The 300,000-parameter row is intentionally conservative (oracle run, port cut);
the 400,000-parameter and 80,000 keyword-call rows exceed the oracle budget.

## Continuation evidence

The bld4 continuation preserves the bld3 work and its two differential shards.
An independent generated set of 100,000 benign inputs (seed 140019) measured
zero over-strict results. Ten synthetic checks exercise the summary gate,
including empty and undersized benign sets the exact 1% boundary, and duplicate shards. Synthetic
checks are excluded from differential and benign totals. Generator copies and
hashes identify the continuing and amended runs under `evidence/bld4-toolid-s4a/`.
The amended generator writes counterexamples to evidence instead of stdout.

The final isolated rerun has 647 tests: 639 passed, six failed, and two pending.
All four live fixture checks, all 62 r1.3 reader/integration assertions, all eight
fuzzer regression rows, and all five gate assertions pass. The six existing
expectation conflicts described above remain visible; these results do not
claim exact parity for all 141 original rows. See `open-expectations.json`.
