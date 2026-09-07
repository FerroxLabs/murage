# Fuigo 1.0.6 packaging evidence

Contract: update the exact packaged Fuigo pin and all six reviewed artifact digest pairs to published 1.0.6. Preserve target selection and existing unsupported ARM64 Linux/Windows staging behavior. Verify registry integrity, decompressed executable architecture, focused packaging tests, and current-host staging (darwin-arm64). No live app, release, commit, dist-server changes or cross-platform runtime claim. Two rounds maximum; this lane uses round 1.

Registry inspection on 2026-09-07: `https://registry.npmjs.org/fuigo/1.0.6` returned 200 and declares all six `@fuigo/<target>` optional dependencies at exact 1.0.6. Each `https://registry.npmjs.org/@fuigo/<target>/1.0.6` returned 200. Downloaded each `dist.tarball`, compared computed SHA-512 SRI with registry `dist.integrity`, extracted `package/bin/fuigo[.exe].br` through tar stdout, Brotli-decompressed, then computed both SHA-256 digests now pinned in `scripts/prepare-fuigo.mjs` and its test. All six registry integrity comparisons passed.

| Target | Actual header | Decompressed bytes |
| --- | --- | ---: |
| darwin-arm64 | Mach-O arm64, shared parser matched | 173137808 |
| darwin-x64 | Mach-O x64, shared parser matched | 182140192 |
| linux-arm64 | ELF e_machine 0xb7 (AArch64) | 203873960 |
| linux-x64 | ELF x64, shared parser matched | 213396464 |
| win32-arm64 | PE machine 0xaa64 (ARM64) | 122420224 |
| win32-x64 | PE x64, shared parser matched | 143819776 |

Linux/Windows ARM64 remain refused by the existing shared-parser limitation. Header inspection and byte integrity establish artifact identity, not execution on those platforms. Initial artifact inspection used memory and tar stdout, creating no temporary files. Current-host staging uses the existing preparer's temporary-directory cleanup.

Round 1 ACCEPTED for this scoped packaging lane:

- `rtk proxy pnpm exec vitest run scripts/prepare-fuigo.test.mjs`: 1 file / 11 tests passed, exit 0.
- `rtk proxy node scripts/prepare-fuigo.mjs --current`: exit 0, `staged fuigo 1.0.6 for darwin-arm64`. Existing helper verified tarball SHA-256, decompressed binary SHA-256, architecture and runnable version before staging, then cleaned its scratch directory in `finally`.
- `rtk proxy cat dist-native/fuigo/darwin-arm64/manifest.json`: exact version 1.0.6, target darwin-arm64, registry package @fuigo/darwin-arm64@1.0.6, tarball SHA-256 `f7bb3f682f81a167ad056da7b5cee625445f9d31ac19cfeb208b65030af5bae5`, binary SHA-256 `dfc0f618662076f6e3d8b2353934bd1f141d838ae40290444b3d730a8bfc9eb8`.
- `rtk proxy dist-native/fuigo/darwin-arm64/fuigo --version`: exit 0, `fuigo 1.0.6 (b921c6ded37d)`.
- Scoped `git diff --check`: exit 0.

No corrections or second verification round required. Current-host staged resource retained for parent integration; no temporary resources remain from this lane. Packaged app integration and release are outside this lane and remain the parent task's responsibility. No other target was staged or executed.
