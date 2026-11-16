# Browser S3, round 3

Container evidence lives outside the repository at
`/work/build/s3/evidence3`. Each HTTP suite launches its own
`launchVerificationServer`, logs its URL, PID, private data directory and log
path, and closes the exact child it launched. Native Chrome and extension
connections in these suites are explicit fixtures. These tests do not prove
packaged Chrome, Electron, or OS prompts.

The deterministic race tables supplement the existing seeded schedules:

| Contract | Table |
| --- | --- |
| T6 | Before lifecycle admission, before the session gate, after the final synchronous probe, during release, after commit; each with builtin and extension destinations. A separate async context represents a separate owner request. |
| T12 / T17 close exclusion | Forget, restart, reopen; before, during close, after; against refresh, dispatch, tools/list, take, release, navigate, restart, reopen, registration, forget. |
| T12 remaining teardown waits | Pending dispatch drain and phase 2 gate acquisition; against each of those ten competitors. |
| T17 trailing steps | Reopen and restart; identity read and refresh, plus reopen's blank-page command; against release, take, registration, R. Restart has no blank-page command. |
| T18 | Changed spec, capacity, save, proxy publication, binding publication, final publication; prior entry absent/present; successor absent/published while failed-attempt disposal waits outside the gate. |
| T21 | Held before endpoint change; take after withdrawal with neither/proxy/binding/both successor slots occupied; restored held entry after app restart. All use HTTP status and Hand back. |

Chrome's running-process evidence and its listening endpoint are separate
observations. A failed process query stays unknown. An endpoint change drops
the previous Allow evidence. Admission starts the shared connection outside
any trailing wait and records pending Allow before offering browser tools.
Admission rechecks the published proxy after binding, so a Chrome restart
during preparation cannot reuse the previous Allow state.
The existing proxy tests enforce owned-tab scope; an empty owned-tab set
before the bot opens its first tab is not a scope failure.

The accepted setup card records its expected committed revision. After the
lifecycle gate releases, a pending acceptance enables tools once. Continue
then consumes the durable continuation before dispatch. The HTTP table covers
direct and extension selections, duplicate Continue requests and repeated
Continue after completion. The extension row checks the resumed engine's
browser-tool configuration.

Copy uses the catalog, including `browser.handback`, `browser.yourchrome.ask`
and `browser.switchback`. Server fallbacks use the configured language;
disclosures carry catalog references for renderer localization, including
nested profile and account descriptions. Translation drafts and source hashes
are produced by `scripts/generate-locale.mjs`, scoped to the new English keys.
They are drafts. No review ledger or reviewer identity was fabricated.

MAIN still owns translation/copy review, independent release review, packaged
macOS/Windows/Linux browser gates, Electron renderer smoke and real
Allow/restart/tab-scope proof. Supplied S134 has no T24 or M42s–M46s contract;
none is invented here. The EP-referenced FIX-LEDGER and S1 DONE were absent at
continuation start. The project memory tool and directory were unavailable.
