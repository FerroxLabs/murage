# Signal capture custody

`../evidence.mjs` owns the G0 pin and manifest contracts, required fixture ids,
origin rules, device attribution, security invariants and unlink proof.
Only scrubbed, independently reviewed captures belong in `g0/`. Synthetic
verifier inputs live in temporary directories, labelled in their pin citation
and review, using `scripts/fixtures/signal-test-evidence.mjs`.

Capture devices M, P and Q are distinct linked devices. All required fixtures
are observed on M; unlink-response is observed on P and unlink-survivor on Q.
The three upstream-discard cases are explicitly mutated from own-note and
inherit its device attribution. They prove Murage's defensive rejection only.

Every fixture carries `captureSequence`, a positive safe integer assigned by
one harness observation coordinator. For successful unlink the survivor must
be observed after the unregister response. This is harness ordering, not an
invented timestamp on the provider response. The hashed manifest also requires
`unlinkProof.phoneConfirmedPeerRemoved: true` and an `observedBy` description
of the operator's explicit confirmation that P disappeared from the phone.
A survivor on Q alone does not prove removal of P.

`verifySignalEvidence` returns the exact reviewed manifest and bytes. Only that
registered object can authorize unregister, and runtime authorization still
requires an authenticated linked device and matching host/binding identity.
