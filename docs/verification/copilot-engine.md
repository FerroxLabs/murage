# GitHub Copilot ACP contract

Adapted from af59c2ec4, a55540c3f, 16071c32b and fd4a01929.
Murage runs the person's installed `copilot --acp --stdio`. It never installs,
downloads or bundles Copilot. Sign in using `copilot login` outside Murage.

Explicit model refresh opens an empty native session to read the live model
list, premium-request multipliers and each model's thinking choices. It sends
no prompt and cannot spend a premium request. Startup and background snapshots
do not start this probe. A missing login is recognized only from the agent's
login refusal. A timeout or unrelated MCP credential error is not such proof.
Discovery refuses all file, terminal and permission requests. Its temporary
workspace is removed; Copilot session cleanup checks both the exact temporary
cwd and discovery client before removing a session folder.

Copilot 1.0.105 rejects client-provided stdio MCP servers. Murage writes only
the current turn's scoped proxies to a private per-thread JSON file and passes
`--additional-mcp-config @/absolute/path.json`. The directory is private and
the file has mode 0600. Both session/new and session/load receive an empty MCP
list. The native launcher configuration still contains the scoped tools;
broker permission decisions remain in effect. Changing proxy credentials
changes the spawn fingerprint so a pooled child cannot keep the old grant.
Disposing the driver waits for its children and removes its config directory.

Run in the shepherd's isolated no-network container:

```sh
pnpm exec vitest run server/drivers/acp/copilot.test.ts server/drivers/acp/copilot-models.test.ts server/drivers/acp/copilot-launcher.test.ts server/drivers/acp/copilot-launch-contract.test.ts
```

The launcher contract uses `server/testing/fake-copilot-launcher.mjs`, never a
real Copilot binary. It rejects MCP servers supplied through ACP and records
which synthetic launcher grant each process read. It does not claim to test a
real provider or to execute automation tools. For workflow acceptance, launch
only the isolated fixture described in README.md, install this fake in that
fixture's configuration, and retain the fixture URL, control results and
sanitized receipts. Do not verify against an owner's live app or account.

Mount review for upstream a1f772737: this tree has no server/bot-box/plan.ts or
bot-box mount planner. Its Cloud launcher deliberately excludes Copilot
(`server/cloud-home/runnable-engines.ts:17`; `server/cloud-home/turn-process.ts:5`).
Local host-power containment already exposes the local filesystem
(`server/host-power.ts:445`), including this private config reference. This
change adds no home, credential directory, parent directory or config mount.
Checked SKIP of a1f772737, read from the upstream clone. Its diff changes only
`argvPaths` in `server/bot-box/plan.ts`, which strips the `@` from an `@FILE`
argument so that the config file is mounted read-only into a Linux bot box, plus
that function's test and a doc line. This tree has no `server/bot-box`, 0 hits
for `argvPaths`, and no equivalent parser of engine argv for mounts. Copilot
passes `@path` at `server/drivers/acp/copilot.ts:247`. The local cage is
`--bind / /`, so the temp file is already readable, and Cloud bars Copilot.
`claude-guards.ts:89`, `walk.ts:1633` and `always-ask.ts:434` read argv for other
purposes. Reason for the SKIP: there is no target, and the failure the commit
fixes cannot occur here.

Exact searches used `rg -n -F -- '<term>' server/ src/`; counts below are
matching lines across both directories, including tests:

| Term | Lines |
| --- | ---: |
| `server/bot-box` | 0 |
| `bot-box` | 0 |
| `CopilotMcpConfig` | 7 |
| `prepareMcpLaunch` | 3 |
| `mcpServersFromLaunch` | 4 |
| `--additional-mcp-config` | 2 |
| `CLOUD_LOCAL_ONLY_ENGINES` | 5 |
| `isCloudLocalOnlyEngine` | 3 |
| `cloudEngineHome` | 23 |

The related local launcher target already exists: `copilot.ts:241-247` writes
the scoped reference and passes it to the CLI. These terms were
chosen before the diff was read; the diff above confirms them.
`runnable-engines.ts:17-24,41` hides and refuses choosing Copilot on Cloud;
`turn-process.ts:5,37-38` also rejects its engine home because Copilot is absent
from `CLOUD_ENGINES`. The local containment uses `--bind / /`
(`host-power.ts:445`), so it needs no extra reference mount.

This review's restricted executor could not run the contract assertion:
all 68 ACP suites stopped at `testing/setup.ts:132` with "no free port block
for offsets 0 in 19600..22600". The README's isolated fixture launch likewise
failed to allocate offsets 0,1. Server TypeScript passed with
`NODE_OPTIONS=--max-old-space-size=12288 npx tsc -p tsconfig.server.json`.
A standalone isolated driver reproduction printed "Copilot fixture closed
(exit code 0) before it finished its reply"; a minimal child-process probe
also returned `spawnSync /usr/local/bin/node EPERM`. With production containment
enabled the driver instead reported "the shipped bwrap is missing", despite
`/usr/bin/bwrap` existing. Neither observation establishes the original rig's
assertion failure. The assertion now includes that turn's runtime errors,
without changing its required successful completion or receipt checks.
