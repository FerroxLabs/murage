# Electron 43.8.1 -> 45.x: plan (1.0.24, not done)

Stopped at a plan: this is not an adapter-only change and cannot be proven on a Linux build box.

- Pins that move together: package.json `electron` range and pnpm-lock.yaml; 8 `component: electron` rows in scripts/windows-sac-allowlist.json (per-file SHA-256 and receipt hash, recomputed from the 45.x Windows archive); scripts/release-gate/test-image.Dockerfile; scripts/fixtures/windows-builder-config.mjs; electron/cloud-home-window.mjs, electron/notify-s0.node-test.mjs, server/memory/index-wal.ts and docs/verification/windows-child-process.md name 43.8.1.
- Two majors of Electron release notes (44 and 45) must be read for breaking changes in the APIs electron/*.mjs uses; Chromium and Node move with them, so bundled Chrome and the Node ABI assumptions in tests move too.
- Proof owed on real hosts, none of which Hetzner has: packaged macOS, Windows and Linux launch, updater, Windows SAC signing path, notifications, and the cloud-home window.
- Order: bump after agent-browser and CUA settle, as its own commit, with one native smoke per OS before merge.
