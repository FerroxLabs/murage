# Checking Chrome for a desktop window

S4 supplies the resolver; S2 owns the window controls and launcher. The shipped
qualification lists are empty and CfT pins are null on every platform. Keep them
that way until the exact-version S2 real-machine rows pass.

The desktop maintainer entry point never launches Chrome or starts the server:

```sh
murage-server --window-chrome-check
murage-server --window-chrome-check --prepare
murage-server --window-chrome-check --prepare --validated /private/test-list.json
murage-server --window-chrome-check --download --validated /private/test-list.json
```

For a source fixture use `node --experimental-strip-types server/index.ts` in
place of `murage-server`. Always set `MURAGE_DATA_DIR` to an isolated fixture
folder. A qualification file applies only to this invocation. It does not alter
the release lists or a running app. `--download` is the explicit download action;
status checks do not fetch CfT. The command prints one `{ok}` or `{cause, detail}`
JSON result. Cloud home returns `cloud_home` before reading a test list.

A test qualification file must supply all three platform entries:

```json
{
  "darwin": {"installedVersions": [], "cft": null},
  "win32": {"installedVersions": [], "cft": null},
  "linux": {"installedVersions": [], "cft": null}
}
```

Use exact four-part versions. A CfT entry needs `version` and `sha256`, keyed by
`mac-arm64`, `mac-x64`, `win64` or `win32` as appropriate. Linux never has a CfT
entry. Pins come from separately qualified release artifacts, not a live
“latest version” endpoint.

S2 calls `resolveWindowChrome({mode: "prepare"})` outside its session gate and
`resolveWindowChrome({mode: "local"})` inside it immediately before launch.
Local checks never invoke platform trust, child processes or networking. A
missing/changed record returns a cause; the owner action prepares it outside the
gate. Only an owner download action calls `downloadChromeForTesting` with
`ownerRequested: true` and an `onProgress` callback. Callers must preserve every
cause, never substitute another binary, and never disable Chrome's sandbox.

Keep the resolver's executable string for launch. It names the realpath bound
to the recorded whole-tree identity. Do not resolve an alternate path after the
check. Linux additionally compares Google-authenticated package digests and
modes, rehashes chrome and chrome-sandbox at launch, and checks all other file
identities. The first check for each installed version downloads a package;
subsequent local checks use private evidence under `browser-window`.

Before enabling a platform, record CV-INSTALLED, CV-CFT, CV-LNX-PROVENANCE,
CV-LNX-RPM and CV-UPDATE-GATE wherever the agreed S134 table assigns them. These
are real-machine proofs; fixture tests cannot establish OS trust, notarization,
AppContainer access, package provenance against the current repository or an
actual sandboxed window. Include the “window Chrome versions” row in each
release's engine-version check: the full current Stable version and the full
version on each gate machine, plus any CfT zip hashes. S2's window rows must pass
for each version before it enters `WINDOW_CHROME_VALIDATED`.

On Linux, a changed database or installed manifest discards the stale private
evidence as well as the in-memory admission. The next prepare rebuilds the
signed package chain in the same call. An unchanged disk record after a process
restart can still be prepared offline.

Windows preparation checks the 64-bit HKLM policy key with the registry API.
Only its explicit absent-key result permits unmanaged preparation; access,
tool, or malformed-output failures return `unverified`. The subprocess fixtures
exercise stdout/stderr and exit handling; the native C extraction fixture uses
Windows API doubles. Neither replaces real Windows qualification.
