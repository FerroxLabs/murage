<!-- Copyright 2026 Ferrox Labs -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

Insert these steps after the existing source admission and notification addon steps,
before artifact upload in `.github/workflows/mac-notification-authorization-preflight.yml`.
The existing job pins macos-15, arm64 Node 24.20.0, and admits `inputs.source_sha`
against both `GITHUB_SHA` and the checkout. Keep those gates.

```yaml
      - name: Verify presence guard build and source contracts
        run: node --test scripts/build-presence-guard.node-test.mjs electron/presence-guard-native-contract.node-test.mjs
      - name: Compile and verify both presence guard architectures
        run: |
          set -euo pipefail
          node scripts/build-presence-guard.mjs
          lipo dist-native/presence-guard/darwin-arm64/presence-guard.node -verify_arch arm64
          lipo dist-native/presence-guard/darwin-x64/presence-guard.node -verify_arch x86_64
      - name: EVIDENCE - load arm64 presence guard in plain Node
        env:
          EXPECTED_SHA: ${{ inputs.source_sha }}
        run: |
          set -euo pipefail
          test "$(node -p process.arch)" = arm64
          node scripts/presence-guard-evidence.mjs dist-native/presence-guard/darwin-arm64/presence-guard.node dist-native/presence-guard/darwin-arm64/presence-evidence.json
```

Append these paths to the existing upload-artifact step's `with.path` block;
keep its pinned action and seven day retention:

```yaml
            dist-native/presence-guard/darwin-arm64/presence-guard.node
            dist-native/presence-guard/darwin-arm64/build.json
            dist-native/presence-guard/darwin-arm64/presence-evidence.json
            dist-native/presence-guard/darwin-x64/presence-guard.node
            dist-native/presence-guard/darwin-x64/build.json
```

The evidence records the boolean snapshot, export presence, read duration,
subscription replacement, repeated unsubscribe calls, and exit of a child Node
process with an active subscription. It does not prove detection during a share,
full screen, or Focus. S0 must observe those cases, all table rows, redacted menu
bar titles, actual event delivery, and read latency on the packaged application.

Integration seam: package the matching `dist-native/presence-guard/<platform>-<arch>/presence-guard.node`
as `presence-guard.node` in the application's resources directory, preserving the
existing `loadPresenceAddon({ resourcesPath, load, lstat, realpath })` checks.
The delivery builder calls the returned addon's synchronous `read()` and subscribes
with `onChange(() => refresh())` only while an event watcher is needed. Call its
returned unsubscribe function when watching ends or on disposal; a new subscription
replaces the previous one. This slice does not change that loader or delivery code.

macOS APIs use AppKit's `NSWorkspace` and `NSRunningApplication`, Foundation's
notification observers, and CoreGraphics display/window metadata. No window title
from another application is inspected. Only a Window Server window at a display's
top edge has its name compared to `Menubar`; an absent name leaves full screen
undetected. Focus is always false because this build has no Communication
Notifications entitlement. Sharing toolbar owners and layers remain unproven.

Windows APIs use `SHQueryUserNotificationState` from `shellapi.h`; display topology,
foreground hooks, message dispatch, and kernel events come through `windows.h`.
The hook is removed on its registering thread before unsubscribe finishes joining
that thread. The build reuses the x64 MSVC environment and refuses other Windows
architectures. API declarations, linkage, loadability, callback teardown, and
read latency still require the hosted SDK/compiler and S0 results.
