# Fuigo release provenance

Murage pins Fuigo **1.0.7** as a separate native executable. A desktop install
therefore needs no Node, npm, or global Fuigo installation to run this engine.
The release source is the [official npm manifest](https://registry.npmjs.org/fuigo/1.0.7),
which declares six exact-version `@fuigo/<platform>-<arch>` optional dependencies.

## Verified published assets

For this bump, every wrapper/platform manifest signature was checked against the
npm registry's published signing key, and every downloaded tarball matched its
manifest's SHA-512 integrity and SHA-1 shasum. The SHA-256 pins below were computed
from those tarballs and their Brotli-decompressed native executables. No upstream
postinstall script was executed. Release/download evidence is recorded in
`.planning/memory-evidence/fuigo-1.0.7-release.json`.

| Target | npm package | Tarball SHA-256 | Decompressed executable SHA-256 |
| --- | --- | --- | --- |
| macOS arm64 | `@fuigo/darwin-arm64@1.0.7` | `15a2b8f4cfae2cde5139edb9851a0fa0c2a0a2294efb6750ce2ba4d4d24f2645` | `41a8bd3697ea28624d7c94e784bdccae09ac7e5343d064b6accee5a2ad8bddb4` |
| macOS x64 | `@fuigo/darwin-x64@1.0.7` | `29d5e898c5b13e497bbda1e63a334d6c5e82cfc9b3c174a1b791e01dd2446788` | `cc8a49c34722b1ec976fe3fa226899bffd435559464a3e1eaf7177648791c895` |
| Linux arm64 (pin only) | `@fuigo/linux-arm64@1.0.7` | `dd6c574a54257501ac7bee64e8da69efca69f719193d76443750b7a7afcfb2d7` | `77af3b40226ae50546191e677532e27078c9cd279922eed4e126425232baea00` |
| Linux x64 | `@fuigo/linux-x64@1.0.7` | `fb3cfcc3467bd5f7f5e0fdf5828bc0a2f3f16606e9e592c2153384cbf94f0341` | `ffc5d96357bbcab19dfc5025905c999dc6b7a9a1b815bc606dfe7325a6f64a7d` |
| Windows arm64 (pin only) | `@fuigo/win32-arm64@1.0.7` | `4c9be39f227fd9ce7b71cc84492c61a775b40638a3012c9a43e7461df6da8a77` | `add0bdb737572e521ebd6d0e25f92ec0e64e723d94592e380d61cf8d4419cf6e` |
| Windows x64 | `@fuigo/win32-x64@1.0.7` | `32f2aab3dde7eb8ad69407e013031ef435bebaef187bf952a0f1295a7dd4a0f7` | `af26c191f89bb3c61785f8e927561f615ea2bda804187d25b3e2589dd985bdd3` |

The tarball URL for each target is
`https://registry.npmjs.org/@fuigo/<target>/-/<target>-1.0.7.tgz`.
The wrapper is a Node launcher; the platform package contains
`package/bin/fuigo.br` (`fuigo.exe.br` on Windows). The existing
`scripts/prepare-fuigo.mjs` downloads and verifies that archive, decompresses the
native executable, and verifies its bytes and executable header before staging.

Murage still builds macOS arm64/x64, Linux x64 and Windows x64. Linux/Windows
arm64 remain pinned but not stageable because the shared executable-header parser
does not classify their ELF aarch64 / PE ARM64 headers. This bump adds no platform
or parser support.

Staged output remains under the ignored `dist-native/fuigo/` tree. Set
`MURAGE_FUIGO_ARCHIVE_DIR` to a directory containing these exact reviewed tarballs
to avoid another download. Nothing is installed globally or copied into a live
user profile. Preparing, testing and packaging the native engine are separate
checks from this source/digest update.

## License and native memory

The published package declares Apache-2.0. Its `THIRD_PARTY_NOTICES.md` matches the
retained copy in this directory; the existing distribution license/notice mapping
is unchanged. Packaged macOS signing continues through the existing nested-code
signing process; checksum review is not signing or notarization proof.

The 1.0.7 wrapper README and package manifest do not document native-memory
defaults. This dependency bump does not infer or change those defaults, Murage
memory settings, authentication, or provider configuration.
