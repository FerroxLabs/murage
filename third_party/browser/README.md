# Bundled bot browser: upstream provenance and notices

The desktop application ships two separate components:

- **agent-browser 0.36.0**, official Vercel release executables (superseded for every shipped target by the omb.2 vendor builds below) from
  <https://github.com/vercel-labs/agent-browser/releases/tag/v0.36.0>.
  Its Apache-2.0 license is included as `agent-browser-LICENSE.txt`.
  The bundled axe-core code's upstream license and third-party notices are
  included as `LICENSE-axe-core.txt` and `LICENSE-axe-core-THIRD-PARTY.txt`.
  These files are copied from the same `v0.36.0` source tag; there is no
  root-level NOTICE in that tag.
- **Engine 0.36.0-omb.2 (macOS and Linux desktop targets), 0.36.0-omb.3 (Windows) and 0.38.1-omb.2 (Cloud home, Linux)** are Ferrox Labs
  vendor builds. The macOS and Linux engine executables are no longer the official Vercel bytes: they are
  built from the exact upstream source (v0.36.0 commit `eb05921bad874cd2a1b4fa5d1149f1ed26576cae`; v0.38.1
  commit `aff6125c023b810ea3f2e5deec5379e9a4270bdc`) plus the reviewed `murage-control-token` patch
  (`patches/murage-control-token.fix1.patch`, and its v0.38.1 port `patches/murage-control-token.v0381.patch`).
  Windows applies `agent-browser-windows-stdio.patch` first, then the control-token patch; the order is
  pinned in `scripts/build-browser-vendor.mjs`. The stdio patch was cut for omb.1, so the build stamps its
  own vendor version (`0.36.0-omb.3` for Windows) over the patch's package version in `Cargo.toml` and
  `Cargo.lock`; the Windows executable therefore prints `agent-browser 0.36.0-omb.3`, which is what Murage's
  launch check requires. The vendor smoke runs that same comparison against the pinned asset version.
  Windows applies a third patch last, `patches/murage-windows-no-console.patch` (revision omb.3): the engine's
  daemon runs without a console, so each console-program child it starts (the browser, ffmpeg, aws, the engine
  itself) opened a console window; the patch passes `CREATE_NO_WINDOW` on those spawns. It modifies
  `cli/src/native/cdp/chrome.rs`, `cli/src/native/cdp/lightpanda.rs`, `cli/src/native/recording.rs`,
  `cli/src/native/providers.rs`, `cli/src/native/stream/dashboard.rs`, `cli/src/native/stream/chat.rs`,
  `cli/src/native/webdriver/appium.rs` and `cli/src/native/mod.rs`, and adds `cli/src/native/no_console.rs`.
  **Modification notice (Apache-2.0 section 4(b))**: the `murage-control-token` patch modifies
  `cli/src/connection.rs`, `cli/src/native/daemon.rs`, `cli/src/native/mod.rs`,
  `cli/src/native/stream/*.rs` and `cli/src/native/actions.rs`, adds `cli/src/native/control_token.rs`, and
  changes `cli/Cargo.toml`/`Cargo.lock` (dependency additions, locked). It makes the engine's local ports
  (the daemon's Windows TCP port and the stream port's `/api/status`, `/api/command` and WebSocket) require a
  per-launch secret from Murage, and bounds every daemon line and deadline. Each patched file carries its
  modification notice; the original Apache and axe notices remain unchanged. The vendor builds pin the
  source archive, every patch digest, Rust 1.97.1 and pnpm 11.1.3, build the real upstream dashboard, and
  publish an executable digest plus `provenance.json` per asset at
  <https://github.com/FerroxLabs/murage/releases> (tags `browser-engine-v0.36.0-omb.2`,
  `browser-engine-v0.36.0-omb.3` (Windows only), `browser-engine-v0.38.1-omb.2`). Vendor bytes are unsigned; Murage packaging verifies the pinned SHA-256
  and then applies Ferrox Labs' Developer ID signature and notarization on macOS. Pin gate:
  `scripts/build-browser-vendor.mjs` refuses to build unless this notice is present.
- **Windows exception: agent-browser 0.36.0-omb.1** is an OpenMausBot vendor
  build, not an official or unmodified Vercel executable. It starts from exact
  v0.36.0 commit `eb05921bad874cd2a1b4fa5d1149f1ed26576cae` and carries only
  the Windows handle-inheritance fix contributed by `holny` in upstream
  [PR1781](https://github.com/vercel-labs/agent-browser/pull/1781), commit
  `81a98c349d04195396ffae6898bd375ad64280de`. The separate MCP output-reader
  rewrite is deliberately excluded. `agent-browser-windows-stdio.patch`
  includes the exact changes and modification notices, plus package-version
  metadata; dependency versions remain locked. The original Apache and axe
  notices remain unchanged. `scripts/build-windows-browser-vendor.mjs` pins
  the source archive, patch, Rust 1.97.1, pnpm 11.1.3 and Windows GNU target,
  builds the real upstream dashboard, and emits executable and build-input
  digests in `provenance.json`. Native Windows cold-start and close/reopen
  checks are required before those executable bytes are published and pinned.
- **Chromium Headless Shell 152.0.7977.82**, Google's official
  `chrome-headless-shell` assets published through Chrome for Testing:
  <https://googlechromelabs.github.io/chrome-for-testing/152.0.7977.82.json>.
  The complete archive tree is retained, including `ABOUT` and
  `LICENSE.headless_shell`. The latter includes the Chromium BSD notice
  (including its binary-redistribution conditions) and the complete
  target-specific third-party license texts generated by Chromium's build.
  Source and license-generation rule:
  <https://github.com/chromium/chromium/blob/152.0.7977.82/headless/BUILD.gn>.

The bundled browser is the headless automation build, **not the full Google
Chrome distribution**. In particular, it does not bundle the proprietary
Widevine content-decryption module. The Apache-2.0 license in the
Chrome-for-Testing dashboard repository does not license Chrome executables;
we do not use it as the browser's license. Upstream's ABOUT notice and its
Chrome terms reference are retained without modification:
<https://www.google.com/chrome/terms/>.

All four archive sizes and SHA-256 digests were calculated from the vendor
downloads on 2026-09-07 and pinned in `server/browser-bundle-release.ts`.
Engine asset pins are reused from `server/browser-engine-release.ts`.
Preparation checks the exact archive bytes on every run, including cached
downloads, then records a complete file/symlink inventory. Missing, modified,
or incomplete staged resources fail the pre-signing package check.

Archives and extracted binaries are generated build output, not git content.
Set `OMB_BROWSER_ARCHIVE_DIR` to a directory of reviewed vendor assets for an
offline build; cached bytes are still verified. Browser dependencies are
updated through reviewed OpenMausBot releases, not a silent browser updater.

On macOS, release signing applies OpenMausBot's Developer ID to native
executables and libraries after validating the upstream bytes. The original
notices remain intact. Packaged browser profiles, cookies and downloads are
never included here; those belong in the user's isolated bot data directory.

Google, Chromium and Vercel are their owners' names; their inclusion does not
imply endorsement of OpenMausBot. This provenance record is not legal advice
or a replacement for the included upstream licenses.
