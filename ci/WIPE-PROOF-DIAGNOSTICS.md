# Wipe CI diagnostic inventory

Owners: wg-ci owns these CI diagnostics and artifact consumption; wg-proof owns
the harness diagnostics in `server/wipe-proof/DIAGNOSTICS.md`; wg-winproof owns
the Windows plain-text launcher and its reference-list diagnostics.

These are operator messages in CI logs and JSON artifacts. They are not app UI
copy. An assertion or runtime error fails the step and is retained in the log
and `error` field where the wrapper has opened its artifact stream.

| Source | Message | Meaning |
| --- | --- | --- |
| `wipe-proof.mjs` | `Usage: node ci/wipe-proof.mjs posix\|windows-text EVIDENCE_DIR [powershell\|pwsh]` | Invalid mode or missing destination; fails before opening artifacts. |
| `wipe-proof.mjs` | `Evidence must be outside the checkout` | Reject an evidence destination in the source tree. |
| `wipe-proof.mjs` | `Unsafe evidence directory` | Reject a filesystem root or `/dev` destination. |
| `wipe-proof.mjs` | `Node 24 is required` | The runtime lacks the required native TypeScript support. |
| `wipe-proof.mjs` | `PASS safety/non-temp-root-refused` | The shared guard refused filesystem/temp roots and admitted fresh temp scratch. |
| `wipe-proof.mjs` | `Windows text proof requires real Windows` | The native launcher cannot be qualified on another OS. |
| `wipe-proof.mjs` | `Explicit PowerShell version required` | The caller must select `powershell` or `pwsh`. |
| generated PowerShell command | `Required PowerShell version missing` | Refuse a version other than 5.1 or 7, respectively. |
| `wipe-proof.mjs` | `Proof process failed` | The child returned a nonzero exit status. |
| `wipe-proof.mjs` | `FAIL line in proof output` | A child printed a failure despite its exit status. |
| `wipe-proof.mjs` | `Proof summary has failures` | The parsed summary reports failures. |
| `wipe-proof.mjs` | default assertion, expected `production-guard` | The POSIX child did not report the production guard mode. |
| `wipe-proof.mjs` | `Git Bash/bash proof missing` | The required successful Bash literal-root witness is absent. |
| `wipe-proof.mjs` | `Windows corpus must remain text only` | The Windows summary reports executed commands. |
| `wipe-proof.mjs` | `FAIL ci-proof <error>` | A caught assertion, process, I/O or JSON error; details are also in JSON `error`. |
| `wipe-proof.mjs` | `<PASS\|FAIL> PROOF-<platform/version>; artifacts: <destination>` | Final status and artifact location; exit code agrees with status. |
| generated backend in `run-real-proof.mjs` | `client-env-leaked` | The backend inherited the client-only Electron environment flag. |
| generated driver in `run-real-proof.mjs` | `fixture-block-node-unavailable` | Linux could not create inert temp block metadata. |
| generated driver in `run-real-proof.mjs` | `FAIL fixture-setup-or-run` with error details | Setup or proof execution raised an exception. |

The two `assert.rejects` safety checks expect `unsafe-fixture-root`. A missing
rejection produces Node's default assertion diagnostic. Uncaught file, spawn,
cleanup and stream errors retain Node's native diagnostics and nonzero status.
The recipe's generated driver also retains harness `PASS`/`FAIL`/`UNAVAILABLE`
case reports and the final JSON summary; see the harness inventory for those
messages. The timing case label is `fast-path-at-most-10ms`, under MAIN
1114-WG-SHIM-TIMING. The wrapper JSON contains mode, platform, tempRootGuard,
failed, proof, exitCode, optional engine and error; proof preserves the producer
summary unchanged. Artifact labels are `PROOF-LINUX`, `PROOF-MACOS`,
`PROOF-GIT-BASH`, `PROOF-WINDOWS-PS51` and `PROOF-WINDOWS-PS7`.
