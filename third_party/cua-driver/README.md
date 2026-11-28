# Cua Driver redistribution records

These files accompany the exact Cua Driver `0.55.0` Linux x64 runtime bundled by OpenMausBot. The upstream release archive omits its own license, the embedded Inter font license, a dependency notice, an SBOM, and artifact provenance, so they are preserved here and verified during packaging.

Trust anchor:

- upstream commit: `8f484f30586eef722bede7a5ce315de1148cca96`;
- archive: `cua-driver-rs-0.55.0-linux-x86_64-binary.tar.gz`;
- archive SHA-256: `1cb8aa6d30e5cdf5bf4d222cb3693a50af2c178073a49dc59e88737c5f7807e6`;
- driver SHA-256: `5d7ff450488e6a3e796d5c69c6d835dda71933c15c572097bc3bc6707212f826`;
- cursor-theme SHA-256: `b69b09dc7ab54cba4e565d863f6f03bb30a9af251d538813dd74b11c37089e67`;
- upstream `Cargo.lock` SHA-256: `1550b8d9ba05724bdae700dc839616f6d40adb873255ca23179c40e0456b221c`;
- embedded Inter `4.001` SHA-256: `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`.

`THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES.html`, and `SBOM.cdx.json` are generated from two root-scoped `cargo-about 0.8.4` JSON reports. Do not feed the virtual workspace's raw `cargo metadata` graph to the generator: Cargo unifies features enabled by unrelated workspace members, which overstates the two release binaries.

The official [`cargo-about-0.8.4-x86_64-unknown-linux-musl.tar.gz`](https://github.com/EmbarkStudios/cargo-about/releases/download/0.8.4/cargo-about-0.8.4-x86_64-unknown-linux-musl.tar.gz) archive used for the reviewed output has SHA-256 `c7381aa0cdc41fc0ee662cec8daa260da7817ad8ddea04cd4ddad425460adf14`. The 0.55.0 driver has path dependencies on `libs/cua/crates` (`cua-telemetry`, `cua-agent-setup`, `cua-home`), so the upstream checkout must include both `libs/cua-driver` and `libs/cua`. From the exact upstream checkout's `libs/cua-driver/rust` directory, run:

```bash
cargo-about generate \
  --locked \
  --target x86_64-unknown-linux-gnu \
  --manifest-path crates/cua-driver/Cargo.toml \
  --features portal-input \
  --config /path/to/OpenMausBot/third_party/cua-driver/about.toml \
  --format json \
  > cua-driver.cargo-about.json

cargo-about generate \
  --locked \
  --target x86_64-unknown-linux-gnu \
  --manifest-path crates/cursor-theme-cli/Cargo.toml \
  --config /path/to/OpenMausBot/third_party/cua-driver/about.toml \
  --format json \
  > cursor-theme.cargo-about.json

node /path/to/OpenMausBot/scripts/generate-cua-sbom.mjs \
  cua-driver.cargo-about.json \
  cursor-theme.cargo-about.json \
  Cargo.lock \
  /path/to/OpenMausBot/third_party/cua-driver
```

The generator fails unless the reports contain the reviewed root-scoped sets: 381 registry packages for the driver, 239 for the cursor-theme sidecar, and a 386-package union. The final CycloneDX inventory contains those 386 packages, ten Cua workspace packages, and the embedded Inter font. The MPL-2.0 set is exactly seven packages (unchanged). Regeneration is expected to produce a reviewed diff; no release process accepts new native inputs automatically.

OpenMausBot ships only the CLI and cursor-theme sidecar. The Linux SDK `.so`, Node `.node`, ABI header, and GNOME helper are not included in Phase 5 because the current runtime does not load them and must not silently install a Shell extension.
The app's npm Cua SDK is used by the separate macOS integration and may have a different version; it is not loaded by this Linux CLI-spawn runtime.
