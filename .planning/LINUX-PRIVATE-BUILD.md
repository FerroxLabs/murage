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

Dependencies ready. Parent supplied final source `e9320c2b` via completed overlay session 38700, exit 0, and authorized Linux packaging plus uninstalled package lifecycle and isolated candidate-feed checks. Build session `36900` runs `corepack pnpm package:prepare`, `corepack pnpm build:cua:linux`, then `corepack pnpm exec electron-builder --linux --x64 --publish never -c.extraMetadata.version=0.1.47-private.6` using the exact Node24 runtime PATH above. Generated output stays in the task checkout. Parent retains cleanup ownership; export evidence/artifacts before any cleanup.

## Candidate results

| Work item | Status | Progress / pending work |
|---|---|---|
| Linux private artifacts | ✅ Done | Build session 36900 exit 0. Produced private.6 x64 AppImage and amd64 DEB. Frontend/types/server/companion/updater and Android/cloudflared/Fuigo/CUA helper staging completed. Existing generated-CSS/chunk warnings remain. |
| Package contents and metadata | ✅ Done | Session 22444 exit 0; existing verify-linux-package script accepted both artifacts. |
| Actual packaged server | ✅ Done | Session 42588 exit 0; actual linux-unpacked resources copied into isolated fixture, health plus all 11 spawned proxy paths and MCP final-frame drain passed without node_modules in reach. |
| Uninstalled native lifecycle | ✅ Done | Confirmation session 26434 exit 0 as existing user sean, unchanged run-linux-package-smoke script, private mount namespace. Five existing lanes passed: unpacked bundled CUA, AppImage bundled CUA, AppImage SIGTERM cleanup, X11 crash/retry, Wayland fail-closed/first paint. This is headless native Linux evidence, not installed-DEB or interactive customer desktop proof. |
| Candidate-feed update | ⬜ Pending | Session 21777 exit 1 before updater script execution: development Electron lazy installation could not create its dist directory under root-owned node_modules as sean. No update behavior verified; no extra correction after confirmation. |
| Installed DEB upgrade | ⬜ Pending | Excluded on shared host under the frozen contract. Need authorized disposable system if required for release. |
| Overall execution goal | ⬜ Pending | Artifacts and native lifecycle passed; candidate-feed gate blocked on development runtime prerequisite. Parent must decide disposition before additional correction. |

The first native attempt failed before launch because the host `/tmp` is root:root 0700 and the session bus hardcodes `/tmp` despite TMPDIR. Parent authorized one targeted confirmation using `unshare --mount --propagation private`, binding only the task's `private-tmp` directory over `/tmp` inside that namespace, then launching as sean. The host `/tmp` was rechecked afterward and remains root:root 0700. No host mount or shared permission changed. Only the task checkout root and its private-tmp changed ownership to sean; dependency files were not recursively chowned. The task unpacked chrome-sandbox was configured root:root 4755 for the existing native check.

The candidate-feed command used the same private namespace and `xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/smoke-linux-update.mjs --candidate-feed`. Electron itself was missing its downloaded development runtime and exited before any updater assertion. Do not call this an update regression or a passed update test.

Local export destination: `.planning/linux-private-e9320c2b/`. Export session `44640` finished exit 0, retaining the two artifacts and `private-evidence/` logs/checksums. Local `shasum -a 256` finished exit 0 and matches both remote hashes below exactly.

Parent confirmed accepted export and authorized removal. Read-only process checks found no command line, process working directory, or mount namespace referencing the task checkout/private-tmp. Cleanup session `37631` exited 0: removed only `/var/tmp/murage-private-20260907-muiMMr` and verified its absence. The shared `/var/tmp/murage-build-20260905-9OpA4Y/runtime/node-v24.20.0-linux-x64/bin/node` remains executable; host `/tmp` remains root:root 0700. Local artifacts, checksums and logs above are preserved. Generated remote checkout/dependency files can be recreated from source; the kept local artifacts preserve the built bytes. No updater retry was performed.

SHA256 from remote artifacts:

```text
71438198a8df40eb0efbaf329db4f3b89c260570be54607c3e0a517bc4d01544  Murage-0.1.47-private.6-x86_64.AppImage
8d06812a59f7f414c72295524c6592ebf49c7b4bc4a1d62c732e16f76bcc4380  Murage-0.1.47-private.6-amd64.deb
```
