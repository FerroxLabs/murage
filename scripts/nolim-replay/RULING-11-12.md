# 257-row real-log release leg

The release entry point is `run.mjs`. It replays recorded input through the
candidate's `autoVerdict`, authoritative `decide`/presentation/delivery path and
final native release guard. A fresh child process receives only a temporary HOME
and data directory. No engine, shell, connector action or recorded command runs.
The original input and product diagnostic prose never enter the public report.

```
node --experimental-strip-types scripts/nolim-replay/run.mjs --release --platform linux --candidate FULL_SHA --corpus APPROVED_REDACTED_JSONL --sha256 APPROVED_SHA256 --out NEW_REPORT_JSON
```

Use `darwin` or `win32` only on the corresponding actual OS. The parent removes
its temporary data after its exact worker exits. The worker refuses standalone
use without its parent's owned fixture environment.

Each of the 257 JSONL records must have a unique opaque `id`,
`source:"redacted-real-log"`, a `tool`, original `fullToolInput`, and a separately
reviewed `label` containing `independent:true`, `kind:"none"|"wipe"|"permission-rule"|"feature-off"`, and an actor:
`owner`, `owner-routine`, `webhook`, `owner-channel`, or `owner-phone`. An optional
`outsideRead` records the original mark. Preserve relevant `denySnapshot`, engine,
ownerStarted and input/context-unavailability facts; do not infer historic owner
proof from the bot's level. The independently approved hash binds the exact bytes,
including the labels. The author of a candidate must not supply its own labels or
invent source rows. `source` is a declaration checked against that reviewed pin,
not independent evidence that arbitrary JSON came from Sean's log.

A usable extract must preserve policy-bearing input. A masked/truncated/missing
executable or missing denial context is UNPROVEN and fails release. A passing
synthetic shape witness cannot prove the missing original input. A diagnostic
reason census or the older masked-display SELECT alone is therefore insufficient
for an exact 257-row release PASS; the existing extractor correctly reports those
limits. Obtain the authorized redacted extract from MAIN; never read the Mac or
live logs from this lane. Missing corpus means FAIL, not an empty PASS.

Every logged ordinary non-wipe row must RUN. Saved permission rules, including labels `deny`, `owner-deny` and
`permission-rule`, require RUN with zero cards, refusals, holds and silent
denies. A `feature-off` row instead requires `kind: "off"`, zero cards,
independent non-execution proof and exactly one plain line saying the feature
is off and where to enable it. Only a wipe can justify a permission card.
The 08:05Z correction supersedes every earlier owner-refusal exception.

`release-check.mjs` now defaults to strict release admission too: 257 rows,
three candidate-bound wipe controls, zero forbidden refusals/holds and no unavailable rows.
Owner-deny labels have the same evidence requirements at both entry points.
Its legacy 140-row tests explicitly use `release:false` for characterization;
those receipts are `releaseEligible:false` and cannot satisfy the release leg.
The old protected-target deny exception is never accepted for eligible No limits.

`production-smoke.mjs` and the gate mutation qualifier use inert, synthetic inputs
to prove the detector. They are explicitly `releaseGate:false`. Their green
results are not evidence that Sean's 257 original requests passed.

Review repair: a denial-source tag is not the denied condition. Host/browser/app
rows (including shell rows carrying those tags) require nonempty, typed
`denySnapshot.evidence` entries with `kind:"deny"`, `class`, `ruleId`, and `span`.
Missing or malformed evidence is UNPROVEN before the candidate adapter is called.
The production adapter enforces this admission rule again at its own boundary.

A wipe PASS requires one matching durable approval record and options-message
presentation for the exact request. The adapter supplies their approval, message
and request IDs in `presentations`. The judge requires one typed wipe
presentation and an explicit card count of one. `autoVerdict` alone cannot
manufacture a card or satisfy a control; an absent presentation fails replay.

Both replay and the live CLI verify the candidate's tracked contents. A
container snapshot can use `--candidate-proof FILE` generated with
`node scripts/no-limits-live/candidate-proof.mjs . candidate.json` on the clean
candidate checkout. The verifier reconstructs the commit/tree/blob identities;
it does not trust a SHA label in the manifest.
