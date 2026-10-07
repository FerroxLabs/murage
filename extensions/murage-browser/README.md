# Murage for Chrome

Development MV3 extension. Use `pnpm build:browser-extension` from the app root for a stable development ID, an unpacked artifact at `dist-native/browser-extension/extension`, and bundled helper resources. The lower-level `node scripts/build-browser-extension.mjs` only produces `dist-browser-extension/` and is not the complete native-integration preparation path. Native host name: `com.murage.browser`. Registration and authenticated broker transport belong to Murage's desktop integration, not this build script.

The worker uses explicit binding/tab ownership, local document epochs, approved HTTP(S) origins and a trusted internal CDP channel. Group membership never grants access. Local Stop and Pause persist generation fencing before acknowledgement and detach debugger control. Owner Resume requires the broker to reconcile the new generation. Restart discards tab IDs and pauses bindings; stopped bindings remain stopped. Reconnection never replays a command. Private navigation during Pause/Stop is not forwarded. Unexpected trusted page input automatically pauses control. Exact correlation with one automation event has an unavoidable identical-input collision limit; explicit Pause remains necessary before private input. The isolated reload checks passed; actual native backend/browser restarts and physical macOS/Brave sleep/wake have separate passing receipts in the programme record. These do not prove signed installed-app lifecycle or store readiness.

The side panel can share the active ordinary tab, unshare, Pause, Resume and Stop. It cannot approve a new site or a consequential action; those decisions remain in Murage. Page-internal and credential/payment destinations are handed to the user. Browser indicators include a labelled tab group, badge and the browser's debugger indicator. Browser-native indicator behavior still requires branded qualification.

Focused checks:

- `pnpm exec vitest run scripts/browser-extension-runtime.test.mjs`
- `node scripts/build-browser-extension.mjs`
- `node scripts/prove-browser-extension.mjs`

The last command requires externally isolated HOME/USERPROFILE/TMP/companion paths and the exact pinned engine path, then creates a fresh Chromium profile under that task scratch, loads the real extension APIs, and injects a **test-only transport** into a separate bundled worker. It exercises real `chrome.debugger`, the semantic executor, and the side panel, writes receipts/screenshots, then deletes its profile. It does not register a production native host or touch real browser profiles. This proof is not evidence for real native messaging, branded Chrome/Edge/Brave, Windows or a packaged installer. Lighthouse does not assess this extension-origin surface; axe, real viewport screenshots and keyboard Stop are recorded instead.
