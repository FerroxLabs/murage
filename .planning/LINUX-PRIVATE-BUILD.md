# Private Linux candidate preparation

2026-09-07. Owned remote checkout: `/var/tmp/murage-private-20260907-muiMMr` on configured SSH alias `hetzner-dsm`. Parent created this directory and transferred base HEAD `1a5a3c0dd6e39814dfca1a779990c51b6f39ed4f` (transfer session 84127 exit 0). Final source overlay and identity are still parent-owned prerequisites. No application build has started.

Contract: install frozen dependencies using existing Node 24 runtime; identify isolated Linux packaging/native checks. No host package installation, `/opt` changes, shared dpkg database mutations, publication, source push, production updater testing, or live user-data access. Maximum two verification rounds belong to the final frozen package; preparation does not restart them.

## Completed preparation

Command executed over strict-host-key SSH in the owned checkout:

```sh
export PATH=/var/tmp/murage-build-20260905-9OpA4Y/runtime/node-v24.20.0-linux-x64/bin:$PATH
node --version
corepack pnpm --version
corepack pnpm install --frozen-lockfile
```

Actual versions: Node `v24.20.0`, pnpm `10.33.0`. Session `35294` finished exit 0; lockfile resolution skipped as current, 692 packages installed, dependency esbuild lifecycle scripts completed. pnpm reported ignored optional scripts for core-js and workerd; no allowlist was changed. This is dependency installation evidence, not a production build or native app result.

Read-only prerequisite check found `/usr/bin/dbus-run-session`, `xvfb-run`, `xdotool`, `xprop`, `desktop-file-validate`, `unsquashfs`, `dpkg-deb`, and `/usr/sbin/runuser`. Existing unprivileged user `sean` has uid/gid 1000. Owned checkout currently has mode 0700, owner root:root. No prior CUA stage was found at the two exact checked historical locations; no cache contents copied or helper build attempted.

## Planned checks after final source identity arrives

Use the existing scripts, with isolated task-owned data and an unprivileged native launch:

1. Overlay and verify the parent's final source identity; retain dependency installation if the lockfile is unchanged. Resolve Node/pnpm through the exact runtime above, never the host defaults.
2. Build/stage Linux x64 package prerequisites, then package DEB/AppImage with `--publish never`. Existing `package:linux:offline` expects a previously staged and verified CUA runtime.
3. Run `scripts/verify-linux-package.mjs` for artifact content/metadata and the existing packaged-server smoke against actual built resources.
4. Run `pnpm smoke:linux-package` for unpacked/AppImage lifecycle and isolated CUA paths. Do not set `MURAGE_SMOKE_INSTALLED_DEB=1`, which adds `/opt/Murage/murage`. Existing script creates disposable HOME/config/runtime directories and uses a fake broker; it does not pass `--no-sandbox`, so it must run as a non-root user with appropriate task-owned checkout access and supported Chromium sandbox. Root can hand ownership of this exact owned directory to existing `sean`; no user or broad host permissions need change.
5. If included by parent in the frozen check set, `pnpm smoke:linux-update --candidate-feed` uses an isolated local candidate feed. The default mode reads the public feed and is outside this private task. This check proves its stated fixture behavior, not published-update acceptance.

The CI workflow's `smoke-deb-upgrade.mjs`, install-command proof, `/opt` permission adjustment, installed-DEB smoke, and package purge mutate shared host installation state. They are unavailable under this checkout-only contract; do not execute or replace those acceptance items with archive inspection. Full native DEB install/upgrade acceptance requires an authorized disposable system environment.

## Current disposition

Dependencies ready. Await final source overlay/SHA and parent's frozen package check set before building. No live job remains from preparation. No source edits or external resources were created by this worker beyond dependency contents in the already owned checkout. Parent retains cleanup ownership of that checkout and evidence.
