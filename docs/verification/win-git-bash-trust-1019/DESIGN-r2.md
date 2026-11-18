| Review point | Concrete decision | Section / proof |
|---|---|---|
| Overall DISAGREE: safe refusal does not deliver the feature | Deliver positive Claude, Pi and Fuigo execution binding, installed per-user Git qualification, scanner relief and same-turn execution in 1.0.19. A disabled exception is a failure of feature acceptance. | §§1–10; GB01/11/16/17 |
| Q1: artifact provenance | Pin Git for Windows 2.51.2.windows.1 x64 reference bytes; the eight actual member digests below replace the empty-manifest proposal. Qualify installed copies by bytes, layout and execution identity, never by discovery. | §2; GB03/16 |
| Q2: Fuigo binding | Require protocol `murage/bash-launch/1`, a pre-execution process-bound acknowledgment and broker-owned creation. Add the engine-side implementation described below; Fuigo 1.0.40 alone is insufficient. | §3.4; GB16 |
| Q3: same-turn integration | Pin NL-ST4 `8bddd0b22c077847185c081309883c82d23adfa2` as the integration input; port its contract to this base's reader, not its obsolete symbol locations. Preserve plain/cd, Bash/sh, LF/CRLF. | §8; GB11/12 |
| Q4: replacement and loaded images | Hold executable/runtime/component handles; the native launch supervisor checks actual process/image-load events before continuation. A static import inventory alone does not establish loaded-image selection. | §6; GB07/19 |
| Q5: updates and Stop | Revoke admission immediately, terminate/drain the job and descendants, await native completion, then release. An engine/UI completion is not release evidence. | §7; GB07/08/14 |
| Q6: ACLs | Evaluate object-scoped mutation and parent replacement rights. Ancestor create-sibling rights alone do not reject a protected existing child. Unknown ACE/identity cases refuse relief. | §6.3; GB06 |
| Q7: budgets | Keep 2 s, 256 members, 64 MiB/member, 256 MiB total, 128 lease slots; add worker, queue, handle, ancestor and child caps. Pending/canceled/draining work retains its reservation. | §7.2; GB14/20 |
| Q8: all Windows Bash missing-state branches | Run the Bash classification before the `at` guard and lookup early exits. Every recognized non-system Bash occurrence without complete proof marks; old system-root behavior remains. | §5; GB02/14 |
| Q9: No limits negative controls | Independently assert trust=false, findings retained, and the final policy verdict. Failed verification alone does not cause a new card. | §9; GB15/18 |
| Q10: kept set | Preserve explicit owner denies, wipes and `murage-engine-hooks`. The self-integrity decision is settled; no Sean decision is outstanding. | §§8.3,9; GB15 |
| Q11: Settings and UX | No preference, enrollment, repair card, PATH repair or automatic shell substitution. Preserve Advanced values and existing unsupported-shell execution choices. | §§3,9; GB22 |
| Amendment 1: concrete qualification attachment | Embed the package source, verified package/member digests, supported target matrix, fixture definitions and evidence-status ledger. Distinguish measured bytes from unmeasured runtime and unavailable historical traces. Do not claim the latter exist. | §2 |
| Amendment 2: per-engine launch contracts and wrapper chain | Freeze invocation fields and one native execution authority; name Claude wrapper, Pi extension and Fuigo engine-side changes, acquisition and completion. Remove PATH-selected helper execution from the qualified Windows wrapper route. | §3; GB16/21 |
| Amendment 3: first-scan ordering | Prepare and bind before ACP source judging and non-ACP item emission; carry private context through `index.ts`. Serialize updates by call revision; preserve registration-before-mark and allow-time registration. | §4; GB08/23 |
| Amendment 4: exhaustive decision table | Cover absent/invalid cwd, probe, lookup, undefined/null/non-file/error, missing/revoked context, alias and system-root cases explicitly. | §5; GB02/14 |
| Amendment 5: implementable native contract | Specify acquire/inspect/revalidate/launch/revoke/release, handle ownership and modes, component traversal, security descriptors, actual loader enforcement, startup inputs and all-member exclusions. | §6; GB05–09/19 |
| Amendment 6: complete lifetime and capacity | Freeze states, cancellation/late-result rules, restart overlap, descendants, crash behavior and exact release ownership; bound every resource category. | §7; GB07/08/14/20 |
| Amendment 7: reviewed reader integration map | Leave byte retrieval and literal walking intact. Remove only the selected Bash's outside-root i10 cause; same-turn provenance belongs to NL-SAMETURN. No claim that base contains `shellBody`. | §8; GB11/12 |
| Amendment 8: tests, dependency revisions, estimate, reviews | Adopt the argv design's final conservative fallback, not its withdrawn grammar table. Identify actual dependency SHAs and unsatisfied evidence; require both reviewers on the complete packet; replace seven sessions with nineteen. | §§8–10 |
| Wave 0 | Freeze this packet, interfaces, artifacts, dependency ports and historical/equivalent replay inventory; capture real baselines when execution is authorized. | §10, W0 |
| Wave 1A | Implement manifest policy, private invocation registry and bounded lease coordinator. | §10, W1A |
| Wave 1B | Implement and qualify native protection/supervision; one owner controls addon ABI and packaging. | §10, W1B |
| Wave 1C | Implement Claude/Pi/Fuigo contracts, including Fuigo engine-side work and wrapper inputs. | §10, W1C |
| Wave 2 | Integrate scanner, ACP, `index.ts` and the fixed reader seams after the interfaces work. | §10, W2 |
| Wave 3 | Complete policy/Advanced regressions and packaged standard-user Windows qualification, then independent code review. | §10, W3 |
| Factual-correction paragraph | Retain the verified base facts and correct the additional argv/provenance assumptions; a ledger report is not replay proof. | §§1.2,2.4,8 |
| Sean-only question | None. Artifact custody, source integration and runtime proof are engineering obligations, not new product decisions. | §10.3 |

# WIN-GIT-BASH-TRUST-1019 — revision after Astra review

Revision identity: **gitbash/DESIGN-r2.md**, superseding `gitbash/DESIGN.md` (whose internal header also called itself r2). Review target: `/fixture/jobs/odes-gitbash/last.txt`. Status: **READY FOR REVIEW; not approved for implementation or release**. This document contains proposed implementation contracts and test obligations, not a claim that they exist or pass.

## 1. Scope and evidence discipline

### 1.1 Required result

On local Windows execution, remove only the interpreter finding caused by the requesting engine's exact verified, selected Git Bash being outside the scanner's static system roots. Keep script/body inspection, arguments, owner denies, wipes, self-integrity, origin rules, startup/environment findings, download/clone findings and scan budgets. Keep the full 1.0.19 scope: Claude, Pi, Fuigo, the Codex control, standard-user per-user Git, plain/cd same-turn Bash/sh scripts and LF/CRLF. Unsupported configurations receive no new exception; that fallback does **not** count as successful delivery of the supported matrix.

No folder becomes trusted. `sh.exe`, Git tools, helpers and DLLs do not acquire scanner exemptions because they are members of the protected launch chain. There is one exempt executable pathname per engine selection. A selected `bin/bash.exe` launcher may require protecting `usr/bin/bash.exe` as its implementation; a separate command naming that second file still needs its own selection and binding, and is not exempt merely because it is a runtime member.

### 1.2 What was inspected

All repository citations below are relative to **`/work/fuigo-builds/orph/_base`**, HEAD **`c12aaad9341e8f87126a193f35b5c2768f0aa66f`**, checked by read-only Git metadata. Repository code was read as bounded `grep -n` ranges. No repository code, build, test, engine, installer or Windows executable was run. A downloaded upstream Git archive was treated as data: authenticated-source package metadata, archive extraction, PE import-table inspection and SHA-256 calculation only. The Git self-extractor and its contents were never executed. This is artifact evidence, not behavioral qualification.

| Base evidence | Consequence |
|---|---|
| `server/outside-scan.ts:899–915,947–965,1582–1586` | Static roots include the C-drive Windows roots even on other platforms. Named paths and bare names have different behavior. `at`, lookup absence, undefined, null and missing probe results can bypass i10 today. |
| `server/outside-wire.ts:168–201,445–465` | Current checks use stat/realpath, two-byte magic and freshness; `resolvedProgram` checks cwd containment, not all trust exclusions. No cryptographic execution identity is supplied. |
| `server/outside-scan.ts:587–634,785–796` | Hooks are exhaustive/guarded and probes are cached/bounded per scan. Add explicit hooks and context; never infer a live lease from the probe cache. |
| `server/tool-discovery.ts:22–38,69–77,93–142` | Override, handed-PATH Git, exec-path, relative fallback and fixed candidates are discovery only. Cache identity is realpath/dev/ino/size/mtime, not authenticity. |
| `server/engine-env.ts:112–114,423–435`; `shared/mount-identity.ts:170–193,206–220` | Checked environment and discovery string are useful inputs, but neither is a launch commitment. Public ExecEnvInfo must not expose lease material. |
| `server/always-ask.ts:2016–2074` | Existing WIN-PWSH handles bare bash/sh, exact realpaths and optional inode comparison, including sibling sh. Preserve that existing rule; do not import its stat-failure fallback into the new trust contract. |
| `server/drivers/claude.ts:1755–1778,1797–1822,5311–5313`; `server/drivers/murage-exec:39–105` | Claude selects Bash, but its prefix has a separate helper/environment chain and MCP startup path. Item emission precedes release of a waiting ask. |
| `server/drivers/pi.ts:724–741,981–1001,1248–1271,1401–1403` | Explicit shellPath is generated into an extension, but item emission and card-time checking are separate. Replace the extension's launch authority, not just its informational shell string. |
| `server/drivers/acp/core.ts:2869–2874,3793–3816,4005–4010,4544–4564,4587–4604` | ACP judges merged facts at source before its environment card check; later starts/updates can contain changed inputs. |
| `server/index.ts:9508–9515`; `server/outside-wire.ts:764–782` | Non-ACP starts scan in index; interpreter marks become turn-wide. A later verifier cannot erase the first mark. |
| `native/engine-exclusion/exclusion.c:2143–2159`; `server/engine-exclusion.ts:63–91,146–155` | Owner inspection shares writes/deletes and closes its handle. Existing jobs/process-start identity are useful primitives, but no executable lease or loader enforcement exists. |
| `server/shell/walk.ts:507–526,1908–1928,2791–2795,3524–3543` | Current reader already retrieves session bytes and walks literal shell bodies. No current `shellBody` obstacle is established. |
| `electron-builder.yml:36–110`; `scripts/prepare-fuigo.mjs:47–65,97–117` | Packaging does not establish bundled Git Bash; it does establish a pinned Fuigo 1.0.40 reference. Windows arm64 Fuigo staging is explicitly refused on this base. |
| `server/auto-approve.ts:1203–1210,1587–1603` | Base owner eligibility is narrower than the later No limits contract; the hook self-integrity hold already exists. Trust must not alter this policy by accident. |

`docs/verification/README.md:8–23,57–67` requires isolated fixture action/result evidence and exact-child cleanup. Those are obligations for future qualification; this task's prohibition on execution takes precedence over running them now.

## 2. Qualification attachment Q-A1 (embedded, version 1)

### 2.1 Selected artifact and target matrix

The first reference set is **Git for Windows 2.51.2.windows.1, PE AMD64**, installed in either Program Files or a normal private per-user directory, with the release layout preserved. The reference source is the upstream [signed-tag release and SHA-256 table](https://github.com/git-for-windows/git/releases/tag/v2.51.2.windows.1), corroborated by its GitHub release-asset digest. Reference package:

`https://github.com/git-for-windows/git/releases/download/v2.51.2.windows.1/PortableGit-2.51.2-64-bit.7z.exe`

Length **60,097,272 bytes**; SHA-256 **`f5764d546ff9a2511b50ec4e20424c5f4669de1695abc3fa4128e7f7d4a7b2cd`**. The downloaded package's calculated hash matched both published values. This authenticates the reference through the release source; it is not a claim that the package has a separately verified Authenticode signature. Murage's reviewed release embeds the resulting reference table. Runtime does not fetch a manifest, learn first-seen hashes or trust a manifest beside Git.

Portable packaging is the source of reference bytes, not a requirement to move the owner's installed Git. An installer-created Git whose protected members match these bytes and layout qualifies identically. Different-version installs remain available for execution through existing policy; they do not match this reference set. No automatic update, install or selection change is introduced.

| Qualification target | Required version and architecture | Required proof |
|---|---|---|
| Murage | 1.0.19, Windows x64 package, local standard user, NTFS | Real packaged helper, manifest and launch-supervisor capability; per-user and Program Files positives. |
| Claude | Qualification pin 2.1.307, Windows x64, Murage adapter protocol 1 | Prefix and outer-shell supervision, real tool call and MCP control. The base's 2.1.307 environment table is at `server/drivers/claude.ts:1723–1726`; this is a selected test version, not a claim of Windows qualification here. |
| Pi | Qualification pin 0.80.5, Windows x64 Node, generated extension protocol 1 | Real Bash execution through the extension and completion/drain. Base minimum is `server/drivers/pi.ts:165–167`. |
| Fuigo | **New engine build 1.0.42 with `murage/bash-launch/1`**; Windows x64 | Version alone never suffices: authenticated artifact pin, capability and process-bound acknowledgment are required. This is a required new build, not a claim an upstream 1.0.42 already implements it. |
| Fuigo baseline control | 1.0.40, Windows x64 | Prove missing capability grants no trust. Base binary SHA-256 `8e976d0c8f0c63598a33f3330b627f556ad448daac986a8a7b83500fc62545ed`, package hash `8e979957d45acfc65f8de204cf2def366abfef34f4be07f6711dbd88176c68d6`: `scripts/prepare-fuigo.mjs:97–100`. |
| Codex control | 0.162.1, Windows x64 | No Bash lease added by this lane; same routine control outcome. `docs/verification/model-defaults-artifacts.json:3–7` identifies the version but its Linux digest is **not** a Windows artifact pin. |
| Other existing platforms/architectures | Existing support and selection behavior unchanged | POSIX parity; unsupported native capability produces no exception. This does not lift the base's explicit Windows arm64 staging refusal (`scripts/prepare-fuigo.mjs:104–117`). |

New engine/package binaries must have their actual Windows byte receipts attached before qualification acceptance. This is not satisfied by the current Fuigo 1.0.40 receipt or by a Linux Claude/Codex receipt. Future version support adds a reviewed reference row and the same qualification matrix; no semantic-version range grants trust automatically.

### 2.2 Actual reference members

These are measured archive members, not illustrative hashes. The table is the complete **permitted non-system launch-image set for reference layout GFW-2512-X64-1**. Static import closure was computed from the five named executable members; all eight have empty PE delay-import directories. Dynamic-image enforcement in §6 remains mandatory: this table is not evidence that no additional DLL is loaded at runtime.

| Relative member | Bytes | SHA-256 |
|---|---:|---|
| `bin/bash.exe` | 47,008 | `3e90094a809e73ba5d4dbd00c48d2eec702adcc68145a7d7f764fa9f26454444` |
| `usr/bin/bash.exe` | 2,553,064 | `fc362aae1f217d34d02237d99527839dd6cf85b37c7a0277109400bfa0faa594` |
| `usr/bin/cygpath.exe` | 53,959 | `5e701f516240ef651896de22da94c3dd72c603108201276920dfcf3fae6502bd` |
| `usr/bin/env.exe` | 44,180 | `b5d80f13e6b4b422a8c22d32be9cc1f5fd9b482fc60008ed80e513a2fa938cdc` |
| `usr/bin/msys-2.0.dll` | 3,360,863 | `b41bfda735cd7686ab4c2b56b4cc6a6fc6c33992b1739626be94d7ae1e8eed0b` |
| `usr/bin/msys-iconv-2.dll` | 1,098,126 | `5d890c42222c7b86519f7c368836cc2930f11dc975341b7ded30f26ef8770e0b` |
| `usr/bin/msys-intl-8.dll` | 111,181 | `50f7de0c712d867ddca2c9eb8562ca6ee2d69e120e798ec6126ad29dd1ed5402` |
| `usr/bin/uname.exe` | 35,876 | `1cba275ff8e0c81f48898f017758c558ee5951cb0448c36628580beffdf4ef89` |

Total **7,304,257 bytes**. `usr/bin/bash.exe` imports `msys-2.0.dll`; `env.exe` and `uname.exe` additionally import `msys-intl-8.dll`, which imports `msys-iconv-2.dll`. Those DLLs in turn import `msys-2.0.dll`. The direct Windows import names observed across these members are `KERNEL32.dll`, `ntdll.dll`, `USER32.dll`, `SHELL32.dll`, `SHLWAPI.dll`, `USERENV.dll`, and `msvcrt.dll`. Transitive Windows modules are OS images under §6.4, not per-user Git exemptions.

Two layouts are supported without a folder exemption: GFW-BIN selects `bin/bash.exe` and protects its delegated `usr/bin/bash.exe`; GFW-USR selects `usr/bin/bash.exe` directly. Both acquire all eight reference members for one bounded, deterministic contract. Helpers are included for provenance and legacy-wrapper negative controls, but the qualified Windows prefix described in §3.2 does not PATH-launch them. Both layouts must pass the installed standard-user positive; if an installer variant changes these bytes, it needs an additional real reference row, never a version-string override.

Strict manifest schema: `{schema:1, referenceId, gitVersion, machine:0x8664, layouts, members:[{relative,bytes,sha256}], launchProtocol:1}`. Reject unknown keys/schema, duplicates (including Windows equivalent names), zero/missing hashes, absolute or escaping members, ADS, architecture mismatch, missing members, excessive size/count and unsupported entry layout. Do not use local filenames to select a different reference after a hash failure. Bind the selected reference ID into the private launch record.

### 2.3 Replay fixtures and baseline capture contract

Add `server/testing/fixtures/win-git-bash-trust/` with the following concrete fixture families. These are **new synthetic fixture definitions**, not invented historical recordings:

* `claude-plain.json`: engine tool `Bash`, command `printf '#!/bin/bash\necho ok\n' > hello.sh && bash hello.sh`; literal private cwd `C:\Users\fixture\work`.
* `claude-cd.json`: the same text prefixed by `cd /c/fixture-home/work && `, with the engine's effective native cwd separately recorded. Also run the Write-then-`./hello.sh` form; the native binding records the actual routed interpreter.
* `fuigo-pwsh.json`: ACP `kind:"execute"`, `toolCallId:"fixture-call-1"`, raw command `& 'C:\Users\fixture\AppData\Local\Programs\Git\bin\bash.exe' './build.sh'`; `build.sh` contains `echo ok`. Pair with the protocol-1 prepare/ack/allow/completion transcript. The outer dialect stays PowerShell.
* `codex-control.json`: the same harmless script and effective cwd through Codex's existing shell path, with no private trust context.
* Expand Bash and sh shebangs (`/bin`, `/usr/bin`, `/usr/bin/env`), LF/CRLF, native drive paths and MSYS cwd spellings, explicit Bash script arguments, direct execution, plain and cd-prefixed forms. Preserve source bytes and offsets; do not normalize command text before recording its revision digest.

Historical capture names remain **`gwin wsb\l9nl12-fu1`**, **`gwin wsb\l9nl13-cx`**, and **LEGS10 hello.sh**. The original design identifies those names but supplies no raw transcript. The supplied review also does not supply one. They must not be relabeled as the synthetic fixtures above. The historical NL-ST4 report at `../_ev/handoffs/FIX-LEDGER.md:4824` identifies the shebang diagnosis/commit, not an execution record on this base.

For every real baseline/candidate run, the qualification script writes: Murage SHA/package hash, actual Windows engine version/hash, reference ID, fixture ID and sanitized fixture hash, native architecture, standard-user flag, initial effective cwd category, ordered event stages, all deciding scanner branches (including i8/i9/i10/i11/i13), marks before/after, final policy source/rule, card count, exit/result marker, active-child/handle counts and acquisition time. Store raw commands only in controlled fixture artifacts; public diagnostics remain value-free. Preserve the original logical structure, quoting, line endings and path relationships when sanitizing a recovered historical capture.

### 2.4 Evidence status — explicit, not an empty attachment

| Item | Evidence now | Acceptance obligation |
|---|---|---|
| Base, source seams, current policy/reader behavior | Source and Git metadata inspected | Refresh citations after dependency ports. |
| GFW package and eight member digests | Measured, authenticated-source package hash matched | Reproduce against release input; compare installed-layout members on Windows. |
| Native runtime closure, standard-user ACL/loader/race behavior | Not executed, as requested | GB06/07/19 on real packaged Windows must pass; static imports alone do not close it. |
| New Fuigo protocol binary and Windows Claude/Pi/Codex receipts | Not present in base | Build/pin required engine-side implementation and attach actual target receipts. |
| Original LEGS raw logs | Not supplied/located in the evidence read for this revision | Retrieve and sanitize those exact captures; if irretrievable, explicitly record that and obtain both reviewers' acceptance of newly recorded equivalent real-engine cases. Never assert exact replay without the original. |
| GB01/11/12/17 real baseline results | Unmeasured | Capture base first; preserve already-passing outcomes. No behavioral RED claim from the old ledger. |

This ledger is a factual limit on evidence, **not a scope reduction or permission to ship unqualified behavior**. Amendment 1's demand for already-completed real baseline attachments cannot honestly be represented as satisfied under this task's no-execution instruction. The artifact-reference gap is materially reduced here; runtime/historical evidence stays a blocking acceptance item within the same release. Engineering supplies it; Sean is not asked to decide it.

## 3. Invocation contract and engine execution authority

### 3.1 Private common contract

New `server/engine-bash-binding.ts` owns a record for each exact executable occurrence:

`{protocol:1, invocationId, engineKind, engineInstanceId, enginePid, engineCreationTime, engineImageId, connectionEpoch, threadId, turnId, callId, callRevision, occurrence:{dialect,treePath,startByte,endByte,role}, inputDigest, selectedNativePath, selectedVolumeId, selectedFileId, effectiveCwdNative, effectiveCwdId, envGeneration, effectiveEnvDigest, referenceId, leaseRef, state}`.

The server allocates IDs/nonces and derives revision digests from full merged input, parser occurrence and exact handed environment. Neither rawInput, `_meta`, a model-generated pathname nor a user-visible event may construct this record. The bound occurrence includes wrapper nesting: an outer leased Bash is not evidence for a later bare Bash in its script. If command parsing cannot identify the occurrence without changing its semantics, it receives no new trust.

Native path selection uses handle-derived canonical names and volume/file IDs, never lowercasing or `/c/` string replacement. The engine adapter supplies its exact execution cwd/environment before scanning; the native launcher applies that same snapshot. Replacing cwd, PATH/PATHEXT, env, command bytes, parser occurrence, engine process, connection, thread, turn or generation invalidates the binding. A changed generation requires reacquisition; no old-epoch callback can commit a positive result.

Acquisition is before the first relevant scan (§4). Commit is after policy allows and before process continuation. Completion is a native execution ticket's `drained` event, including descendants; a tool result is only application-level completion. The server stores the native lease object in a private map/WeakMap. Public ExecEnvInfo, tool input, cards, persistence and environment variables contain no authorization token or native handle. An opaque correlation ID alone grants nothing.

The launch supervisor is the execution authority: it creates the selected image, or intercepts the engine's selected-image child at its initial debug event before user-mode execution. It checks the expected occurrence, actual image, cwd and environment, and permits continuation only for an existing committed binding. Unbound commands still execute through established policy; they receive no exception. An already-admitted invocation whose native binding fails does not silently run a different executable or retry after side effects.

### 3.2 Claude: both wrapper and outer Bash

Base launch chain: selection/environment pins at `server/drivers/claude.ts:1755–1778`; per-turn environment file at `:4239`; `murage-exec.ts:41–79` installs the script and rewrites its data file; `murage-exec:64–82` PATH-resolves `uname`, `cygpath` and `env`. MCP prefix startup has another Bash lookup (`claude.ts:1797–1822`). Selection strings alone cannot authenticate this chain.

Decision: add a packaged **native Windows prefix `murage-exec-win.exe`**, sourced by new `native/engine-exclusion/murage-exec-win.c`, and a protocol-1 Windows branch in `server/drivers/murage-exec.ts`. Keep the POSIX `murage-exec` script unchanged. The Windows prefix reads its per-invocation cwd/env snapshot over a private inherited/broker channel and asks the native supervisor to create the exact selected Bash with explicit application name, argv, cwd and environment. It performs Windows/MSYS path conversion with a versioned native mapping routine, not by executing `uname`, `cygpath` or `env`. Its adapter output must match the actual child cwd/env in GB21, including spaces, Unicode, drive paths, UNC refusal and semicolon PATH handling. It must preserve existing MCP kept-variable semantics from `murage-exec:14–37,84–105` and `murage-exec.ts:88–102`.

The old helper chain is therefore an explicitly unqualified legacy path, not an unexamined part of a successful lease. The old script remains in the file map for POSIX/MCP regressions and to prove it is not selected on qualified Windows calls. PATH-first fake helpers must have no effect on the native-prefix path; direct execution of those helpers gets no Bash exception.

Claude may start an outer Bash before the prefix. Start the Claude engine under the native supervisor, with its existing job, before permitting any tool call. Track selected-Bash children from creation; match the outer shell's full command and the expected prefix to the call reservation before continuing. The native prefix's inner shell is a separately registered occurrence in the same invocation. A different image, different prefix, reordered command or unexpected second selected-shell child cannot consume the reservation. Other engine/MCP processes are tracked for lifetime but do not inherit Bash trust. The supervisor must handle the MCP cross-spawn route without mistaking it for a model tool invocation.

Before the driver emits `item.started` at `claude.ts:5311`, await `prepareInvocation`; then emit with private context available to index and release `startedToolKeys` only afterward (`:5313`). The ask-before-item path uses the same keyed preparation promise instead of waiting for a scan that cannot happen. Approval gates may inspect untrusted input; they cannot create a lease from a tool title.

### 3.3 Pi: extension owns the actual spawn

Replace the generated `createBashTool(...,{shellPath})` launcher at `pi.ts:737–741` with a protocol-1 generated extension that retains the tool schema/result/cancellation behavior but calls the private native broker for execution. It sends prepare before `tool_execution_start` can be judged, then receives allow/deny for the same call revision and executes the exact returned execution plan. It cannot fall back to `createBashTool` after a trusted admission. Preserve `--no-extensions` plus the explicit generated extension (`:991–995`), the owner's Advanced settings and the gate's original input-echo semantics (`:1349–1357`).

Register the extension by its server-generated source digest and engine-process identity. An extension request with only the public call ID is insufficient. Transport is an inherited/private channel bound to the spawned Node process, not a model-writable setting. The driver buffers the start at `pi.ts:1248–1259` until preparation; native `drained` completes the lease use even if `tool_execution_end` at `:1262–1271` has already arrived.

### 3.4 Fuigo: mandatory engine-side protocol

Base Fuigo is ACP (`server/drivers/acp/fuigo.ts:1,38`) and uses the existing permission-policy handshake (`server/drivers/acp/fuigo-policy.ts:30–36`). Reuse its **pattern**, not its permission-policy acknowledgment as proof of shell binding. Windows outer PowerShell remains PowerShell; only a structurally identified nested Bash execution can be brokered.

Required new engine modules, explicitly **proposed files in the Fuigo repository**, not falsely cited as existing in Murage's base:

* `fuigo-shell/src/agent/murage_bash_launch.rs`: capability negotiation, private channel, engine-process binding, per-session epoch and replay protection.
* `fuigo-shell/src/agent/tools/murage_bash_runner.rs`: shell-tool prepare/commit/completion and the exact parsed nested Bash occurrence; no direct-spawn fallback after a committed trusted call.
* `fuigo-shell/src/agent/permission/murage_bash_contract.rs`: validate the immutable launch contract alongside the launch-policy mechanism described at `fuigo-policy.ts:17–20,33–36`.
* `fuigo-shell/tests/murage_bash_launch.rs`: real child selection, negative protocol and cancellation tests.

The Fuigo owner must wire these modules into the real ACP initialization and shell execution dispatch, inspect the actual upstream call sites and attach that diff. Those dispatch files are not in `_base`; this document does not invent file:line evidence for them. The named new modules and behavior are requirements for the 1.0.42 build, not work removed from Murage 1.0.19.

Protocol fields and sequence:

1. Murage starts the pinned Fuigo image and establishes an inherited private channel. OS peer PID plus process creation time must match the held engine-process handle. A separately spawned peer, even under the same username, cannot acknowledge for it.
2. Initialize advertises `murage/bash-launch:{version:1, prepareBeforeToolFacts:true, brokerExec:true, processDrain:true}`. Murage sends `configure` containing protocol version, server nonce, engine/session epoch, selected canonical executable identity, reference ID, allowed launch forms, environment generation and broker endpoint binding. No trust handle is serialized.
3. The actual engine sends `configured` echoing nonce, protocol, process identity, epoch and contract digest. Murage checks equality against its own record, not against `_meta` copies. A model-supplied capability/ack, unknown version or missing field grants no exception.
4. Before any corresponding tool_call/update/permission request, the engine sends `prepare` with call ID/revision, exact raw command, dialect, parsed occurrence, effective cwd and effective environment snapshot. Murage independently parses/derives and compares those facts, acquires/revalidates protection, and replies `prepared` with an invocation correlation. This freezes the engine-side execution plan; subsequent changes require a new revision and preparation.
5. Murage scans the frozen facts and follows existing approval policy. `commit` identifies that exact prepared revision. Fuigo executes through the broker's explicit application-name launch. For a PowerShell command, the engine executor must use its structured shell plan to dispatch the identified nested Bash occurrence through the broker; no textual replacement or title inference is accepted. Commands with unresolvable dynamic selection remain untrusted and retain normal policy behavior.
6. Fuigo reports tool completion; the broker separately reports process exit and job drain. Stop/reconnect/generation changes invalidate the configuration immediately and drain old executions. A new connection always requires a new nonce and configuration.

Missing capability on 1.0.40 produces normal execution with no new exception, not a new repair card. Mandatory acceptance also proves that the new Fuigo build **does** support the routine nested-Bash case. This prevents a permanently unsupported Fuigo fallback from being called completion.

## 4. Exact scan and registration sequence

The new shared entry is asynchronous `prepareExecutionContext(mergedCall, serverIdentity): Promise<PrivateScanContext>`. The scanner remains synchronous and consumes an immutable prepared snapshot; it performs no async verification or card-time repair.

1. Receive and fully merge the engine call facts. Identify effective cwd/dialect and call revision. Reserve the ordered per-call preparation slot before invoking any outside scanner. Maintain a per-engine event queue so an async prepare cannot reorder mark/registration events from that engine.
2. Run `recordOutsideInstallChange` before checking the download/clone exclusion, preserving current registration/invalidation semantics. Snapshot the registry revision, session-edits revision, turn start and environment generation. Acquire/revalidate the native lease and establish the private engine/call/occurrence binding. Recheck those revisions before publishing the snapshot.
3. For ACP, await this at **all** source-judge entrances: `core.ts:3808`, `:4563`, `:4604`, via `judgeAcpCall` at `:2869`. The `execEnvNow` at `:4009` remains card information/consistency checking; it is not acquisition. Move the necessary checked environment acquisition to preparation without losing the later consistency check.
4. For Claude/Pi, prepare before emitting the tool start. In `server/index.ts:9515`, resolve private context by engine instance, turn and event object/call revision and pass it to `noteToolStartOutside`. Never serialize it into the event or rely on a global current lease. An item that genuinely has no usable call facts is scanned untrusted; a later frame may not delete its mark.
5. `outside-wire.ts:778–782` merges scanDisk with the immutable context, performs the scan, notes session edits, registers at start and then marks. Preserve this order. `scanDisk` needs explicit execution-platform context even when cwd is absent; `{}` must not silently turn off Windows Bash tightening.
6. Ask-before-start ACP performs judgment without registration; `registerOnAllow` at `core.ts:3811–3816` revalidates the same binding and registers once immediately before the allow is sent. A denied ask creates no download registration or session write. Non-ACP ask-before-start preparation uses the same call promise and scans before an auto-allow can leave the server.
7. At allow, revalidate current revisions/security state and commit the execution ticket. If facts changed while a card waited, cancel the old prepared binding and rejudge the new revision. If revocation occurs after scan, either perform an untrusted rejudge before sending allow or return the existing cancellation/changed-call result; never send an allow based on stale relief.
8. Native launch verifies actual image/cwd/env before continuing the protected process. Failures here stop that launch; they do not remove prior marks or silently substitute another shell.

Event rules: identical duplicate frames share one preparation/scan/registration result and cannot consume a ticket twice. A changed merged input, cwd, locations, kind or execution-affecting metadata increments revision and invalidates the prior reservation; older queued completions are discarded. Registration of changed starts/updates retains current ACP behavior. Late frames retain late-frame provenance. Re-entrant body scans receive an explicit context plus occurrence path and a shared scan budget; only the exact bound occurrence can match. Another engine, nested command or independent interpreter finding never reads a global trust bit.

Proof GB23 records an ordered trace and asserts `prepare-complete < first-scan < registration/mark < allow < child-continue`, with the ask-only registration exception above. No test may manufacture success by deleting an interpreter mark after `markCallOutside` (`outside-wire.ts:764–766`).

## 5. Exhaustive Windows Bash decision table

Add an explicit actual-host platform field and guarded `engineBashDecision(occurrence, hit): {trusted:boolean, reason}` hook to `OutsideScanHooks` and `HOOK_KEYS`. The wire supplies the host value independently of disk availability. Tool input cannot select win32. A missing internal platform value is an invariant error in a local Windows wire path and supplies no trust; tests inject the host explicitly.

A target is in scope when the existing dialect reader identifies a **command occurrence**, including wrapper/finder targets, whose dequoted basename is ASCII-case-insensitive `bash` or `bash.exe`. Recognize bare `bash`, `BASH.EXE`, slash/backslash paths, quoted PowerShell call-operator paths, drive-absolute paths and MSYS `/c/...` spellings. Drive-relative, ADS, trailing-dot/space, device, UNC and expansion-obscured variants of a Bash target are recognized for refusal, not canonicalized into a trusted match. Echoed strings/ordinary operands are not new Bash occurrences. An arbitrary alias/function is never trusted by basename; if its runtime target is unknown, existing reader uncertainty findings remain. `sh`, `dash`, `zsh`, `ksh`, Python, Node, WSL and unrelated executables keep existing rules. A resolved arbitrary program named otherwise that happens to be Bash also gets no new exception.

Run this classification in `scanTextBody` **before** `if (at && runnerResolves(...))` (`:1585`). Refactor the i10 target loop to retain one parser/target enumeration, with optional probe, rather than bolt a text regexp onto card-time logic. Preserve independent marks from i8, i9, i11, i13 and body scans.

| Windows Bash occurrence state | New trust | i10/result decision |
|---|---|---|
| Valid prepared occurrence, exact path+ID, live lease, known clean exclusions, current generation and usable probe | Yes | Skip only this executable's outside-system-root cause; continue all operands/bodies/other causes. |
| Proven unchanged system-root file, no fresh/edit/other original finding | Not needed | Preserve base system-root outcome even with no binding; do not require a new lease for existing system trust. |
| System-looking text but no reliable resolution/probe | No | Mark; a lexical `C:\Program Files` prefix alone is not proof. |
| No cwd; relative/invalid/ambiguous cwd; absent effective native mapping | No | Mark before the `at` guard. |
| Probe absent; probeOf unavailable; probe throws; probe budget exhausted | No | Mark (and preserve existing fail-closed budget findings). |
| Lookup hook absent | No | Bare target marks before `:947` can continue. Explicit paths use the path probe and binding; they do not require a PATH lookup. |
| Bare lookup returns undefined (unknown) | No | Mark before `:956` can continue. |
| Bare lookup returns null (not found) | No | Mark; no special silent success for a named Bash. |
| Lookup throws or exceeds distinct-name budget | No | Mark/fail closed; never reuse an earlier successful binding. |
| Probe returns null, directory or other non-file | No | Mark; this is intentional Bash-only tightening over `programMarks`' non-file return. |
| Path resolves to different name/ID, hard-link alias or foreign installation | No | Mark unless the existing proven system-root rule independently applies. Same hash/ID alone is insufficient. |
| Candidate matches but hook absent, undefined/malformed return or hook throws | No | Mark for non-system Bash; guarded-hook failure cannot skip the branch. |
| Lease pending, timed out, canceled, revoked, draining, released or unknown | No | Mark for non-system Bash. A lookup hit never substitutes for lease state. |
| Wrong engine/thread/turn/call revision/occurrence/epoch/generation | No | Mark for non-system Bash. |
| Fresh or session-edited selected executable/runtime member; registered download/clone; lexical/native workspace containment | No | Preserve/add the associated findings and interpreter finding; no digest override. |
| Exclusion state unavailable/overflowed or cannot map lexical/native path | No | Mark; registry absence in the hook is not evidence of an empty registry. |
| Bare Bash resolves but is not adapter-enforced (e.g. nested PATH/function-dependent invocation) | No | Mark for non-system Bash, even when the outer shell is leased. |
| Non-Windows host or remote execution host without this native contract | No | Existing platform policy, no new Bash tightening. |
| Non-Bash target | No | Existing behavior unchanged, including WIN-PWSH's independent sh handling. |

System-root precedence does not suppress existing freshness/session-edit checks (`outside-scan.ts:959–965`), engineEnv or any other cause. Normal Windows case-insensitive input may pass only if native canonicalization proves the same exact stored name and ID. Case-sensitive directories must distinguish real different files.

## 6. Native protection and loaded-image contract

### 6.1 API and ownership

Add capability **`bashLaunchLease:1`** and bump the addon ABI consistently in native code, `server/engine-exclusion.ts` and `scripts/engine-exclusion-resource.mjs`. Existing `WINDOWS_NATIVE_FUNCTIONS` validation (`engine-exclusion.ts:146–155`) and packaged architecture checks (`engine-exclusion-resource.mjs:10–21,46–48`) must fail on a missing/mismatched required export. One owner controls the shared addon change.

Proposed typed API (all opaque handles are addon-owned; no integer HANDLE crosses into application input):

```ts
acquireBashLease(request: {
  operationId: string; referenceId: string; selectedNativePath: string;
  engineProcess: NativeHandle; generation: number; deadlineMonotonicMs: number;
}): Promise<{ lease: NativeHandle; inspection: LeaseInspection } | Refusal>;
inspectBashLease(lease: NativeHandle): LeaseInspection | Refusal;
revalidateBashLease(lease: NativeHandle, expected: BindingSnapshot): Promise<Validation | Refusal>;
launchBash(lease: NativeHandle, plan: FrozenLaunchPlan): Promise<ExecutionTicket | Refusal>;
cancelBashAcquire(operationId: string): void;
revokeBashLease(lease: NativeHandle, reason: RevokeReason): void;
releaseBashLease(lease: NativeHandle): Promise<{ released: true }>;
```

`LeaseInspection` is private and includes canonical member/component names, volume serial+128-bit file IDs, link counts, byte counts/digests, owner/DACL observations and descriptor revision hashes. `Validation` checks that the lease and exclusion snapshot are still current. `ExecutionTicket` exposes server-private process identities and a `drained` promise/event. JS cannot choose an arbitrary executable in `launchBash`: the native record accepts only its selected image and registered runtime transition. Refusal reasons are finite, typed values.

One native worker owns each acquisition, all opened handles and its eventual transfer to the lease table. It checks a cancellation flag between each open/read/hash/component operation. `cancelBashAcquire` invalidates delivery immediately and requests cancellation of blocking I/O; it does not pretend the worker has exited. Errors close acquired resources on the owning worker. `releaseBashLease` is idempotent, revokes admission and waits for both worker completion and dependent process drain before closing file handles. Finalizers schedule this same path; they are not an alternate early CloseHandle path.

### 6.2 Opening and identity

Start from a fixed local NTFS volume root, validate the drive mapping, and open each component relative to the already-held parent with `NtCreateFile`/OBJECT_ATTRIBUTES RootDirectory and `FILE_OPEN_REPARSE_POINT`. Request directory traversal/read-attributes/read-control/synchronize access, and directory semantics; reject reparse tags before walking the next component. Never perform a later unconstrained absolute reopen after validating an ancestor. Bind canonical volume paths so drive-letter reassignment cannot select a different tree.

Hold ancestor directory handles without delete sharing (allow read/write sharing for unrelated sibling activity). For each protected executable/DLL request read-data/read-attributes/read-control/synchronize access with **FILE_SHARE_READ only**: no write/delete sharing. The corresponding Win32 flags are OPEN_EXISTING, OPEN_REPARSE_POINT and, for directories, BACKUP_SEMANTICS; no backup/restore privilege is enabled. Query FileIdInfo, FileStandardInfo, FileAttributeTagInfo, canonical native name and security descriptor through those handles. Hash through those same handles, not a second pathname open. The proposed image-section step is `NtCreateSection` with `SEC_IMAGE` and `PAGE_READONLY` against the held PE file handle, retaining the section object without executing its code. Reject any incompatible writer/mapping error; GB07 must include pre-existing writable mappings, not merely open write handles. Whether that combination excludes every required mapped-write attack is an explicit native qualification obligation, not an established result of this design or a claim that read sharing alone solves it. No positive may ship if that proof fails.

Reject non-regular member files, zero/unknown IDs, multiple hard links on Git members, reparse components, network/removable volumes, alternate streams, short-name ambiguity, user device-prefix escapes, trailing dots/spaces and unknown filesystem behavior. Internal `\\?\` native names are normalized only by the native layer. A hard link at another pathname fails even when it has the **same** file ID. Protect each distinct ancestor component once; deduplicate by volume/file ID and exact canonical identity.

Windows share modes govern opens and deletion, not a universal security-descriptor lock. Therefore descriptor changes are separately watched and revalidated before each admission and immediately before process continuation. A change revokes new admissions; locks remain through drain. This avoids the false promise that withholding FILE_SHARE_WRITE prevents WRITE_DAC. [Microsoft's CreateFile contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) is the external API reference; actual standard-user behavior is GB06/07 evidence.

### 6.3 ACL interpretation and exclusions

Allowed owners/mutation principals: actual engine-account SID, LocalSystem, BUILTIN Administrators and locally resolved TrustedInstaller. Use SID identities, not English account names. Query owner and DACL on every protected Git member and relevant ancestor. Present readable DACL required; null/missing/query-failed DACL rejects. Map generic rights to file/directory rights before evaluating. Process inherited ACEs according to their object applicability; INHERIT_ONLY ACEs do not apply to the current object. Unknown conditional, callback, object-specific or unresolved-principal ACEs reject. Conservatively reject a disallowed applicable mutation allow even when a deny might restrict it; do not improvise group/conditional evaluation.

For a member file, mutation includes WRITE_DATA, APPEND_DATA, WRITE_EA, WRITE_ATTRIBUTES, DELETE, WRITE_DAC and WRITE_OWNER. For a component directory, evaluate its DELETE, WRITE_DAC, WRITE_OWNER, relevant attribute/reparse mutation and its parent's FILE_DELETE_CHILD as replacement authority over that component. Parent DELETE_CHILD can enable deleting an existing child even when the child's own DELETE right is absent. **FILE_ADD_FILE/FILE_ADD_SUBDIRECTORY alone is only creation of a new child; it is not deletion/replacement of an already held child.** Broad read/traverse is permitted. Current-user write rights are permitted because the authenticated bytes plus live file protection are the defense against same-account file substitution. No ownership/ACL repair or elevation is performed. See the [Windows file security/access model](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights).

Before publication and each admission, check **every executable/DLL runtime member**, not only the entry: freshness with the existing turn-start/two-second slack (`outside-wire.ts:181`); session edits at lexical and canonical names, including overflow; download/clone registry match and revision; containment within both lexical and resolved cwd. Components also undergo session-edit/registry/containment checks where applicable. Ancestor directory mtime alone is not executable freshness (an unrelated sibling creation must not taint an unchanged image). Unknown registry/containment/edit state refuses trust. Server-authored per-invocation environment data is a separately immutable launch input, not an engine-written executable to be admitted by a freshness waiver.

### 6.4 Actual loader selection and startup inputs

Use a native Windows launch supervisor, implemented in new `native/engine-exclusion/bash-launch.c` with addon exports from `exclusion.c`. It creates the protected image with explicit `lpApplicationName`, frozen argument vector, cwd and environment, under a job without breakaway and a debug supervision relationship. It owns process creation and image-load events from before the first user instruction. This is **pre-execution enforcement**, not post-execution process-list observation. [Microsoft documents that debug events suspend the affected process and that the initial process event precedes user-mode execution](https://learn.microsoft.com/en-us/windows/win32/debug/debugging-events).

At CREATE_PROCESS_DEBUG_EVENT compare the supplied actual image handle's identity to the selected entry/runtime transition; at LOAD_DLL_DEBUG_EVENT compare the actual loaded image handle to the protected member table or the qualified OS-image policy. Reject a missing/unresolvable image handle, wrong identity, unexpected non-system dependency or shadowed system name **before ContinueDebugEvent**. Unexpected image selection terminates the affected launch/job with a typed runtime failure; no DLL initializer marker may run. GB19 verifies this timing with a DLL whose initializer writes a sentinel. A post-load ETW trace alone is insufficient. Descendant events retain execution-use references even when their parent exits.

Permitted non-system image locations are exact protected member paths from §2.2 only. Windows system images must resolve through the actual system directory/KnownDLL/API-set/Windows side-by-side mechanism to canonical OS-owned files on the system volume, with valid Microsoft Windows signature/catalog identity and no user-writable replacement path. A Microsoft-signed DLL placed in cwd or a per-user PATH directory does not qualify. System files may have Windows servicing hard links; this does not relax the single-link Git-member rule. Runtime logs inventory their identities privately for qualification; OS updates invalidate the qualified process generation and require revalidation. Cap these image records with the same member/handle budgets.

Do not rely on SetDllDirectory in the server to control a child, or on an import list to rule out dynamic loads. The supervisor checks actual selected images, including a DLL newly planted after acquisition. A planted sibling can exist under ordinary creation permissions; it cannot be continued as a protected Bash dependency. In-flight DLL substitution, bin-launcher delegation and every protected component get adversarial tests.

Launch startup is noninteractive/nonlogin, with the existing handed environment preserved. Require known absence of executable startup redirection (`BASH_ENV`, `ENV`, exported Bash functions, preload/loader overrides and equivalent MSYS startup controls); otherwise no new exception and retain the existing environment finding. Explicit `--rcfile`, `--init-file`, login/interactive startup, unknown options, shell function replacement or an unproven outer shell similarly defeats qualification. Do not silently strip an owner's setting to obtain trust. Profile/rc files are not executed on the qualified route.

The startup-input inventory is explicit: the exact Unicode environment block and cwd; arguments and inherited standard handles; Murage's immutable prefix/configuration; the selected Git root and executable-relative mapping; `etc/fstab`, `etc/fstab.d/<engine-user>`, `etc/nsswitch.conf`, `etc/passwd` and `etc/group` (present or absent); locale selection (`LANG`, `LC_ALL`, `LC_*`, `LOCPATH`, `NLSPATH`); and launch-altering names `MSYS`, `MSYSTEM`, `MSYS2_PATH_TYPE`, `MSYS2_ARG_CONV_EXCL`, `MSYS_NO_PATHCONV`, `CYGWIN`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `GCONV_PATH`, `BASHOPTS`, `SHELLOPTS`, `BASH_LOADABLES_PATH`, `BASH_FUNC_*`, `BASH_ENV`, `ENV` and `CDPATH`. Read these as data; never source them to discover behavior. A launch-altering value not covered by an exact reviewed layout rule refuses qualification; do not silently clear it. Present MSYS configuration is bounded to 64 KiB/file and 256 KiB total, opened/held by identity, and interpreted only for the supported mapping/data grammar. Unrecognized mount/loader directives refuse relief. Locale data may not add executable images outside the runtime-image policy. Missing files are recorded as absence probes, with their relevant directories watched; a new effective startup input invalidates preparation before commit. The qualified launch must not execute profile/rc scripts or an unexpected startup helper. The final Windows qualification records the observed input set and proves it is a subset of this contract; any newly observed effective input requires a reviewed rule and negative test, not an implicit allowance.

The supervisor does not grant other child tools an image trust exemption. Commands intentionally launching other tools remain subject to ordinary inspection and approval. If a command intentionally requests an unsupported Bash plugin/startup image, choose the untrusted execution plan **before** scanning; do not convert this feature into a new permission category or retry an already-started command unprotected. Debug-supervisor denial after admission is an execution-integrity failure, never an allow override.

This protects file/path/loader substitution within the application's existing trust boundary. It is not a defense against an administrator, kernel compromise or an attacker able to inject arbitrary memory into Murage/the native supervisor. Real proof of the proposed supervision and mapped-writer behavior is mandatory; a missing capability cannot be replaced with JS stat/realpath and called equivalent.

## 7. Lease state machine and resource accounting

### 7.1 State transitions

| State | Admission | Transition / cleanup owner |
|---|---|---|
| RESERVED / QUEUED | No | Atomic capacity reservation; bounded FIFO queue. Cancel dequeues only when no worker owns it. |
| ACQUIRING | No | Native worker owns opens/hashes. Success transfers resources once to PROTECTED; failure/cancel/timeout goes to REVOKED-DRAINING. |
| PROTECTED | No invocation yet | Held dependency identity available only to its engine instance/generation. Revalidation plus an exact record creates PREPARED use. |
| PREPARED | Scan relief for that immutable occurrence only | Policy deny/cancel releases the use; allow revalidates and moves to COMMITTED. Holds no ability for arbitrary command execution. |
| COMMITTED / RUNNING | No reuse of the ticket | Native process is created/continued once. Each protected process and descendant keeps a use count. |
| REVOKED-DRAINING | No | Includes canceled-but-running acquire workers and timed-out work. Request cancellation/termination; wait for native worker completion, job/process completion and zero uses. |
| RELEASED | No | Native owner closes remaining resources exactly once and only then frees slot/budget. Terminal; late callbacks cannot revive it. |

Timeout is a reason for revocation, not a resource-free state. A success arriving after cancellation is immediately drained by the worker owner and is never inserted into the live registry. Idempotence keys include server epoch/operation ID, so an old worker cannot close or populate a new lease with a reused call ID.

Stop, turn replacement, engine exit/reconnect, environment change, reference change, descriptor change and server shutdown revoke new admissions synchronously. Stop requests job termination, then waits for native process handles and zero active job members; `tool.completed`, parent exit and UI Stop alone cannot release protection. A surviving/background child keeps the lease draining. No BREAKAWAY_OK/SILENT_BREAKAWAY_OK flags are allowed. Force termination after the existing Stop grace period uses the same job and is followed by confirmed drain, not immediate handle release.

On normal shutdown, cancel queues, revoke all leases, terminate jobs, join workers and drain before addon teardown. On a crash, the supervisor's debugger/job death contract must terminate dependents without an interval in which an unprotected child can continue executing. Keep the supervising native process alive until dependent jobs have drained on normal server disconnection. Prove crash/disconnect behavior on Windows; do not rely on JS finally running during a crash. Native debug-event handles obey API ownership (duplicate process handles for exit waits, close image event handles once); lease handles are separate retained handles.

Restart overlap: one dependency lease per engine instance, and at most one retiring plus one new generation slot per instance lineage. The retiring slot still counts toward the global cap. A second restart waits/fails preparation while the first drains. An update may be unable to replace locked Git files while a dependent process is alive; Stop drains/releases, then an update and restart can acquire new reference bytes. Never accept a changed artifact version midway through a turn.

### 7.2 Limits and fallback

| Resource | Bound | Accounting |
|---|---:|---|
| Process-wide lease slots | 128 | All reserved, queued, acquiring, protected, active, canceled, timed-out and draining slots count until native cleanup completes. |
| Native acquire/hash workers | 4 | Includes cancellation-pending workers; no timeout replacement thread before completion. |
| Queued acquisitions | 32 | Queue entries also consume a lease slot. Overflow fails preparation immediately, without a hidden background retry. |
| Acquisition wall-clock deadline | 2 seconds | Monotonic, from reservation including queue time. Cancellation does not free its worker/handles early. |
| Manifest members / bytes | 256; 64 MiB/member; 256 MiB total | Validate before opening; hash streaming buffers, not whole-file JS allocations. Runtime image records fit within the same bounded inventory. |
| Ancestors | 32 components/path; 256 distinct/lease | Deduplicate exact native IDs; reject deeper/excessive layouts, no partial protection. |
| Native handles | 1,024/lease; 32,768 process-wide | Reserve before open/duplicate; includes directories, files, sections, jobs, process/thread/event/IPC handles and drains. |
| Active execution tickets | 32/lease; 256 process-wide | A ticket holds a use until its dependent processes drain. |
| Tracked descendants | 128/ticket; 2,048 process-wide | Exceeding a running-ticket cap terminates that job and drains; never evict a live child to make the count fit. |
| Pending launch/control messages | 64/engine; 4,096 process-wide | Bounded byte payload (1 MiB/message); reject oversized/unreadable requests before parsing/copying. |
| Invocation records | 1,024/engine | Retain only bounded terminal replay tombstones; active/draining records cannot be evicted. |

Acquisition failure/capacity/timeout selects no exception and returns to normal policy before execution. No automatic retry loop creates more workers. A user-authorized later call can try again only after capacity exists. Existing command/reader limits still apply. Cold/warm percentile timings and peak resources must be measured on standard-user packaged Windows; the bounds stay as proposed pending that measurement. Altering a bound requires review, not a silent fallback to partial protection.

## 8. Reader integration and dependency lock

### 8.1 Fixed integration map

| Current seam | Decision |
|---|---|
| `walk.ts:507–526 executionWrittenKey` | Keep byte retrieval/current-text precedence/session failure semantics. Pass effective native cwd mapping from the existing environment context where needed; do not add a trust-based body bypass. |
| `walk.ts:1908–1928 shellScript` | Keep the current conservative option reader; no new next-word-after-`-c` shortcut. |
| `walk.ts:2791–2795 shebangInterpreter` | Preserve distinction between shell and non-shell bodies. Do not change it to treat every Windows script as Bash. |
| `walk.ts:3526–3543 runWritten` | Literal shell content continues through walkWithPositionals; opaque/value/remote bodies keep their outcomes. No lease check is needed merely to retrieve or inspect text. |
| `outside-scan.ts:959–975` | The Bash identity change affects the executable's i10 outside-root cause. Script session-write/freshness relief is a separate NL-SAMETURN provenance decision and must still scan the body. |
| `always-ask.ts:2016–2074` | Keep existing WIN-PWSH handed-path grammar and sh rule. A new private exact-route assertion may accompany its context but cannot replace the original interpreter/body checks or the legacy rule with blanket trust. |

The actual finding removed by this lane is **i10: named selected interpreter outside SYSTEM_ROOTS** (`outside-scan.ts:907–915,965`). The original Windows `shellBody` rejection belonged to NL-ST4 on a different tree; it is not asserted to exist here. NL-SAMETURN owns same-turn body provenance and its shell-route rule. This design introduces no alternate body reader and no new exception for a session-written script solely because Bash is genuine.

Exact accepted Bash shebangs for a proven route: `#!/bin/bash`, `#!/usr/bin/bash`, `#!/usr/bin/env bash`, LF or CRLF. Explicit leased `bash script.sh` ignores the shebang as a comment and still reads the whole body, including a sh shebang. Direct sh forms (`/bin/sh`, `/usr/bin/sh`, `/usr/bin/env sh`) remain positive **body/provenance** tests under the existing same-turn policy; they acquire the new Bash identity relief only if the actual enforced route executes the selected Bash. A different `sh.exe` gets no Bash exception. Direct zsh/ksh, extra shebang words, `env -S`, assignments, expansions, unread bodies and ambiguous routing get no new relief and keep existing outcomes. This preserves the sh acceptance cases without pretending sh.exe is the one selected Bash.

### 8.2 Exact revision decisions, and what is not agreed

Read-only Git metadata located these inputs. They are not silently assumed to be in c12aaad93:

| Dependency | Chosen integration input and disposition |
|---|---|
| NL-SAMETURN / NL-ST4 | **`8bddd0b22c077847185c081309883c82d23adfa2`**, r4 including Windows shebang R4-7. Port its required behavior to the fixed seams above. Git also contains `894cc1d4c1596ba5af99efc1223a0b7e983b7765` and `9f26ef47c0682ebdcdc38353a045b124f452f7ce`; do not substitute them by similar title. Metadata did not establish 8bddd as an ancestor of 894cc. |
| No limits | Contract `NOLIM-DO-EVERYTHING-1019.md` rev 3.2 kept set, with this brief's explicit owner denies retained. Concrete server input **`0765e00d3a5846f0d162793c4b7fe9b13bd01267`**, following B1 `ee0c5205067bb5258d2ff253a7eafbce9f0301cf` and B2 `6ed8905f58df0905c0a0997ff2303171c7163a54`. Its finalizer is absent on the supplied base; combined tests must run on the integrated port, not declare base behavior fixed. |
| argv | Adopt **§5's conservative fallback** of `NOLIMITS-BASH-ARGV-1019.md`, not its withdrawn §§2–4 grammar. Historical implementation input **`5de94ab23e4e2d124e9fd38492246a773884f5d1`** is explicitly NOT an approved drop-in: its handoff records a second block and failing checks. Keep current `walk.ts` reader semantics; if the combined No limits port introduces hiding/rescan readers, they must use a reviewed conservative contract and pass GB13 before integration. Do not recreate absent `hiding.ts`/`shell-argv.ts` merely to claim a dependency is present. |

The original design's citation of “one reader, one grammar table” omitted the later withdrawal. That omission is corrected here. The chosen integration behaviors are concrete; there is **no honest basis to label all three historical commits jointly agreed or green**. Wave 0 records the resulting port SHA(s) and gets Astra/Fable agreement on this combined contract; that required agreement cannot be fabricated in a design-only task. Integration cannot complete with an unresolved argv/wipe regression.

### 8.3 Policy invariants

The kept set is explicit owner deny rules, the wipe/catastrophe rules, and `murage-engine-hooks` across origins. Preserve their reasons and final holds whether Bash trust is true or false. A trusted executable does not prove owner origin. An eligible owner No limits routine command may run when trust is false and interpreter findings remain; no Git repair/enrollment card may be added. Other/unproven origins retain their own final policy. Preserve source labels so trust cannot disguise a self-integrity access as a harmless shell finding. The new trust module never edits the finalizer or allow-all rules.

## 9. Tests that establish the contract

All entries below are **required tests, not executed results**. F = source-derived missing feature; G = existing guard/parity, not automatically RED; U = actual baseline outcome unknown; M = must kill the named unsafe mutation. Linux injected-win32 tests establish pure logic only; native ACL/loader/process assertions require real Windows. Record base and candidate results separately. A guard that already passes base is not a feature RED.

| ID / class | Concrete assertion, including expected failure control | Test home / environment |
|---|---|---|
| GB01 F/U | Aged selected per-user Bash with exact reference/binding removes only i10 outside-root cause; another independent interpreter cause remains. Actual packaged baseline branch recorded before declaring behavioral RED. | `win-git-bash-trust-1019.test.ts`; Windows replay |
| GB02 F/G/M | Every §5 branch, bare/path/case/wrapper/PWSH/MSYS spelling; absent cwd/probe/lookup, undefined/null/non-file/error, missing/throwing predicate, pending/revoked binding. A proven system-root control and unrelated interpreters stay unchanged. Mutant restores any one early continue/at bypass. | Scanner integration, parameterized branch coverage; Linux+Windows |
| GB03 F/M | Exact §2 reference succeeds; altered bytes with same stat, malformed/duplicate/escaping manifest, wrong machine, missing member, first-seen/local manifest, unsupported reference fail. Mutant accepts size/mtime or discovery. | `engine-bash-trust.test.ts` |
| GB04 G/M | Copied file, hard link with SAME file ID but second name, foreign Bash, sh.exe, WSL, extensionless/shim files and another engine's selected Bash get no exception. Mutants accept hash-only, ID-only, directory membership. | Trust/scanner tests; native hard-link case |
| GB05 F/M | Canonical same-file case alias passes on normal NTFS; case-sensitive different files, junction at each ancestor, ADS/device/UNC/removable/drive-relative/trailing-dot paths, zero IDs fail. | `native/engine-exclusion/git-bash-trust.node-test.mjs` |
| GB06 F/M | Real ordinary standard-user per-user install succeeds without elevation. Foreign owner, broad applicable file mutation/delete-child, null DACL, conditional/unknown ACE, SID/query failure refuse. Read-only broad access and unrelated sibling-create rights pass. Descriptor change before scan/commit revokes. | Native Windows, localized accounts and inherited ACL fixtures |
| GB07 F/M | Replace at every member/component boundary before/during/after acquire and launch; incompatible open writer and pre-existing writable map; rename/delete/hard-link/reparse/DLL substitution. No substituted code executes. Child survives parent/Stop: locks remain until native drain, then update succeeds. Mutant releases at UI Stop or tool result. | Native Windows only |
| GB08 F/M | Cross-engine/thread/turn/occurrence replay, forged input token/ack, PID reuse, reconnect, changed generation and late acquire result all fail; repeated revoke/release closes once. | Binding/coordinator + Windows lifetime tests |
| GB09 G/M | Fresh/session-edited/registered-download/cloned/workspace member refuses even with correct digest; loop over all eight members, lexical/native spellings, registry overflow and changed registry after prepare. An unrelated sibling directory timestamp alone does not reject. | Trust/wire tests; mutant checks only entry |
| GB10 G/M | POSIX unchanged; C-drive system-root controls, other Windows programs, engineEnv, inertUntrusted and scan limits unchanged. Mutant adds Git directory to SYSTEM_ROOTS. | Existing outside/WIN-PWSH regressions |
| GB11 U/F | Matrix: plain/cd × Write-then-run/printf-write-run × direct/explicit Bash × three Bash shebangs × LF/CRLF × native/MSYS cwd. Body visited; harmless body passes combined policy; no false shell identity mark. Base may already pass reader cells. | Integration + real Claude/Pi/Fuigo Windows |
| GB12 G/U | sh forms remain body/provenance cases; explicit selected Bash with sh comment visits body; direct different sh.exe never inherits Bash trust. zsh/ksh/env -S/extra words/opaque bodies retain outcomes. | Reader/WIN-PWSH integration |
| GB13 G/U/M | `-c -x`, `-c --`, `-c -o errexit`, clusters including `-oc`, duplicate `-c`, nested Bash/PWSH and a written body's deny/wipe cannot be hidden by trust. Assert kept-set verdict even if conservative argv parsing reports unreadable. Mutant scans only next word or trusts whole outer shell. | Combined argv/No limits tests, no real destructive action |
| GB14 F/M | Missing/version-mismatched addon, all native failures, unknown host context, invalid map, 2-second timeout, cancellation race, every §7 bound and absent exclusion state return no trust. Timed-out work remains counted. Diagnostics/projections contain only allowed fields. | Coordinator, native worker fault injection, wire tests |
| GB15 F/G/M | Cross trust true/false × eligible owner/other/unproven origin × levels. Routine eligible No limits has zero trust cards; explicit deny, wipe and `murage-engine-hooks` retain holds. Assert findings separately from verdict. Mutant bypasses self-integrity or maps trust to origin. | `win-git-bash-trust-policy-1019.test.ts` + packaged proof |
| GB16 F/U/M | Actual Claude outer/inner prefix route, Pi generated broker tool, Fuigo prepare/ack/commit each execute the selected file; wrong image/cwd/env/protocol rejects. Fuigo 1.0.40 and generic ACP PowerShell F12 alone never qualify. Mutant accepts raw `_meta`/title/post-execution observation. | `engine-bash-binding.test.ts`; real engines; Fuigo upstream tests |
| GB17 U | Recover original LEGS9/10 fixtures, record real base branch and candidate result; run exact captures plus §2.3 equivalents. Codex stays a control. No exact-replay assertion when only an equivalent recording exists. | Packaged Windows qualification and controlled evidence |
| GB18 G/M | Bot-folder copy, fake override, PATH-first shim, genuine entry plus altered DLL/reference get trust=false and findings retained. Ordinary approval controls hold; eligible No limits follows policy, not an unconditional card-count assertion. | Packaged Windows negative controls |
| GB19 F/M | Unexpected DLL, cwd/system-name shadow, newly planted sibling, bin-to-usr launcher swap, loaded-image handle mismatch, missing debug handle and delayed dependency load. DLL initializer sentinel never executes before rejection. Standard valid launch completes under supervisor. | Native Windows loader fixture; mutant merely audits ETW after launch |
| GB20 F/M | 128 occupied slots including 4 canceled-but-running workers and draining generations; queue 33 fails; every handle/ancestor/child cap; restart storm; native completion after timeout frees once. Peak counters never exceed limits and eventual cleanup reaches zero. | Deterministic coordinator stress + real native handles |
| GB21 F/G/M | Claude helper shadowing has no effect on native prefix; prefix source/path/env replacement fails. Windows native cwd/env equals expected snapshot; MCP KEEP preserves credential values privately, no argument/log leak. POSIX script route unchanged. | Wrapper/binding tests + packaged Windows MCP control |
| GB22 G/U | Snapshot Advanced engine/environment values before qualification, unsupported-shell selection, Stop, update and restart; values remain byte-for-byte unchanged. No trust setting or new card appears. Unsupported shell still runs/asks under existing policy; Stop settles and restart requalifies. | Existing settings fixture + packaged user workflow |
| GB23 F/M | ACP ask-before-start, merged update, changed cwd/input, duplicate start/final, delayed frame, allow-time registration and fullAuto path; Claude ask/item race; Pi start/prepare race; re-entrant body scan and two-engine concurrency. Assert §4 ordering and no post-mark deletion. | `engine-bash-binding.test.ts`, `outside-wire.test.ts`, index harness |

New scanner/policy test files live under `server/`. Extend `server/win-pwsh-1018.test.ts`, `server/win-pwsh-env-1018.test.ts`, `server/outside-scan-inert-1018.test.ts`, `server/outside-wire.test.ts`, environment projection and wrapper tests only where they exercise these shared boundaries. Add the new test files to `ci/gate-tests.txt` so classification checks cover them; the old argv handoff specifically recorded this omission as a gate failure.

Diagnostics allow only engine kind, server-generated opaque correlation, actual platform, stage, success/failure and fixed reason: `not-windows`, `unbound`, `no-reference`, `path`, `identity`, `hash`, `owner`, `acl`, `reparse`, `runtime`, `fresh`, `edited`, `workspace`, `downloaded`, `generation`, `capacity`, `timeout`, `io`, `stopped`, `protocol`, `changed-call`. No raw command/path/env value/SID/username/file bytes/content digest. Private qualification receipts may contain artifact hashes, but are not runtime event logs.

## 10. Complete file map, build waves and review gates

Every wave remains in Murage 1.0.19. Parallel wave labels are an implementation plan, not permission for this design task to spawn agents or execute builds.

| Wave / estimate (builder-sessions) | Files and ownership | Exit condition |
|---|---|---|
| W0 — 2 | This design and embedded Q-A1; new `server/testing/fixtures/win-git-bash-trust/*`; new `docs/verification/win-git-bash-trust-1019.md`. MAIN owns evidence custody, upstream Fuigo dispatch inspection, exact dependency port SHAs and reviewer seating. | Concrete interfaces and reference table frozen; recovered/equivalent fixture distinction accepted; real baseline captured once authorized. Both reviewers agree on the same packet before implementation. |
| W1A — 2 | New `server/engine-bash-artifacts.ts`, `server/engine-bash-trust.ts`, `server/engine-bash-binding.ts`, `server/engine-bash-trust.test.ts`. | Strict manifest, bounded state machine, all resource accounting and private record ownership tested; no reusable trust after cancellation. |
| W1B — 4 | `native/engine-exclusion/exclusion.c`; new `bash-launch.c`, `murage-exec-win.c`, native node tests; `server/engine-exclusion.ts`; `scripts/build-engine-exclusion.mjs`, `scripts/engine-exclusion-resource.mjs`; `electron-builder.yml` and packaging resource checks. One native owner coordinates ABI, supervisor/prefix resources and job integration with `server/procs.ts`. | Standard-user positive, exact-member/image enforcement, mapped-writer and loader-shadow negatives, Stop/descendant/cancellation accounting and crash behavior proven on Windows. |
| W1C — 5 | `server/engine-env.ts`; Claude/Pi drivers; `server/drivers/murage-exec`, `murage-exec.ts`; ACP core/Fuigo; new binding tests; Fuigo new modules/tests named in §3.4 plus upstream dispatch wiring; new Fuigo provenance receipt and `scripts/prepare-fuigo.mjs` pin. | Every engine's actual execution enforces protocol 1; no synthetic acknowledgment accepted; wrapper/MCP and public projection regressions pass. New Fuigo binary receipt belongs to the reviewed engine-side diff. |
| W2 — 3 | `server/outside-scan.ts`, `outside-wire.ts`, **`server/index.ts`**, ACP judge hooks, fixed `server/shell/walk.ts`/`always-ask.ts` context seams, new scanner integration tests. Serialize shared reader edits with NL-SAMETURN/argv owners. | All §5 branches and §4 orders covered; independent findings preserved; exact dependency port behavior reviewed; ordinary reader outcomes unchanged. |
| W3 — 3 | New policy tests; existing WIN-PWSH/outside/env/wrapper/settings regression files; `ci/gate-tests.txt`; new `scripts/win-git-bash-trust-qualification.ps1`; verification note and controlled receipts. No Git-trust policy rewrite in `auto-approve.ts`. | GB01–23, actual Fuigo/Claude/Pi plus Codex control, original/equivalent replay disposition, standard-user package proof and final independent code reads complete. |

Total **19 builder-sessions**, replacing the unsupported seven-session estimate: native supervision and engine-side execution control are substantial work. Review/fixture availability is additional elapsed time. W1A/B/C may run concurrently after W0 interface agreement; W2 follows their functioning contracts; W3 policy work and packaged qualification can proceed concurrently on the same pinned candidate. No work or platform already supported by the base is removed to meet the estimate.

### 10.1 Acceptance package

The package must contain this exact revision, Q-A1/updated real artifact receipts, exact candidate and dependency-port SHAs, new Fuigo source/build receipt, baseline/candidate test results, mutant failures, native loader/ACL/race/resource evidence, actual-engine transcripts and Advanced/Stop/update workflow evidence. Static inspection and fake native results cannot stand in for Windows execution. Distinguish feature REDs, already-green guards, mutant-only failures and unmeasured cells. There must be a supported positive for each required engine, not just negative controls that safely refuse every case.

### 10.2 Dual review

MAIN seats an independent-account Astra reviewer and Fable on the same document plus attachments; both must explicitly **AGREE**, followed by independent final code reads. No claim of that agreement is made here. The reviewer must be able to trace each table row to a decision and a test. Blocking missing runtime evidence is recorded as engineering evidence work, not as an implied waiver. If native supervision, mapped-write exclusion, actual Fuigo execution or a required positive fails, repair/redesign it within 1.0.19 and obtain renewed review; a permanently disabled exception does not complete this scope.

### 10.3 Sean-only decisions

**None.** Scope is fixed and `murage-engine-hooks` is already ratified. Artifacts, original-log custody, upstream engine wiring, dependency port SHAs, test execution and reviewer agreement are engineering responsibilities. Reversing the kept set would be a new product decision, but this revision neither proposes nor requires that reversal.
