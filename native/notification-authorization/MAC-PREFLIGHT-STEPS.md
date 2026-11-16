<!-- Copyright 2026 Ferrox Labs -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

Insert this step after the existing two-architecture build in
`.github/workflows/mac-notification-authorization-preflight.yml` and its matching
preflight job in `.github/workflows/package-mac-qualification.yml`, replacing the
existing export-load step. Those jobs already create and upload
`$RUNNER_TEMP/notification-auth-evidence`. Keep both build receipts in that upload.
This step loads the arm64 binary in plain Node on the macos-15 arm64 runner. It
does not call any addon function.

```yaml
      - name: Load notification addon and record all six exports
        shell: bash
        run: |
          node --input-type=commonjs - <<'NODE'
          const assert = require('node:assert/strict');
          const fs = require('node:fs');
          assert.equal(process.platform, 'darwin');
          assert.equal(process.arch, 'arm64');
          const binding = require('./dist-native/notification-authorization/arm64/notification-authorization.node');
          const expected = ['status', 'request', 'registerCategories', 'post', 'remove', 'onResponse'];
          const exports = Object.getOwnPropertyNames(binding).sort();
          for (const name of expected) assert.equal(typeof binding[name], 'function', name);
          assert.deepEqual(exports, [...expected].sort());
          const build = JSON.parse(fs.readFileSync('./dist-native/notification-authorization/arm64/build.json', 'utf8'));
          fs.writeFileSync(process.env.RUNNER_TEMP + '/notification-auth-evidence/export-load.json', JSON.stringify({
            loaded: true, node: process.version, arch: process.arch, exports,
            sourceSha256: build.sourceSha256, sha256: build.sha256,
            statusExport: true, requestExport: true,
            addonMethodsCalled: false, authorizationMethodsCalled: false, osPermissionRequested: false
          }, null, 2) + '\n');
          NODE
```

Read the CI result against `source-sha.txt`, both `build.json` receipts, and
`export-load.json`. The input digest order is `authorization.mm`, `banners.mm`,
then `lifetime.h`. Compile both arm64 and x86_64 with the macOS 12.0 minimum and
N-API 9. Loading proves symbol registration only. Category merging, delegate
forwarding and replacement, immediate withdrawal, callback replacement and
unsubscribe, silent posts, retirement, and Allow/Reply authentication still need
an isolated signed `com.murage.app` fixture on macOS 14, 15, and 26, in banner and
alert styles. Do not use the owner's app or data.

UserNotifications APIs added by this slice:

- `UNUserNotificationCenter.currentNotificationCenter`, `delegate`,
  `getNotificationCategoriesWithCompletionHandler:`, `setNotificationCategories:`,
  `addNotificationRequest:withCompletionHandler:`,
  `removeDeliveredNotificationsWithIdentifiers:`, and
  `removePendingNotificationRequestsWithIdentifiers:`.
- `UNUserNotificationCenterDelegate` callbacks
  `userNotificationCenter:willPresentNotification:withCompletionHandler:` and
  `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:`.
- `UNNotificationAction.actionWithIdentifier:title:options:`,
  `UNTextInputNotificationAction.actionWithIdentifier:title:options:textInputButtonTitle:textInputPlaceholder:`,
  and `UNNotificationCategory.categoryWithIdentifier:actions:intentIdentifiers:options:`;
  category `identifier`, action options `None` and `AuthenticationRequired`, and
  category option `None`.
- `UNMutableNotificationContent` with `title`, `body`, `categoryIdentifier`, and
  `sound`; `UNNotificationSound.defaultSound`;
  `UNNotificationRequest.requestWithIdentifier:content:trigger:` and `identifier`.
- `UNNotification.request`, `UNNotificationResponse.notification` and
  `actionIdentifier`, `UNTextInputNotificationResponse.userText`,
  `UNNotificationDefaultActionIdentifier`, and `UNNotificationDismissActionIdentifier`.
- `UNNotificationPresentationOptionNone`, `Sound`, and `Alert`;
  `Banner` and `List` are guarded with `@available(macOS 11.0, *)`, with `Alert`
  as the older fallback. `Alert` is deprecated on macOS 11 and later.

These UserNotifications APIs are available by macOS 10.14 except `Banner` and
`List` (macOS 11). All are within the macOS 12 minimum target. Existing
authorization APIs and their result shape remain unchanged.
