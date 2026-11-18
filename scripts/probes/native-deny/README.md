# Native-deny gate probes (S11)

These scripts implement section 7 of the 1.0.20 native-deny design. They do
not change the app, enable launch profiles, or update the probe registry.
Node 22 or newer is required. There are no package dependencies.

## Entry points

```sh
# Linux gate box; default is also dry-run
sh scripts/probes/native-deny/linux.sh --dry-run

# macOS gate box (run by the gate rig later)
sh scripts/probes/native-deny/macos.sh --dry-run
```

```powershell
# Windows gate box (run by the gate rig later)
powershell -NoProfile -File scripts/probes/native-deny/windows.ps1 --dry-run
```

Replace `--dry-run` with `--run` only on the authorized gate box. Use repeated
`--probe P-C1` selectors to run a subset, and `--timeout-ms 120000` to set each
child's deadline (100–600000 ms). Execution is sequential: one engine process
at a time. Wrong-OS runs skip. P-C6 also skips unless the runner is already
Linux root; it never invokes sudo or elevates privileges. Windows binaries
must be native executables, or an absolute Node executable with the CLI's
absolute `.js`/`.mjs`/`.cjs` entry file as its sole prefix argument. Shell
command strings and `.cmd` engine shims are rejected.

Dry-run emits all selected plans without creating fixtures, reading auth,
looking up binaries, or launching any process, including `--version`.
Cross-OS dry plans can be inspected on Linux:

```sh
node scripts/probes/native-deny/run.mjs --os windows --dry-run
```

## Existing subscription auth handoff

The gate rig supplies `NATIVE_DENY_GATE_JSON` **in the environment**, never
on argv. The runner does not discover credentials, read the user's home,
symlink auth to a live directory, invoke login/authenticate, or reconcile
refreshed credentials back into live data. The rig must hand over a
subscription session it already holds from its existing signed-in engine.
Missing or unavailable auth produces `SKIP-NO-AUTH` before even `--version`.
Ambient API keys, OAuth variables, agent sockets, preload options, proxies
and user config overrides are not inherited by children.

Schema (replace placeholders in the rig's secret environment; do not commit
the populated object or print it):

```json
{
  "engines": {
    "claude": {
      "command": "/absolute/path/to/claude",
      "auth": {
        "source": "gate-signed-in-subscription",
        "env": { "CLAUDE_CODE_OAUTH_TOKEN": "<existing subscription session>" }
      }
    },
    "codex": {
      "command": "/absolute/path/to/codex",
      "auth": {
        "source": "gate-signed-in-subscription",
        "files": { ".codex/auth.json": "<JSON text of existing subscription auth>" }
      }
    }
  }
}
```

Only these auth destinations under the **new fixture home** are accepted:

| Engine key | Accepted handoff |
| --- | --- |
| `claude` | `CLAUDE_CODE_OAUTH_TOKEN`, or `.claude/.credentials.json` JSON text |
| `codex` | `.codex/auth.json` JSON text |
| `cursor` | `.cursor/auth.json` and/or `.config/cursor/auth.json` JSON text |
| `grok` | `.grok/auth.json` JSON text |
| `fuigo` | `.fuigo/auth.json` JSON text |
| `opencode` | `.local/share/opencode/auth.json` JSON text; every provider must have `type: "oauth"` |
| `antigravity` | No portable file/env handoff is established by the current driver; `SKIP-NO-AUTH` |

Antigravity's recipe is implemented, but its existing keyring-backed login
cannot be consulted while meeting this job's no-live-user-data rule. There
is intentionally no keyring fallback. A future rig-provided isolated auth
transport needs a reviewed allowlist addition before P-A1 can execute.

The rig's `source` attestation is required: a nonempty file by itself is not
proof of a subscription. API-key fields with nonempty values, API provider
records, unsupported environment variables and arbitrary file paths are
rejected. An expired handoff may produce a structured auth failure and SKIP,
or FAIL if the engine cannot identify it unambiguously. Neither qualifies
the engine. For multiple engine versions, repeat the invocation with each
installed binary; the version is read inside each probe's fixture.

## Fixtures and evidence

Each selected execution creates a unique `murage-native-deny-*` directory
under the OS temp root, including an empty home, work repo, config homes,
cache, temp directories, empty Git global/system config files, and harmless
canaries. HOME, USERPROFILE, AppData and XDG paths all point inside it. The
minimal repo contains fixture `.git/HEAD`, `.git/config` and
`.claude/settings.json`; no existing repository is used as the probe cwd.
Windows uses PowerShell `New-Item`; POSIX uses `touch`. No probe requests
deletion, disk writes, a fork bomb or any action against real protected data.
P-C3 includes a temporary shell prefix, P-C4/X1/A1 temporary hooks, P-C5 a
temporary approval MCP stub, and P-O2 a temporary local plugin.

Children have bounded output and time. Interruption aborts the exact child;
POSIX kills the spawned process group and Windows uses `taskkill /PID /T`
against only the spawned PID. Cleanup runs after shutdown in `finally`.
Removal requires the original temp parent, unique prefix, directory identity
and owner marker. Replaced roots/markers fail closed and are reported as a
cleanup failure; they are never recursively removed as if still owned.
Symlinks inside the fixture are removed as links, without following targets.

Stdout contains exactly one JSON line per selected probe:

```json
{"probe":"P-C1","engine":"claude","version":"2.1.292","os":"linux","result":"PASS","evidence":{"reason":"CONTRACT-PROVEN","observationOnly":false,"stages":[],"fixtureCleaned":true}}
```

The example illustrates the schema; a real PASS has populated stage checks.
No raw transcripts, prompts, arbitrary exception messages, auth or engine
stderr are printed. Evidence contains stage checks, counts, observations and
SHA-256 hashes of in-memory stdout/stderr. The hashes are receipts, not paths
to retained transcripts; temporary logs and auth are deleted with the fixture.
Unexpected shape, missing completion, unobserved action, timeout or missing
proof fails closed. Absence of a canary alone cannot establish a deny.
Exit codes: 0 for PASS/SKIP-only runs, 1 if any probe FAILs, 2 for invalid
arguments/configuration. SKIP and dry-run must never be entered as green
registry rows. The registry remains a separate reviewed gate artifact.

P-C2, C4, C5, C6 and X3 return `OBSERVATION-RECORDED` only after their
observations complete; that PASS does **not** assert native enforcement.
P-C1 records both slash spellings independently and qualifies only on the
double-slash absolute form. Grok records both modes and qualifies only if
default denies without an ask. Cursor CU2 must observe an ACP permission
request with its canary absent; an absent request cannot establish a seam.
Fuigo F1 grants only `allow_once` for the expected `echo hi` call; all other
ACP permission requests are rejected. No durable grants or login requests
are handled. Fuigo session creation must acknowledge the pinned policy hash.

For P-F3 the rig additionally supplies a read-only upstream source witness
at the top level of the gate object:

```json
{
  "fuigoSourceWitness": {
    "source": "gate-read-only-source-check",
    "root": "/absolute/path/to/upstream-source-checkout",
    "commit": "<40 lowercase hex digits>",
    "launchPolicyPath": "<repo-relative path ending in permission/launch_policy.rs>",
    "launchPolicySha256": "<64 lowercase hex digits>",
    "resolutionPath": "<repo-relative path ending in resolution.rs>",
    "resolutionSha256": "<64 lowercase hex digits>",
    "reviewedDenyAskBeforeGrants": true
  }
}
```

The rig reviews the two files at the named commit for policy precedence.
The probe verifies their bytes against the reviewed hashes and that their
resolved paths remain within the named source checkout. It never builds,
changes or executes the source checkout. Missing/mismatched source evidence
fails P-F3; the script does not pretend text search proves semantic ordering.

## Coverage

| Probe | Engine | Recorded contract / observation |
| --- | --- | --- |
| P-C1 | Claude | Both absolute-path spellings; two flagSettings refusals; shell/file canaries absent |
| P-C2 | Claude | Wrapper-shell hole recorded |
| P-C3 | Claude | Direct/wrapped/subagent prefix invocations; three canaries absent |
| P-C4 | Claude | Hook invocation count and canary existence under bypass |
| P-C5 | Claude | Approval-stub count; fixture .git/.claude edits completed |
| P-C6 | Claude | Root refusal and IS_SANDBOX outcome; Linux root only |
| P-X1 | Codex | Scoped hooks/list trust handshake; hook denial under never |
| P-X2 | Codex | Offline forbidden decision plus named live rule refusal |
| P-X3 | Codex | Simple and compound wrapper outcomes recorded |
| P-A1 | Antigravity | Skip-mode relay denial and hook-load ordering (auth prerequisite currently SKIP) |
| P-CU1 | Cursor | Force-mode scoped shell/write denies |
| P-CU2 | Cursor | Force ACP denial and permission seam |
| P-G1 | Grok | Default/bypass outcomes; default denial without an ask |
| P-F1 | Fuigo | Pinned deny, one echo Bash ask under bypass |
| P-F2 | Fuigo | Native Read/Edit completed unasked |
| P-F3 | Fuigo | Spawning disabled; reviewed source bytes verified |
| P-O1 | opencode | Deny over default allow; ordinary echo completed |
| P-O2 | opencode | Plugin-only backstop throws and reason reaches transcript |

Run unit tests with `node --test scripts/probes/native-deny/tests/*.test.mjs`
inside the authorized network-disabled test container. Tests launch only
temporary Node fakes, never installed engine binaries. These tests establish
harness behavior; real-engine qualification belongs to the later gate run.
