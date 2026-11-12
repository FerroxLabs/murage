# Native deny regression verification

Run inside the job's network-disabled test container:

```sh
node --test --test-reporter=tap scripts/probes/native-deny/tests/*.test.mjs
node scripts/probes/native-deny/tests/verify-mutations.mjs scripts/probes/native-deny/evidence/afix2-bld-nd20-s11/mutants
```

`fake-engine.mjs` is a test-only CLI/ACP peer. The tests invoke it through Node,
with an isolated fixture home and work directory. It reports protocol events and
writes only fixture files; it never executes the requested tool command. The
P-F3 source witness contains synthetic source bytes, not upstream engine proof.
The P-C6 recipe is tested directly with a fake root refusal followed by a
structured sandbox success, without requiring the test container to run as root.

The review regressions cover target-linked denials, subagent lifecycle events,
malformed and truncated transcripts in every recipe, and recognized ACP
authentication failures. P-C6 also rejects structured output mixed with a root
refusal. P-X2 accepts a multiline execpolicy JSON document and rejects truncated
documents and trailing fragments independently of live JSONL validation. Every recipe
also has complete, failed and incomplete proof cases. The mutation runner copies
the subject into owned temporary fixtures, removes one required check at a time,
and requires assertion failures in the corresponding regression. This includes
a mutant that rejects valid multiline JSON. It saves
replayable patches, TAP logs and a JSON summary before deleting each copy.

The untracked evidence directory holds the starting-commit RED transcript,
starting source hashes, final GREEN transcript and mutation results. These tests
prove the probe scripts' behavior with fakes; real-engine qualification remains
the gate rig's responsibility.
