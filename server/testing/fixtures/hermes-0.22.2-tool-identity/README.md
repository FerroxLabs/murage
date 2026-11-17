# Reproducing the S0 capture


Read and hashed the pinned `acp_adapter/tools.py` (kind map, title/start/completion builders),
`events.py` (event ordering), `permissions.py`, `edit_approval.py`, `server.py`, `session.py`,
`agent/display.py`, `model_tools.py`, `tools/approval.py`, and `hermes_cli/main.py`.
The capture checked all 8,503 Python source files against the downloaded archive; none changed.
Only the upstream packaging script added `install-stamp.json`, with the verified release SHA.

Prepare Python dependencies separately with `pip install --target "$S0_DEPS" -r requirements.txt`
using Python 3.14. This step runs no Hermes code. Download the pinned source archive named in
provenance, extract it, and obtain a Node 22 binary. In a `--network none` Python container,
run upstream `scripts/write_install_stamp.py --output install-stamp.json --base-version 0.22.2
--distance 0 --commit d923a5eb487a17c0a68801bba9ef0f56c81040a8 --source local
--update-mechanism external`. Then set `S0_SOURCE`, `S0_DEPS`, `S0_NODE`, `S0_IMAGE` to the pinned
inputs and `S0_OUT` to an empty evidence directory; run `bash run-capture.sh`.

The harness creates fresh container-only HOME/workspace, asserts the sole interface is `lo`,
starts a scripted OpenAI-compatible server at `127.0.0.1:18080`, and invokes
`python -m hermes_cli.main -p default acp`. The subprocess environment is an explicit allowlist.
The only keys are obvious fixture strings. The Murage hook source is copied exactly (cap
constant expanded); the loader is a direct Node invocation. The free matcher omits unavailable
Murage-owned servers and otherwise uses the base's exact 19 free names. No Hermes monkeypatch,
registry replacement, live app, user data, credentials, model billing or new VM is involved.
Deferred tools use Hermes's real `tool_call` bridge, which unwraps before these events.

`frames.jsonl` preserves every ACP line, direction and scenario without rewriting IDs or text.
`tool-frames.json` is a parsed subset, not synthesized events. Model responses are scripted
inputs; model request logs omit bodies/headers and record only routing/tool names. Stderr and
final workspace snapshots remain evidence. Run `python3 verify.py` for hashes, byte-to-frame
correspondence, coverage, approval ordering and resulting edit state. No application test claim
is made by this S0-only change.

The Node executable was extracted from `node:22-bookworm` image
`sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8`
and reports `v22.23.3`. The Python image is pinned in `PROVENANCE.json`.
Do not mount a user home, Docker socket, profile or credential directory.

After capture, copy the evidence files into this directory and run `python3 derive.py`
to regenerate the parsed subset and observations. Regenerate artifact hashes in provenance
for a new capture; `verify.py` deliberately rejects changed evidence.
