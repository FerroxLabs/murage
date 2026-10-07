<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Murage for Chrome: privacy policy section

This is the section to add to the Murage privacy policy (the live page is `https://murage.ai/privacy-policy`). It is written for 1.0.0 and every statement matches the code at `b569630c` plus the lanes named below. The data inventory with a code line for each row is in `extensions/murage-browser/STORE-SUBMISSION.md` section 6. The site is edited by the website session, not from this repository. The Chrome Web Store reviewer compares this text with the dashboard's privacy answers, so publish it before submitting for review.

This text describes the 1.0.0 feature set. It assumes these are merged: T03, T25, C2 and PNL-2 (Your turn and Continue), T10, T20 and T21 (site choices per bot, task approvals, modes), T23 and DESK (action check, with the bot's own engine when Flux is not live), T30 (page cue), EXT0 and X1 (no Incognito). If any is cut, remove the matching sentences before publication. Downloads: there is no bot download flow in 1.0.0; downloads a bot starts are blocked.

Items marked `[needs owner confirmation]` cannot be settled from the code and must be confirmed before publication. Items marked `[ships with T..]` describe a task that must be merged in the same release.

---

## Murage for Chrome

**Last updated:** 2026-10-03

### Overview

Murage for Chrome is an optional browser extension. It lets the bots in your Murage desktop app work in browser tabs you choose. It talks only to the Murage app on the same computer. Ferrox Labs does not receive your browsing, your page content or your activity log from the extension. The extension has no analytics, no telemetry and no advertising.

### What the extension handles

Only for tabs you share with a bot:

- The address and title of each shared tab, and of tabs a bot opens from them.
- The name and site of a download that a page tries to start (the download is blocked), and the text of a JavaScript dialog the page opens, so the bot can tell you what happened.
- When a bot reads a page: its text, structure and screenshots. The values of password fields and other sensitive fields are withheld from the read, and screenshots draw opaque boxes over them. Anything else on the page can be part of what the bot reads, including personal details, account details, financial and payment details, messages and health information that appear in a tab you shared.
- That you typed, clicked, scrolled or touched a page a bot is using, so the bot can pause. The extension reports that it happened, never what you typed.

The extension has no tool to read your cookies or saved passwords, has no tool to fill a password, does not use your location, and does not look at tabs you have not shared. Moving a tab into the Murage tab group does not share it.

### Where it goes

1. **To the Murage app on your computer**, through Chrome's native messaging and a local helper that Murage registers when you choose Set up. The helper and the app authenticate to each other. No network port is opened.
2. **Into the bot's conversation**, once a bot has read a page. From there it goes to the AI model provider you chose in Murage, in the same way as anything else in that conversation. What that provider keeps is governed by the provider's terms.
3. **To the action check**, a second model that looks at a step that changes something before it runs. It receives your own words for the task (and your standing browser instructions, if you set any) and a description of the step: its kind, the site, the name of the control (marked as coming from the page), the destination address with only its query parameter names, and for a send up to 200 characters of the text. It never receives the bot's reasoning, your cookies, a screenshot, page text, or the value of a password or other sensitive field. The check runs on Flux, a Ferrox Labs service, when Flux is live, and otherwise on the bot's own engine. You can choose in Murage. If neither is available, the bot asks you at every step. `[needs owner confirmation: Flux request retention and logging wording]`
4. **For the optional second look at page text** that may be addressing the bot, a short piece of that text goes the same way as in item 3. `[ships with T26 stage B]`

Nothing is sold, and nothing is used for advertising or for any purpose unrelated to running your bots. Data is not used to decide creditworthiness or lending.

### What is stored, and where

| Where | What | How long | Backed up |
| --- | --- | --- | --- |
| The extension's storage in your browser (`chrome.storage.local`) | Browser profile identity, which tabs are shared with which bot, your site choices, Pause and Stop state | Until you remove the extension | Not by Murage |
| `DATA_DIR/browser-extension/state.json` on your computer (the Murage data folder) | Shared tabs, site choices and Stop state for the connected browser | Until you remove the connection or the bot | Never backed up |
| `DATA_DIR/browser-extension/sites.json` | The sites you have allowed for each bot, and the ones you blocked | Until you change or revoke them | Never backed up |
| `DATA_DIR/browser-extension/activity/` | One log per connection, one line per browser action: when, site, kind of action, the control's name, level, who decided and the outcome. Lines are capped at 512 bytes. For typing, only the number of characters is kept, never the text, and never a field value. | 30 days, and at most 2,000 lines per log, oldest removed first | Never backed up |
| `DATA_DIR/browser-extension/` other files | Paired external client records and the helper launcher registration | Until you remove them | Never backed up |

The whole `browser-extension` folder is left out of every Murage backup, and a restore refuses it. After a restore you share tabs and connect the browser again.

Anything a bot reads becomes part of that bot's conversation in Murage, and stays on your computer until you delete the conversation.

### What it never does

- Accept terms, privacy policies or cookie choices for you, prove you are human, or enter your passwords, one-time codes, or card and ID details. The bot stops and shows a "Your turn" card, and waits until you press Continue. No setting lifts this.
- Act on a site before you allow it, or on a banking, payment, health or government site without asking at every step.
- Use a tab you have not shared, or one bot using another bot's tabs.
- Send or post anything on your behalf without your approval, unless you turned on Full permissive for that bot. Full permissive is off by default, is turned on only in the Murage app on your computer behind a typed confirmation, and even then a send or delete goes ahead only when the intent check and the action check both allow it.
- Download files on a bot's behalf. Downloads a bot starts are blocked.
- Run in Incognito windows. `[ships with EXT0 and X1]`

### Your controls

- Pause or Stop at any time from the page, the side panel, the Murage app or your phone. Stop ends the task and takes effect in your browser even if Murage is closed. Start a new task any time.
- Allow, ask or block each site, per bot. Revoke a task's approvals at any time.
- See what each bot did in the activity log in Murage, and delete it by removing the connection or the bot.
- Remove the helper in Murage (the bot's Browser panel), then remove the extension at `chrome://extensions`. Removing the extension removes its browser storage.

### Limits you should know about

- Chrome shows its own "started debugging this browser" bar while a bot drives a tab. The extension does not hide it.
- Pressing Cancel on that bar pauses the bot.
- A website can tell that the Murage page cue is on the page.
- The bot cannot see or act inside a web component whose shadow root is closed. Murage refuses to act there and covers such areas in screenshots `[ships with T30]`.
- Stop cannot undo something a website has already accepted.

### Contact

Questions about privacy: `https://murage.ai/contact`.
