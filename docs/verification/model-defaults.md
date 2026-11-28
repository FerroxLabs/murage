# Model defaults qualified for 1.0.19; Fable 5.2 not yet qualified on Cloud home

Checked 2026-11-06, before changing the defaults, and re-checked 2026-11-17
against the 1.0.19 tip (see [1.0.19 re-check](#1019-re-check)). Fable 5.2
evidence: [Claude Fable 5.2](#claude-fable-52-checked-2026-11-17-against-the-1019-tip).

## 1.0.19 re-check

The defaults and pins this qualification rests on are unchanged on the 1.0.19
tip: `server/drivers/claude.ts` defaults to `claude-sonnet-5-5`,
`server/drivers/codex-catalog.ts` defaults to `gpt-6.1-sol`, and
`deploy/cloud-home/build-image.sh` pinned Claude Code 2.1.292 and Codex
0.162.1 with the x64 hashes recorded below (1.0.22 moved the Cloud pins to
Claude Code 2.1.323 and Codex 0.171.0; these two builds remain the support
floors the evidence below qualifies). The binary evidence below applies to
those floor builds. Claude Fable 5.2 is listed but **not yet
qualified on Cloud home**; its section at the end records what was and was not
checked.

## Distribution and support evidence

Desktop Murage bundles Fuigo, but does not bundle Codex or Claude Code:
`package.json` and `electron-builder.yml` contain no Codex dependency/resource.
`server/engine-management.ts` reads `@openai/codex/latest`; the native installer
checks the downloaded release digest. Claude uses its vendor native installer.

**Cloud home does bundle both engines.** `deploy/cloud-home/build-image.sh`
pinned Codex **0.162.1** and Claude Code **2.1.292** when this evidence was
captured; 1.0.22 moved the pins to Codex 0.171.0 and Claude Code 2.1.323
(LICENSES.md, the qualification script's `PINS` and `engine-cli-pins.test.ts`
agree on the new pins). The hashes below are those of the 0.162.1 / 2.1.292
support-floor builds, not the current recipe pins:

- The floor Codex x64 archive from
  `https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-x86_64-unknown-linux-musl.tar.gz`
  hashes to `86f268d81b898f3e144c5ecff2ad2fda2c5802e042d6195b72538fe0fa125057`,
  the floor build's hash. Its embedded catalog contains `gpt-6.1-sol`,
  display name `GPT-6.1-Sol`, `visibility: list`, `supported_in_api: true`,
  and priority 1. This is direct support evidence from the floor version.
- The floor Claude binary from
  `https://downloads.claude.ai/claude-code-releases/2.1.292/linux-x64/claude`
  hashes to `a967e7b1d8b4e47ee421d5433027880347952b0c0857abf880e2c942a4ec93b3`,
  the floor build's hash, and contains the first-party `claude-sonnet-5-5` ID.

Public package evidence (no login, credentials, or inference):

- `https://registry.npmjs.org/@openai%2Fcodex/0.167.0` maps Linux x64 to
  `@openai/codex@0.167.0-linux-x64`. The downloaded native package's embedded
  catalog contains `"slug": "gpt-6.1-sol"` and `"display_name": "GPT-6.1-Sol"`.
  Tarball SHA-256: `2dc9aa871abb513c3539d20d025f701faf1974c46ee906bda3a1e1f5026d4434`.
- `https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/2.1.287` maps Linux x64
  to `@anthropic-ai/claude-code-linux-x64@2.1.287`. Its native binary contains
  the first-party `claude-sonnet-5-5` ID, alongside `claude-opus-5-5` and the
  older Sonnet IDs. This agrees with the existing Claude catalog qualification.
  Tarball SHA-256: `348090e889baacf20e6665fd236e2bc617767eb733407151128efd0281a06111`.

Both npm tarballs matched their metadata shasums. These checks establish CLI
model support, not entitlement on any particular account. No provider request
was made. A successful live Codex catalog remains authoritative over the static
fallback, including on older installed versions. A configured Codex model also
retains its existing precedence.

## Saved choices

`server/model-defaults.test.ts` creates persisted bots on each old default and
an unknown model, reopens the store against the new catalog, checks the saved
selection and turn selection, and rejects migration through the stale-model
helper. New bots with no saved choice get the new default. Self-knowledge reads
the chosen model, using the catalog default only when no model is supplied.
Catalog tests also retain explicit Codex config choices without rewriting files.
The picker and setup card read the current catalog rather than hard-coded model
recommendations. The capability database explains the defaults separately from
the model a bot actually uses.

## Verification boundaries

Use the isolated fixture in README.md for `doctor` and `models`; it uses only
the fake engine. Targeted driver tests exercise fake Claude and Codex protocols.
Neither those checks nor the fixture prove real account entitlement or packaged
Electron rendering. Those require the release driver's separate checks.

Observed fixture result: `doctor.ok=true`; `models` reported
`claude-sonnet-5-5`; `new-bot` persisted that model; `send hello` followed by
`wait` returned `settled`, and `messages` contained `hello from fake claude`.
The foreground launcher was interrupted normally and removed its fixture data.


## Review fixes and reproducible artifact evidence

The checked-in [artifact capture](model-defaults-artifacts.json) records the
exact x64 download hashes of the floor builds, binary hashes, byte offsets, the complete
embedded Codex model row, and a Claude embedded model-map excerpt. Reproduce
without executing either binary: download the two URLs in the capture, verify
SHA-256 against the capture, extract the Codex tarball, and read the indicated
byte offsets. Codex's offset starts a JSON object; Claude's excerpt is 300 bytes.
These are binary catalog evidence, not a claim about an account's entitlement.

Desktop Claude now requires readable version 2.1.292 or newer, including after
failed probes. Codex accepts a successful live catalog, or requires version
0.162.1 or newer before using the static fallback (including cloud home, which
skips model/list). Older/unreadable installations report Update Required.
Previously qualified Codex catalogs survive transient refresh failures only while
the executable identity is unchanged; a replaced binary is requalified.

Recognized saved Claude settings and Codex models remain defaults even when a
live Codex list omits the saved row. Blank persisted native choices resolve at
dispatch without changing storage. For Codex, a blank resumed selection accepts
the model returned by the existing thread; only a new thread gets the catalog
default. Explicit saved models still pin both resume and new-thread requests. The two vendor rows were refreshed from models.dev on 2026-11-06, and the
snapshot digest and vision table regenerated. Other model rows retain their
previous captured values: a full upstream refresh introduced unrelated,
conflicting vision declarations for existing models. The partial snapshot omits
the upstream whole-response ETag; fetchedAt records this refresh date.

## Claude Fable 5.2 (checked 2026-11-17 against the 1.0.19 tip)

Murage's static Claude list carries `claude-fable-5-2` ("Claude Fable 5.2",
1,000,000 context) first among the Fable rows, and the default stays
`claude-sonnet-5-5` (`server/drivers/claude.ts`, `STATIC_CLAUDE_MODELS`; added
by `b324d0ba5e`, "Update Claude Fable catalog from published models", citing
the Anthropic models overview of 2026-11-14). Tests that pin the row:
`server/drivers/claude-catalog.test.ts` (list contents, and that the newest
Fable id is first) and `shared/model-order.test.ts` (ordering and version
parse of `claude-fable-5-2`). The row lives in Murage's list; nothing in the
driver gates it on a Claude Code version.

**Claude Code 2.1.292 (the support floor, no longer the Cloud pin): UNVERIFIED for `claude-fable-5-2`.**
The x64 binary from
`https://downloads.claude.ai/claude-code-releases/2.1.292/linux-x64/claude`
hashes to the floor build's hash (`a967e7b1...c93b3`, same as above). A byte search
of that file (read only, never executed) finds `claude-fable-5-1` and
`claude-fable-5`, `claude-sonnet-5-5` and `claude-opus-5-5`, but **no**
`claude-fable-5-2`, no `fable-5-2` or "Fable 5.2" display text, and no
`claude-haiku-5-5` (which Murage also lists). So the 2.1.292 embedded model map
does not name Fable 5.2. That is not proof it is refused: whether the CLI
passes an unlisted id through to the API, and whether the account is entitled,
were not tested (no login, no inference). Until a Cloud home image is built
with a newer pinned Claude Code, or a live turn with `claude-fable-5-2` is run
on one, treat Fable 5.2 on Cloud home as UNVERIFIED. Desktop uses the person's
own Claude Code install, which must be 2.1.292 or newer but is otherwise
outside this check.
