# Draft store assets

Prepared, visually reviewed and not submitted. The screenshots render the unchanged extension panel source with synthetic Preview bot/example.com state. They are presentation assets, not native-control proof. They do not contain personal accounts, credentials or browser profile identifiers. The visible viewport is1280x800; the real panel remains scrollable.

- `01-browser-controls-1280x800.png`: active controls and explicit tab sharing.
- `02-paused-1280x800.png`: paused controls and explicit Resume.
- `promo-440x280.png`: existing Murage icon and wordmark.
- `icon128.png`: byte-identical existing extension icon.
- `receipt.json`: source and image hashes, dimensions and draft status.
- `render.mjs`: reproducible local capture using existing Playwright installation. Run only with isolated HOME/USERPROFILE/CFFIXED_USER_HOME/TMPDIR and an existing read-only test-browser cache. It neither connects to Murage nor submits anything.

Dimensions follow [Chrome Web Store image guidance](https://developer.chrome.com/docs/webstore/images). No claim of store approval. The approved listing name is Murage for Chrome. Owner still supplies production IDs, privacy/support URLs and truthful retention/data-use answers before submission; none are invented here. Replace preview-labelled presentation data with owner-approved listing captures when preparing publication.

## Store screenshot list for 1.0.0

Replace the two synthetic drafts above with real captures from the release build (T51), 1280x800 PNG, taken in a fresh test profile on the T15 fixture site, with no personal account or address visible. The overlay and side panel use the variant Sean picks from T30A (recorded in `lanes/chromeplan/PLAN.md`); until that pick is recorded no shot of those surfaces is final. Captions state what is shown and make no claim about platforms that are not proved. Each caption maps to a row of the claims matrix in `../STORE-SUBMISSION.md` (section 7); a caption whose row is not PROVED in the final pass is dropped with its shot.

| # | Shot | Caption (plain claims that match the code) |
| --- | --- | --- |
| 1 | The page while a bot drives: Murage page cue, bot pointer with its name, the working bar with Pause and Stop, the tab group named Murage | Work in your own browser, and see when a bot is driving. (C21, C22, C23) |
| 2 | The site card in a Murage chat: "wants to use <site>" with Allow for this task and Not now | You choose the sites. Reading is open; clicking and typing ask once per task. (C05, C06) |
| 3 | An L3 card in Murage, for example "Send this message?" with Send and Deny | Sending, posting, deleting and buying ask each time. (C07) |
| 4 | The Your turn card and the side panel line, on a fixture terms page | Terms, verification and passwords stay yours. The bot waits for you. (C10, C11; add "and carries on after Continue" only if C12 is proved) |
| 5 | Side panel: shared tab, current task and approvals with Revoke, the activity list, Pause and Stop | Pause, Stop and a record of what the bot did. Stop ends the task; start a new one any time. (C24, C25, C29) |

Optional: Full permissive warning dialog in the Murage app (danger zone), if the designer wants to show that the setting is deliberate. Promo tile 440x280 and icon 128 stay as above. The marquee tile 1400x560 is not prepared.

No shot shows a download, an Incognito window, the action check running on Flux, or a platform other than Mac with Chrome until the matching row (C09, C30, C19) is PROVED. The two synthetic drafts above are replaced, not reused.
