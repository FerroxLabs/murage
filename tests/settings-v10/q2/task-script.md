# Settings v10 Q2: task script (prepared by accept; the 5-person run is OPEN, owner MAIN/Sean seats the people)

Owners: accept owns this script and its check; MAIN/Sean own seating five people and running it. 45 tasks: 42 have a route in Settings, 3 (N5, N6, N11) end in an honest answer that says Murage does not have the feature yet.

Run rule: read the task aloud, start from the closed Settings gear, record clicks and hesitation. A task passes when the person reaches the "Route" without help within the stated clicks. For N5, N6 and N11 the pass is the honest answer card (never an empty page, never a fake control) and its one link.

| Task | What the person is asked to do | Route (design: v5 path) | Clicks | Expected result |
|---|---|---|---|---|
| 1 | First open | gear; one question, FluxRouter explained | 1 | Pass. Hesitation: 17 rail rows sit beside the one question |
| 2 | Add an API key | gear, Providers, paste | 2 | Clean |
| 3 | Use my Claude plan | gear, Providers, the plan row | 2 | Pass. Hesitation: moving bots onto it is a second trip, to Models |
| 4 | Pair my phone | gear, Phone & remote access, Add a device | 2 +C | Pass. Hesitation: Tailscale is set up outside Murage; the Wi-Fi risk is now stated |
| 5 | Get help | gear, About & help | 2 | Clean |
| 6 | Theme on this device | gear, General | 2 | Clean |
| 7 | Why can't a bot send email | bot gear, What it can reach, Fix | 2, then Fix | Clean |
| 8 | Gmail for only 2 bots | gear, Connected apps, Gmail; tick the rest, No access, Apply | 3 | Pass. Hesitation: an Every app bot and a No limits bot are stated exceptions the owner must read |
| 9 | Web search off for one bot | bot gear, Tools | 2 | Clean for Dax; a Fuigo bot's row says the engine may still search |
| 10 | Stop bots reading web pages | gear, Tools | 2 | Pass. Hesitation: it is several switches, and some engines read by themselves |
| 11 | Remove a lost phone | gear, Phone & remote access, the device, Remove | 3 +C | Clean |
| 12 | Rename a device | the same sheet | 3 | Clean |
| 13 | Change a bot's voice | bot gear, Voice & notifications | 2 | Clean |
| 14 | See spend, set a cap | gear, Usage & spend | 2 | Clean |
| 15 | Approval level for new bots | gear, Bots | 2 | Clean |
| 16 | Who answers Telegram | gear, Messaging | 2 | Clean |
| 17 | Restore a backup | gear, Backups & storage, Restore, Restart into Backup mode | 3 +C | Pass. Hesitation: it finishes on a separate screen and needs the recovery key |
| 18 | Find "MCP" | search; or Connected apps > Custom tools | 2 | Pass. Hesitation: the word is not in the rail |
| 19 | Undo a change | Change back on the Saved line; or gear, Set back | 0 to 2 | Clean |
| 20 | Move a bot to another engine | bot gear, Engine & model | 2 | Clean |
| 21 | See what a bot can reach | bot gear, What it can reach | 2 | Clean |
| 22 | Export my data | gear, Backups & storage, Export a backup file | 3 | Pass. Hesitation: it is an encrypted backup, not readable data; the sheet says so |
| 23 | Remove a key that stopped working | gear, Providers, the key | 3 +C | Clean |
| 24 | Stop one bot asking | bot gear, Approvals | 2 | Clean |
| 25 | Model on five closed bots | gear, Models; tick five, Apply | 2 | Clean |
| 26 | Which bots run on Codex | gear, Models, Codex | 2 | Clean |
| 27 | Images off for 10 bots | gear, Tools, Images; tick ten, Turn off | 3 | Clean |
| 28 | Start fresh, archived bot, Simple | Bot settings, Go to a page, Memory & learning | 3 +C | Clean |
| 29 | No calls today, from the phone | Settings, Phone & remote access, Calls today | 2 | Clean |
| 30 | A bot's model from the phone | bot gear, Engine & model | 2 | Pass. Hesitation: the phone changes one chat; the bot's default is set on the computer, and the screen says so |
| N1 | Why a routine did not run | bot gear, Routines | 2 | Clean |
| N2 | Language for one bot | bot gear, Profile, Replies in | 2 | Clean (new field) |
| N3 | See and forget one memory | bot gear, Memory & learning, What Dax remembers | 3 +C | Clean |
| N4 | Sounds off at night | gear, General, Quiet hours | 3 | Pass. Hesitation: the builder must confirm quiet hours silence the sound; the copy claims only that notifications stop |
| N5 | Move to Cloud | search | 2 | **Not in the product.** Honest answer with the by-hand path |
| N6 | Share a bot with a teammate | search | 2 | **Not in the product.** Honest answer |
| N7 | Version, updates | gear, About & help | 2 | Clean |
| N8 | Remove an app everywhere | gear, Connected apps, the app, Remove | 3 +C | Clean |
| N9 | Another model for images | gear, Tools, Images | 3 | Clean |
| N10 | What costs most | gear, Usage & spend | 2 | Clean |
| N11 | Lock Settings | search | 2 | **Not in the product.** Honest answer |
| N12 | Recover from a bad change | gear, Changed recently | 1 to 2 | Clean |
| N13 | Keyboard shortcuts | gear, About & help | 2 | Clean |
| N14 | Report a bug | gear, About & help | 2 | Clean |
| N15 | Which device was used last | gear, Phone & remote access | 2 | Clean |

## The three honest-answer endings

| Task | Typed | Answer card must say | Link | Link goes to |
|---|---|---|---|---|
| N5 | move to cloud | Murage has no move-to-Cloud button yet. To move by hand: export a backup file here, with your recovery key. Whether Murage Cloud can restore that file is not confirmed yet, so ask in About & help before you rely on it. | Open Backups & storage | `backups.html#backups.export` |
| N6 | share with a teammate | Murage has no accounts for other people yet. A person can talk to a bot through a messaging app you pair. Teams in Murage are groups of bots. | Open Messaging | `messaging.html#messaging.apps` |
| N11 | lock | Murage has no lock of its own yet. Use your computer's own lock and a separate user account on a shared computer. | Open Guides | `about.html#about.help` |
