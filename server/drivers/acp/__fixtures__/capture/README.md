# Capture lane

The released npm binary is Brotli-compressed in `package/bin/fuigo.br`.
The decompressed binary's SHA256 is checked before each run.
`prepare-bodies.py` extracts S1 and S4 wording from the available source snapshot;
S2 uses LiteLLM 1.92.2's exception prefix and proxy envelope. The live source
commit and FluxMain production cross-check are **not available** and remain
required before closing P1. `body-sources.json` records that limitation.

`run-all.sh` captures each scenario twice in isolated containers with no network,
using the full node:22-bookworm image because it contains Python. `capture.py`
records every ACP input/output line verbatim in a timestamped JSONL envelope.
The stub logs methods and paths only. Engine stderr is retained separately.
Only the dummy credential is present. No authentication headers are recorded.

`PROVENANCE.json` and `CAPTURE-FINDINGS.md` are copied with the eight unedited
captures into the Murage worktree. Scratch homes and the decompressed binary
are disposable; frames, scripts, bodies, package tarball and provenance are
retained as evidence. A published/RC 1.0.42 binary and pin are still required.
