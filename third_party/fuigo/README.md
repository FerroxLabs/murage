# Fuigo release provenance

Murage pins Fuigo **1.0.12** as a separate native executable. The engine requires no global Node, npm or Fuigo installation inside a packaged app.

The [official npm manifest](https://registry.npmjs.org/fuigo/1.0.12) declares six exact-version platform dependencies. Each registry archive was downloaded and checked byte-identical to the matching `fuigo-<target>-1.0.12.tgz` in the `npm-packages-1.0.12` artifact of the upstream release workflow run that published it, and against the SHA-512 integrity and SHA-1 shasum values in both that artifact's `release-manifest.json` and the public npm metadata (whose `gitHead` is the same source commit). SHA-256 pins below were computed from those exact archives and their Brotli-decompressed executables, and each executable header was read to confirm its architecture (Mach-O arm64 / x86_64, ELF `0xb7` / `0x3e`, PE `0xaa64` / `0x8664`). No npm postinstall script was run to obtain the binaries.

Source: `f296fc504f4800fa07057e4a3fd98f7a86dc8009` (branch `v1.0.12`). Canonical archives: [release workflow run 34588671916](https://github.com/FerroxLabs/fuigo/actions/runs/34588671916), all jobs successful including "Verify release archives" and the six "verify npm" jobs. **No GitHub release `v1.0.12` existed at bump time and none is expected**: the upstream release workflow publishes to npm only, and the 1.0.11 GitHub release (with its `SHA256SUMS`) was made by hand. The workflow artifact carries no `SHA256SUMS`, so the SHA-256 values in the table were computed here over the artifact archives and are the reviewed digests.

| Target | Package | Tarball SHA-256 | Executable SHA-256 |
| --- | --- | --- | --- |
| darwin-arm64 | `@fuigo/darwin-arm64@1.0.12` | `be60a7aaeb0222db22128b6b8bb945afd3efe267200e4a1dbb9706f7ff84af60` | `d02b5dd29d696f11c0960da7969b165b901da1e950182ecfe7e7271674d86675` |
| darwin-x64 | `@fuigo/darwin-x64@1.0.12` | `c388f79e4cd8bc2412d14b9a689fb066a511dcdbd0116aa35ea930c15ae0ee25` | `0f93752985f72b9d93bdd348e71a19d9a83c3d29f4d349bd367ec22f98b57676` |
| linux-arm64 | `@fuigo/linux-arm64@1.0.12` | `2a8bdadc497981d7f476f2857d308ae9abbfef699f894213b8e9ec7229f5821e` | `a2ef2f39140762f14b557fc13c4b828f3eb373a141b0bbec3f3022bd9be2eb16` |
| linux-x64 | `@fuigo/linux-x64@1.0.12` | `52c9b627a8e263909a5074e1ef4a83f83fd394582fc2fae08993586aad5c0200` | `c3627688e9e2bfc4af5b84175362ceee71cad86f0e01e04469d6d7163e90c638` |
| win32-arm64 | `@fuigo/win32-arm64@1.0.12` | `63331f20a1d44ab1864763dbdc87519e24eb1a0b613486fc88487904ff252f43` | `c6812a0e725ad52a5f943546474d3f6edb23677e17afbf08176c58c3209d8bc2` |
| win32-x64 | `@fuigo/win32-x64@1.0.12` | `a3d27c93bbb87934d34e4118b330d44c8df29c86f74eab5c303f9622e4a1a21f` | `38bbf9ee011050cce0aad44d49a907617f9bfe23d5ce06bf87928e9f6f45f945` |

The existing `scripts/prepare-fuigo.mjs` validates both digests and the executable header before staging. Existing platform selection remains unchanged; this bump adds no platform or parser support. The 1.0.12 arm64 engines are still ELF aarch64 and PE ARM64, which the shared header parser does not classify, so linux-arm64 and win32-arm64 stay pinned but unstageable. Staged files remain in ignored `dist-native/fuigo/`. `MURAGE_FUIGO_ARCHIVE_DIR` can supply the reviewed archives without another download.

## License and memory

The Apache-2.0 LICENSE, NOTICE, comprehensive dependency notices and vendored notices are copied from the published package into this directory and packaged as `licenses/fuigo-*`. At 1.0.12 they are byte-identical to the copies already vendored here (unchanged since 1.0.11), and identical across all six platform packages. Existing named license links remain available. Package checksums are not code-signing or notarization proof; application signing continues through its existing packaging process.

Fuigo enables local workspace memory by default (since 1.0.9). Global sharing, remote embeddings and automatic model consolidation remain opt-in. Murage explicitly passes `--no-memory` before `agent` and `--no-leader` for every hosted turn, so Murage remains the memory owner even when ambient `FUIGO_MEMORY=1` or standalone configuration enables Fuigo memory. The 1.0.12 executable still accepts that exact argument order. Standalone Fuigo configuration is not rewritten. This dependency update does not rewrite user configuration or migrate memory/session stores.

## Tool presentation (1.0.11)

Fuigo 1.0.11 added an opt-in `FUIGO_TOOL_PRESENTATION` setting. The default, `full`, sends the same tool set as 1.0.10. `compact` shortens descriptions for 13 built-in tools; `adaptive` also holds back native media-generation schemas until `search_tool` with `scope: "native"` discovers them. Tool names, parameter schemas, permissions, hooks and AGENTS.md handling are unchanged in every mode, and discovery never grants permission. Murage does not set this variable. Like other ambient `FUIGO_*` settings it reaches the hosted engine unchanged, so a user who opts in outside Murage gets the same presentation inside Murage. Provider credential routing and permission prompts retain the existing Murage driver behavior.

## Headless sessions and `ask_user_question` (1.0.12)

Fuigo 1.0.12 stops advertising `ask_user_question` to non-interactive sessions (`fuigo -p`, SDK), because nobody is there to answer. The gate is: an explicit `_meta.askUserQuestion` on `session/new` wins; otherwise `_meta.startupHints.nonInteractive` turns the tool off; otherwise the `ask_user_question` feature decides. Murage's ACP driver sends neither key, so its sessions resolve as interactive and the tool is advertised exactly as under 1.0.11; the `_fuigo/ask_user_question` request shape and the answer path Murage renders as a question card are unchanged. The rest of 1.0.12 is engine-side (OpenAI models default to the Codex harness, opt-in OpenAI Responses programmatic tool calling, whole-file and multi-path `read_file` with a read-dedupe cache, synchronous-by-default `spawn_subagent`, tool-list stability across side calls) and needs no Murage driver change.
