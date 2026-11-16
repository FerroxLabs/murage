# Update notice system notification, 1.0.18

A ready update means the updater has verified the download and reports
`downloaded`. When the desktop window is hidden or unfocused, send one system
notification for that version. The words name the good news: “Murage X is ready
to install”. The renderer supplies those words from the catalog in its current
language. There is no setting and no purchase link.

The code at this base uses UpdateBanner's non-focusing pop-up, not an automatic
modal dialog. update-card.ts remembers closing a ready version in localStorage;
modal-window.ts puts the pop-up inside the top dialog without stealing focus.
Use that existing surface on focus, wake and notification click. Do not open the
centred card automatically: the pop-up leaves a running turn, typing and the
open dialog alone. Clicking the system notification restores, shows and focuses
the desktop window and requests that same pop-up. Never reopen a dismissed
version. Focus and wake resend current state so a window that missed an event
can catch up. Wake also requests one silent update check, with a five minute
cooldown; the coordinator already coalesces checks and protects active work.

Keep notification receipts and dismissals in update-notifications.json under
Electron userData, separate from chat data. Write the receipt atomically before
showing the notification. Keep all version receipts across restarts. Missing
file means first use. Corrupt, unreadable or unwritable storage suppresses system
notifications, leaving the in-app notice usable. A renderer report of the current
version must arrive before notifying, so an existing localStorage dismissal
wins even on the first launch after this change. Installed/current versions and
installing states never notify. A late authorization answer is rechecked.

macOS uses the existing native notification authorization bridge. Query first;
request once only when undetermined, with a persisted attempt record. Denial or
an unavailable bridge is silent. Windows already sets com.murage.app as the app
user model id before packaged startup. Windows and Linux use Electron's native
notification support and OS notification policy; they have no Electron permission
prompt. Unsupported notifications, denied permission and native errors are silent
on every OS. No OS is deferred. Real Mac and Windows delivery and permission UI
need packaged device checks; Linux unit fixtures cannot prove them.

The Settings update action depends on the desktop updater bridge; Cloud's
separate preload and the phone have none. Attach notification handling only to
the owned desktop updater window. Do not start the updater in MAS or Windows
Store builds, or development builds. Keep notification code in the main process;
the renderer adds only a small bridge adapter and catalog entries. Measure the
built first-paint payload against 670 KiB. Verify using fake native objects and
isolated worktree files only, without a provider or live application.
