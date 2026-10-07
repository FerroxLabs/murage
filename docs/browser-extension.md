# Browser companion: development candidate

The browser companion is an optional desktop-local route for Murage to work in selected Chromium tabs. This candidate has no published store listing. Building its files does not install or connect a native host, and it does not establish supported Chrome, Edge, Brave, macOS, Windows, or Linux releases.

Murage remains usable without the companion. The extension route does not silently fall back to another browser or computer-control route when connection or permission checks fail. A browser on a different computer, a headless remote server controlling your laptop, and mobile extensions are outside this implementation.

## What you consent to

You choose the browser profile and explicitly share tabs. Tabs grouped together or dragged into a bot's group do not grant access by themselves. Remembered site access (Allow, Ask, Never) is separate from approval for an action. Write-capable actions require an owner decision; external MCP clients cannot approve themselves.

Page text, screenshots, and other observations requested by a bot can enter Murage's conversation and be sent to the configured model provider. Review the selected provider and Murage's transcript/data settings before sharing a tab. Extension storage contains control state, profile identity, grants, and tab metadata; it does not deliberately store page bodies or screenshots. This is not a claim that page data stays exclusively on your computer after a bot receives it.

Pause before entering private information. The extension pauses on unexpected trusted typing or clicks in a controlled page. An identical human action arriving during the corresponding automation event cannot always be distinguished; use the explicit Pause control before private input. Stop fences further work and detaches the debugger, but cannot undo an action already accepted by a website. Resume is an explicit owner action and rechecks the current document. A disconnected or uncertain action is never automatically replayed. Credential-manager and protected financial pages require human takeover; the protected-domain defaults are not an exhaustive list of every bank.

The extension provides side-panel controls and tab badges/groups. Browser debugger indicators and badge visibility require branded-browser verification; an unpinned toolbar icon is not a guaranteed visible indicator.

## Build an unpacked development artifact

From the repository root:

```sh
pnpm build:browser-extension
```

Output is `dist-native/browser-extension/extension`. The script generates a public RSA manifest key on first use and keeps it in `dist-native/browser-extension/development-public-key.json` so this local development build keeps its extension ID across rebuilds. It does not save the private key. Deleting that public-key file changes the development ID on the next build. The generated receipt contains the development ID; it is not a store ID.

For isolated manual qualification, load that output directory through the browser's developer-mode **Load unpacked** action in a dedicated test profile. This loads the extension only. **Connected** requires an actual native-host handshake with the running isolated Murage instance; it must not be inferred from successful loading or a build log. Real browser profile registration is not performed by these scripts.

## Prepare app resources

```sh
pnpm prepare:browser-extension
```

Without a release configuration, this stages resources-only output:

- `native-host.mjs`: bounded native messaging transport.
- `browser-extension-mcp.mjs`: bundled standalone external MCP entry point.
- `registration.mjs`: explicit-path registration helpers.
- `extension/`: unpacked extension with no development manifest key.
- `build.json`: artifact identity and qualification flags.

`package:prepare` invokes this step. `electron-builder.yml` maps the directory to `Resources/browser-extension` and excludes the development public-key file. The helpers bundle their imports; users do not need the source tree, pnpm, or a separate Node installation. The intended packaged launcher uses Murage's Electron executable with `ELECTRON_RUN_AS_NODE=1`. Running a helper under development Node proves bundling, not installed Electron execution, signing, or native-browser registration.

Release preparation requires an absolute configuration-file path supplied by the release owner:

```sh
node scripts/prepare-browser-extension.mjs --mode release --release-config /absolute/path/to/browser-release-config.json --out /absolute/path/to/release-browser-resources
```

The file contains `productionIds`, a nonempty array of exact 32-character extension IDs. An optional `publicKey` must derive an ID in that array. Empty IDs, wildcards, duplicate IDs, and mismatched public keys are rejected. No production ID or store URL is invented by this repository. `MURAGE_BROWSER_EXTENSION_RELEASE_CONFIG=/absolute/path/to/browser-release-config.json pnpm package:prepare` preserves that release identity through the standard packaging path. Without this environment variable, preparation uses resources-only output. Publication still requires owner identity, store review, and qualification.

## Native registration and qualification

`prepareRegistration` in `scripts/prepare-browser-extension.mjs` accepts explicit platform/browser/home, extension identity, Electron/helper paths, launcher path, and the active broker's `configPath`. It returns manifest/launcher text in memory. It never writes to a browser's registration directory or registry.

The Unix launcher sets Electron-as-Node and passes only the credential file's path. The credential itself remains in the owner-restricted file. Browser-to-host input and host output are capped at 1 MiB; stdout contains framed protocol messages only. The local broker and host mutually authenticate before forwarding requests.

The app integration rotates credentials behind an owned stable `native-host.json` alias. Clean shutdown/restart retains the launcher path. Crash recovery requires a matching private instance, lease provenance and a definitely dead endpoint; active, foreign, malformed or uncertain aliases are refused. Owner setup installs only verified owned registration files, and changed builds require explicit Remove/Connect repair. Installed update repair remains unqualified.

Unix registration helpers cover Chrome/Chromium, Edge, and Brave on macOS/Linux and preserve conflicting entries. On Windows, the helper was compiled with existing MSVC tools and exercised in isolated native ACL, framing, HMAC, launcher and registration fixtures. Real Chrome 153.0.8010.53, Edge 153.0.4234.48 and Brave 1.96.59 connected through the native helper using Electron 43.4.0 as Node, then passed local navigation, snapshot, screenshot and Stop checks. Brave uses the Chromium native-host registry family. These were fresh test profiles and unique host names, not signed-installer or personal-profile tests. On macOS, Chrome, Edge and Brave each passed seven native checks using an approved temporary internal launcher fixture. Brave uses Chrome's native-host registration directory on macOS; Murage shares ownership records and removal across those two browser choices. The fixture verified Foundation home isolation before registration. Windows broker recovery passed six checks in its final run; an earlier zero-winner contention result was not reproduced and has no proven root cause. See `native/browser-extension/README.md` and the programme receipts.

Removal must target the exact owned registration. macOS dragging the app to Trash has no guaranteed uninstall callback; explicit removal is required. Never remove another application's host manifest.

## External MCP

External browser clients are disabled by default and need their own paired, revocable credential while Murage is running. The packaged entry point is `Resources/browser-extension/browser-extension-mcp.mjs`. Its launcher uses `ELECTRON_RUN_AS_NODE=1` and `MURAGE_BROWSER_MCP_CONFIG` pointing to an owner-restricted file containing the paired endpoint/client credential. Use the owner-generated configuration; do not put Murage's master token into a snippet or command argument. The external route uses the same binding, site, action-approval, and Stop policies.

## Known qualification limits

Connection-scoped ordered request IDs now reject old or malformed sequences without the former 4,096-entry runtime limit. An isolated real-extension check passed 5,000 further requests, early replay refusal, and Stop preservation across a fresh connection. The broker retains a separate 100,000 application-ID session bound. The current engine adapter passed all 21 fixed compatibility scenarios and the scoped tab lifecycle. The isolated extension run passed all 17 checks, including reload recovery with paused state, cleared authority, advanced generation, stale-request refusal and release of the private-input guard. Diagnostic instrumentation changed; no product correction or exact cause for the earlier fixture failures is claimed.

A focused actual browser and native-backend process restart run passed seven assertions: persisted Stop, advanced generations, stale-command refusal, cleared restored tab authority and no replay of the controlled pending action. The worker started before opening its panel. A physical macOS sleep/wake run with Brave passed six checks after 592.75 seconds asleep: Stop persisted, owned document identity stayed intact, stale references were refused, no controlled action replay occurred, and scoped access worked after wake. This does not establish Windows sleep, hibernation, battery exhaustion or full installed-app lifecycle behavior.

Source tests, temporary registration tests, bundled helper startup, and isolated socket tests are distinct from actual extension control and installed-platform proof. Review the programme execution record for current runtime, visual, complete-suite, macOS/Windows branded-browser, phone-approval, and installed-launcher receipts. These docs do not mark those gates complete. Store submission, signing, publication, and a supported release remain pending.
