# Fuigo release provenance

Murage pins Fuigo **1.0.8** as a separate native executable. The engine requires no global Node, npm or Fuigo installation inside a packaged app.

The [official npm manifest](https://registry.npmjs.org/fuigo/1.0.8) declares six exact-version platform dependencies. The archives were checked against the release workflow manifest and public npm SHA-512 integrity values. SHA-256 pins below were computed from those exact archives and their Brotli-decompressed executables. No npm postinstall script was run to obtain the binaries.

Source: `ba7ad5430c617c3fe44cf374b22708523abc826e`. [Release and checksums](https://github.com/FerroxLabs/fuigo/releases/tag/v1.0.8).

| Target | Package | Tarball SHA-256 | Executable SHA-256 |
| --- | --- | --- | --- |
| darwin-arm64 | `@fuigo/darwin-arm64@1.0.8` | `483c74705164738fd1b8f17f625e431b469c9ee07d5ee9085b92b45a4241680a` | `467a5f9995645a61ab557e2cdaded5eefe8e2a38c54adec570571d88594e9fe9` |
| darwin-x64 | `@fuigo/darwin-x64@1.0.8` | `94c3e85f00b0822cd596fdd516d634577f582edd7818ce59e97b0a94b3f049db` | `7f3838a05f0fcb2d0972d70a50d732101896bedabcdfb330b1697c607a0c2ad4` |
| linux-arm64 | `@fuigo/linux-arm64@1.0.8` | `5529f175192b2df9532fee3afa994928b7ff06ef20a1b1dc7a0ffce8875271b9` | `4dd3aafd479df74a592eb278ff2f79abee9d800cfe647ca0e31488b077f670af` |
| linux-x64 | `@fuigo/linux-x64@1.0.8` | `0b914ba561ec4b769882645484d67fb86c6b03be9874d0be2268ea3398c2e175` | `feb099cfd51d5d18bd946add779fdf3a64b95d1f736795701eeb7cc0e722efec` |
| win32-arm64 | `@fuigo/win32-arm64@1.0.8` | `42f2fd9101f4200597cbf66ed51cc3813b7e6e6d8e3de03e657da89166082517` | `670e876a67b9aa6e5701274c1a324ea2dad5b2ae7594a82e4b1aac236c276e9c` |
| win32-x64 | `@fuigo/win32-x64@1.0.8` | `adf3e657dd583018d76a57f8af24231a7aeb0041528415f45b32fa9abb35e972` | `c8fbd8a598e593fb0fdd486823f30189d424444b9241ed3ede80f1c6d4feada7` |

The existing `scripts/prepare-fuigo.mjs` validates both digests and the executable header before staging. Existing platform selection remains unchanged; this bump adds no platform or parser support. Staged files remain in ignored `dist-native/fuigo/`. `MURAGE_FUIGO_ARCHIVE_DIR` can supply the reviewed archives without another download.

## License and memory

The Apache-2.0 LICENSE, NOTICE, comprehensive dependency notices and vendored notices are copied from the published package and included in `licenses/fuigo/`. Existing named license links remain available. Package checksums are not code-signing or notarization proof; application signing continues through its existing packaging process.

Fuigo 1.0.8 enables local workspace memory by default. Global sharing, remote embeddings and automatic model consolidation remain opt-in. Hosts can disable native memory through `FUIGO_MEMORY=0` or `[memory] enabled = false` in their Fuigo configuration. This dependency update does not rewrite user configuration or migrate memory/session stores.
