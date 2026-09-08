# Fuigo release provenance

Murage pins Fuigo **1.0.9** as a separate native executable. The engine requires no global Node, npm or Fuigo installation inside a packaged app.

The [official npm manifest](https://registry.npmjs.org/fuigo/1.0.9) declares six exact-version platform dependencies. The archives were checked against the release workflow manifest and public npm SHA-512 integrity values. SHA-256 pins below were computed from those exact archives and their Brotli-decompressed executables. No npm postinstall script was run to obtain the binaries.

Source: `daa2e117371ac62b28dc9c54df3503fadfdda3f1`. [Release and checksums](https://github.com/FerroxLabs/fuigo/releases/tag/v1.0.9).

| Target | Package | Tarball SHA-256 | Executable SHA-256 |
| --- | --- | --- | --- |
| darwin-arm64 | `@fuigo/darwin-arm64@1.0.9` | `bff954cc2460cb71e50a594148be90260d693a56cedfc45ac5be63602d64dc08` | `753533a987637e5b249afca3a1f628a7af4d101f73431919d4b3e8f8500c282d` |
| darwin-x64 | `@fuigo/darwin-x64@1.0.9` | `5ae11a345d1d93c4dff3a47522019c4425fb742d08c3dc8d9273e46b71f21468` | `6b0ad2051183fc3a239594e87b14fe4631e012b087474dca38b032618a41d761` |
| linux-arm64 | `@fuigo/linux-arm64@1.0.9` | `daa7da62e332d034afe0272ed053cf5b170b31b2863ce6ca1783d6842bac3a54` | `f1e14ce97a45d5b5497250b086ee28fa6c85506d6ae5cee8008ab269888c7259` |
| linux-x64 | `@fuigo/linux-x64@1.0.9` | `9c3a4469be4d1dfc34d00b563d8d25a585281bed50cdbd363a44150250c9359b` | `9a4625bb7b41308156e06bc6dcc495e0ea86b054e7511762c2416bc8e0c8ac9a` |
| win32-arm64 | `@fuigo/win32-arm64@1.0.9` | `6ea9b0253d5dad0835fc6f093f49df4635ba0cab77b61c0e34176c9e54f3c0fc` | `d7693f11f037aa72bf0a449e5b5baf5dadb5d19e28a38aed64c7dce494dd729b` |
| win32-x64 | `@fuigo/win32-x64@1.0.9` | `f2252fa8e9bd55b551d8f21bf47a6bfff42adeba82416bc27a2edb65f5bb592d` | `abd87d0d78c901c8c9f3b3cf0f5b474ea664f64c56cda35565f5f22ed1c1241d` |

The existing `scripts/prepare-fuigo.mjs` validates both digests and the executable header before staging. Existing platform selection remains unchanged; this bump adds no platform or parser support. Staged files remain in ignored `dist-native/fuigo/`. `MURAGE_FUIGO_ARCHIVE_DIR` can supply the reviewed archives without another download.

## License and memory

The Apache-2.0 LICENSE, NOTICE, comprehensive dependency notices and vendored notices are copied from the published package and included in `licenses/fuigo/`. Existing named license links remain available. Package checksums are not code-signing or notarization proof; application signing continues through its existing packaging process.

Fuigo 1.0.9 enables local workspace memory by default. Global sharing, remote embeddings and automatic model consolidation remain opt-in. Murage explicitly passes `--no-memory` before `agent` and `--no-leader` for every hosted turn, so Murage remains the memory owner even when ambient `FUIGO_MEMORY=1` or standalone configuration enables Fuigo memory. Standalone Fuigo configuration is not rewritten. This dependency update does not rewrite user configuration or migrate memory/session stores.

Fuigo 1.0.9 adds bounded memory-only recall and optional semantic retrieval calibration. Those standalone memory changes do not enable native Fuigo memory inside Murage. Provider credential routing and permission prompts retain the existing Murage driver behavior.
