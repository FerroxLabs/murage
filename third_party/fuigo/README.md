# fuigo release provenance

Murage stages Ferrox Labs' own `fuigo` 1.0.1 engine as a separate executable so
a desktop install has a working engine without Node, npm, or `npx` on the
machine. Fuigo is published on the public npm registry:

<https://www.npmjs.com/package/fuigo/v/1.0.1>

`fuigo` is Ferrox Labs' work, derived from the Apache-2.0 licensed
[`xai-org/grok-build`](https://github.com/xai-org/grok-build) and paired with a
FluxRouter provider. It is distributed under the Apache License 2.0 — the same
license Murage itself uses — and the distribution carries a separately named
copy of the complete Apache 2.0 text at
`resources/licenses/fuigo-LICENSE.txt`, plus the upstream third-party notices
at `resources/licenses/fuigo-THIRD_PARTY_NOTICES.md` (a verbatim copy of
`THIRD_PARTY_NOTICES.md` in this directory, which is byte-identical in all four
platform packages).

## Why the npm platform packages and not `npm install`

The `fuigo` npm entry point is a Node launcher: `bin/fuigo` is a
`#!/usr/bin/env node` shim, and the real executable arrives brotli-compressed
as `bin/fuigo[.exe].br` inside the matching `fuigo-<platform>-<arch>` optional
dependency. `postinstall` decompresses it into `~/.fuigo/bin` on the installing
machine. Copying anything out of `node_modules` would therefore ship either the
compressed artifact or a shim that needs Node — neither of which runs from an
installer. `scripts/prepare-fuigo.mjs` fetches the platform package directly,
decompresses `bin/fuigo[.exe].br`, and stages the real native executable.

## Pinned assets

Every asset is pinned to 1.0.1 — never a floating range for a shipped binary —
and `scripts/prepare-fuigo.mjs` verifies these SHA-256 digests before an
executable can be staged. `scripts/after-pack.mjs` verifies the executable
digest again, inside the packaged app, before either artifact is assembled.

| Murage target | npm package tarball | Tarball SHA-256 | Decompressed executable SHA-256 |
| --- | --- | --- | --- |
| macOS arm64 | `fuigo-darwin-arm64-1.0.1.tgz` | `c4a5d836be258734dc0da0566b26e9841cbb59fd59ff6ec6442d7efc2e93f914` | `d861b35824ead4f96ec60e26ae3389d8245cce1081402a6a3c58e93b6449c140` |
| macOS x64 | `fuigo-darwin-x64-1.0.1.tgz` | `db7f26a39fbb63913fbd8cff35fa989815b948ba2060c9fe9f08a7f288f3a2ea` | `60a398bfa4482171acf36ffe7d42ea61f9e8b2e96acbcb9f1531b5159b2f32bb` |
| Linux x64 | `fuigo-linux-x64-1.0.1.tgz` | `a3cbfb62b735ead7af46d3e45f2ee719efe064f1b0235c7b7aa2e56b1112e4c3` | `f58e78d1fca5f0ef0400672be6c1238dcf7222862ddf3f2fae6dbe270adeff0a` |
| Windows x64 | `fuigo-win32-x64-1.0.1.tgz` | `6be9462ea8c37ad81353051a42ba71d4d50fe3e2dc88172cfdaf107d6ba95a8b` | `1f4cdc47f13ba88f02bceba262824cccf20d4978b0eae2bcfb2b9d1e96cfbc38` |

`fuigo-linux-arm64` also exists on the registry; Murage does not build a Linux
arm64 desktop target, so it is not pinned here. `fuigo` 1.0.1 declares
`fuigo-win32-arm64` as an optional dependency but **no such package is
published** (the registry answers 404). Murage builds Windows x64 only, so that
gap does not affect this distribution — but a future Windows arm64 target
cannot be staged until that package exists.

The staged executables are generated build output and are intentionally not
checked into git; they land under the gitignored `dist-native/fuigo/` tree. Set
`MURAGE_FUIGO_ARCHIVE_DIR` to a directory containing the exact published
tarballs to prepare a package from a reviewed local download. Otherwise the
preparation script downloads them from the registry URLs above.

## macOS signing

The published darwin executables are ad-hoc, linker-signed thin Mach-O files
with no entitlements and no non-system dylib dependencies. The macOS release
process replaces that ad-hoc signature with Murage's Developer ID signature as
part of signing the app bundle — the same nested-code treatment `cloudflared`
and `cua-driver` receive — so the bundled engine is covered by notarization.
Linux and Windows packages retain the exact decompressed upstream bytes.
