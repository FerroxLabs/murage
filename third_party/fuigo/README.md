# Fuigo release provenance

Murage pins Fuigo **1.0.11** as a separate native executable. The engine requires no global Node, npm or Fuigo installation inside a packaged app.

The [official npm manifest](https://registry.npmjs.org/fuigo/1.0.11) declares six exact-version platform dependencies. Each registry archive was downloaded and checked against the GitHub release `SHA256SUMS` (byte-identical to the matching `fuigo-<target>-1.0.11.tgz` asset) and against the SHA-512 integrity values in both `release-manifest.json` and the public npm metadata. SHA-256 pins below were computed from those exact archives and their Brotli-decompressed executables, and each executable header was read to confirm its architecture. No npm postinstall script was run to obtain the binaries.

Source: `8821a4885ed3e4e55b756e14b65206db499fe2da`. [Release and checksums](https://github.com/FerroxLabs/fuigo/releases/tag/v1.0.11).

| Target | Package | Tarball SHA-256 | Executable SHA-256 |
| --- | --- | --- | --- |
| darwin-arm64 | `@fuigo/darwin-arm64@1.0.11` | `b5e1f038a57b3ecfc815916367d69d6f294d5eeb536ae47b794f0e6851e94ae1` | `35ded8492cdb110d8e633403fef69631ee47a0c51c137fc32d36592e83665d86` |
| darwin-x64 | `@fuigo/darwin-x64@1.0.11` | `4f5952291d5a495b59e09fa6095a7ba92f0ea0824c1c8318f7133cfa7e16a7ca` | `3fc9128f2a7a021bc6f199c921de1d4b479ecac96a16d954c7e2fdde5e33051f` |
| linux-arm64 | `@fuigo/linux-arm64@1.0.11` | `bbb0207a21ec8232f5bf73a1718a352bf710c55c8b0c1cc9e1d7318cdb9660cc` | `86164d3b8771ddff32ddb510917a18a05ee032f7b09984d893fde0555f560f9a` |
| linux-x64 | `@fuigo/linux-x64@1.0.11` | `7e2cb8ef527d730833d49f5e6dfb05f74a2e090f3af717d8440c94e608c1d750` | `801a5a472e62089893874492e3fd377b45ac26eeaa9251f5bfe2306c1be1dacf` |
| win32-arm64 | `@fuigo/win32-arm64@1.0.11` | `7e9d80e0b0b45246b1fa13f164724cc9d3033ad6d46c80906c5f3c4a114d99b9` | `a1f2dd364531132528c1021a3c35302d6cc7bf58350049205eb91262ef859941` |
| win32-x64 | `@fuigo/win32-x64@1.0.11` | `268597a0ca3c66c0869b332a7c027b842c2aec004f186ec2f4a3e7cfa78d2dff` | `2572b930474b1751503d672e10cb886a657f167d96379118a4b2953b2123cc41` |

The existing `scripts/prepare-fuigo.mjs` validates both digests and the executable header before staging. Existing platform selection remains unchanged; this bump adds no platform or parser support. The 1.0.11 arm64 engines are still ELF aarch64 and PE ARM64, which the shared header parser does not classify, so linux-arm64 and win32-arm64 stay pinned but unstageable. Staged files remain in ignored `dist-native/fuigo/`. `MURAGE_FUIGO_ARCHIVE_DIR` can supply the reviewed archives without another download.

## License and memory

The Apache-2.0 LICENSE, NOTICE, comprehensive dependency notices and vendored notices are copied from the published package and included in `licenses/fuigo/`. At 1.0.11 they are byte-identical to the copies already vendored here, and identical across all six platform packages. Existing named license links remain available. Package checksums are not code-signing or notarization proof; application signing continues through its existing packaging process.

Fuigo enables local workspace memory by default (since 1.0.9). Global sharing, remote embeddings and automatic model consolidation remain opt-in. Murage explicitly passes `--no-memory` before `agent` and `--no-leader` for every hosted turn, so Murage remains the memory owner even when ambient `FUIGO_MEMORY=1` or standalone configuration enables Fuigo memory. The 1.0.11 executable still accepts that exact argument order. Standalone Fuigo configuration is not rewritten. This dependency update does not rewrite user configuration or migrate memory/session stores.

## Tool presentation (1.0.11)

Fuigo 1.0.11 adds an opt-in `FUIGO_TOOL_PRESENTATION` setting. The default, `full`, sends the same tool set as 1.0.10. `compact` shortens descriptions for 13 built-in tools; `adaptive` also holds back native media-generation schemas until `search_tool` with `scope: "native"` discovers them. Tool names, parameter schemas, permissions, hooks and AGENTS.md handling are unchanged in every mode, and discovery never grants permission. Murage does not set this variable. Like other ambient `FUIGO_*` settings it reaches the hosted engine unchanged, so a user who opts in outside Murage gets the same presentation inside Murage. Provider credential routing and permission prompts retain the existing Murage driver behavior.
