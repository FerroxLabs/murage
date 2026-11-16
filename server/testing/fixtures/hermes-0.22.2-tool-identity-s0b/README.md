# S0b: tool identity capture

Fixtures only, from Murage base `5cf79747a20edc2103bf80b90ff5c265f461e7bc`.
No approval/runtime implementation changed. These are real engine subprocesses,
not synthetic ACP builders or mocked hook producers. See `PROVENANCE.json` for
hashes, isolation, source references and gate results.

## Gate answers

**G1 — captured.** `video_analyze` has the bare title `video_analyze`, kind
`other`, and exact `rawInput` arguments (`frames.jsonl:9`). The missing local
video produces a failed completion at line 10. This proves the frame shape,
not successful video analysis. It agrees with the video row already in S0.

**G2 — the no-start premise FAILS; fallback B is required by §11.** The stub
sends the literal, direct function name `memory: x` (no `tool_call` bridge).
Hermes repairs it to the registered name `memory`, emits
`memory: +memory: "s0b unregistered name"`, kind `other`, then saves the note
without a permission ask (`frames.jsonl:16–17`). The model's arguments are
ordinary memory arguments; the name is the probe. In contrast, direct `zz`
produces zero starts and the next model request contains
`Tool 'zz' does not exist`.

This is **not** evidence that an arbitrary unknown dispatch name can spoof a
free-tool title. Upstream `agent/turn_tool_validation.py:101–115` repairs names
before validation, and `agent/agent_runtime_helpers.py:2632–2680` uses fuzzy
matching with cutoff 0.7 after simpler repairs. The emitted title describes
the actual registered `memory` dispatch. Nevertheless §11's stated condition
is met by the requested model input: later slices must move C1 tools pinned
`other` to the hook, or obtain an explicit design amendment explaining the
repair distinction. S0b does not implement S2's fallback.

**G3 — captured; §5.6 needs amendment.** Plain `execute_code` has only its
Murage hook ask. The script importing `hermes_tools.terminal` and invoking
`python3 -c 'print(42)'` produces this order:

| Wire line | Event |
| --- | --- |
| 35 | `execute_code` hook ask |
| 38 | `execute_code` start |
| 39 | nested `terminal` hook ask |
| 42 | native dangerous-command ask, `script execution via -e/-c flag` |
| 45 | same `execute_code` completes, nested output `42` |

There is **no `terminal` start**. Binding every native command ask only to an
open terminal execution (§5.6) would reject this real execution; the nested
hook token also has no terminal start to consume it. The callback is real,
not injected by the fixture. Source: `tools/code_execution_tool.py:613–614`
propagates the approval context to sandbox RPCs. `tools/approval.py:1180–1248`
explains why whole-script approval is skipped in a CLI context and nested
terminal guards still run. This probe does not enumerate all gateway/ask modes.

**G4 — captured on Codex CLI 0.167.0.** A fresh, trusted `PreToolUse` recorder
and a loopback Responses stub produced:

| Model call | Hook `tool_name` / input | Execution item (same call ID) |
| --- | --- | --- |
| `exec_command`, `printf s0b-codex` | `Bash`, `{command:"printf s0b-codex"}` | `commandExecution`, `call-0` |
| `exec_command`, `apply_patch` heredoc | `Bash`, `{command:whole heredoc}` | `fileChange`, `call-1` |
| namespace `mcp__s0b`, function `echo` | `mcp__s0b__echo`, `{text:"s0b-codex-echo"}` | `mcpToolCall`, `call-2` |

The patch wrote `proof.txt` containing `s0b\n`; MCP returned the fixture text.
This is an additional identity-parity counterexample: an execution's
`fileChange` type alone does not recover the hook name. `codex-hooks.jsonl`
preserves raw deliveries; `codex-frames.jsonl` preserves the handshake, trust
write, and execution notifications. A standalone custom `apply_patch` model
call was not offered by this configuration and was rejected in pilot runs;
no direct `apply_patch` hook delivery is claimed. Other Codex versions/tool
configurations are not established by this capture. The model label `gpt-5.4`
selects local tool configuration only; every response came from the stub.

**G5 — OPEN.** No gate-box installation path or credential-free installation
artifact was supplied or available in S0. We verified the public source SHA
`d923a5eb487a17c0a68801bba9ef0f56c81040a8`, every archived source file, the same
Python/Node/CLI executable hashes, and the same dependency versions as S0.
That establishes S0/S0b capture equivalence, **not gate-binary equivalence**.
The copied install stamp is S0's generated stamp; it is not independent gate
evidence. R1 remains open; no version-pin relaxation is justified.

## Reproduce offline execution

All capture and verification commands ran through
`<build-host>/tools/it-remote.sh` with `IT_JOB=bld-toolid-s0b`,
`IT_W=<build-host>/swarm-b/toolid-s0b/wt`, and
`IT_ORIG=<build-host>/tools/it-local-generic.sh`. The wrapper supplies
`node:24-bookworm`, uid 2001, `--network none`, and a fresh HOME. Hermes ran on
`murage-vt5`; subsequent short checks and Codex used the wrapper's local
fallback (`IT_BOXES=' '`, host load below 60). At most two containers existed
at once, and observed host load remained below 85. No vtq was used.

Prepare `.s0b-runtime/` in the worktree with these public inputs (no user home,
profile, credentials, or Docker socket in the execution container):

1. S0's archive, SHA256 `616649f8ac7e3bb186999d000d77511e733b3930bd2b5921be4a85673320ef8b`,
   as `hermes-source.tar.gz`, extracted with its original top directory.
   Copy S0's `install-stamp.json` into that source directory.
2. `/usr/local` from S0's Python image into `python/`; `/usr/local/bin/node`
   from S0's Node image into `node`. Image IDs are in provenance.
3. The public wheels pinned in `requirements.txt` into `wheels/` (CPython
   3.14, x86-64 manylinux/abi3). Wheel retrieval is preparation only. The
   actual installation uses `pip --no-index --no-deps` inside the networkless
   container. Public wheel hashes are recorded in `wheel-inputs.json`.
4. The executable from the public installed `@openai/codex-linux-x64` 0.167.0
   package as `codex`, with its hash checked against `codex-runtime.json`.

Use an **empty evidence directory**: copy only the capture scripts,
`scenarios.json`, `free-tools.json`, `ask-hook.cjs`, `mcp-stub.py`, and
`requirements.txt` into it, then adjust `FIXTURE` in the launcher to that
directory. `capture.py` writes beside itself. Each invocation needs a fresh
container; the scripts deliberately refuse an existing fixture HOME. The
Codex HOME is `.s0b-runtime/codex-home`, created by the script, because this
Codex refuses helper aliases under `/tmp`. Remove only that job-owned HOME
before a second Codex invocation. It contains no login or auth material.

Run via the wrapper:

```sh
bash server/testing/fixtures/hermes-0.22.2-tool-identity-s0b/run-capture.sh
python3 server/testing/fixtures/hermes-0.22.2-tool-identity-s0b/capture-codex.py
python3 server/testing/fixtures/hermes-0.22.2-tool-identity-s0b/verify-source.py
python3 server/testing/fixtures/hermes-0.22.2-tool-identity-s0b/verify.py
```

The first script is derived from S0's `capture.py`: it relocates the pinned
runtime, adds direct-name probes, and records fixture tool results. The real
Murage hook bytes and base free-tool matcher are unchanged. The subprocess
environment remains an explicit allowlist. Interfaces are asserted to be
`['lo']`; model responses are scripted; nothing is billable. Hermes source
is not modified. Source/runtime files are writable in the wrapper's worktree
mount (unlike S0's read-only mounts); `verify-source.py` compares every source
file after the capture, and Python bytecode writing is disabled.

`verify.py` checks the committed evidence offline, including exact hashes and
G1–G4 observations. G5 is explicitly skipped, not passed. Initial missing-file
RED and the real G2 premise failure are preserved in `red-*.log`.
`check-design-premise.py` reproduces the intentional G2 failure. Artifact
verification is GREEN because it asserts the observed counterexample;
this does not turn the design gate green. Regenerate provenance hashes only
for a deliberately new capture.

All fixture processes/containers were stopped; prepared source, runtimes,
dependencies, wheels, Codex HOME, and remote node_modules were removed after
verification. Only scripts, fixtures, logs, hashes and reports remain. No
Murage server/conversation workflow claim is made by this fixtures-only slice.
